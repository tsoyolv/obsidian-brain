import { llmProviderFactory } from "@/lib/providers/llm";
import type { ChatUsage, LLMMessage } from "@/lib/providers/llm/types";
import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { compactLocalStamp, newId, nowIso } from "@/lib/utils/id";
import { ensureMarkdownExt } from "@/lib/utils/filenames";
import { createLogger } from "@/lib/utils/logger";
import { estimateTokensForMessages } from "@/lib/utils/tokens";
import type { ChatMessage, ChatSession, NoteFrontmatter } from "@/lib/types";
import type { ParsedNote } from "@/lib/services/vault";
import { getChatSessionStore } from "./sessionStore";
import {
  parseTranscriptMarkdown,
  renderChatMessageMarkdown,
  stripMdExt,
} from "./transcripts";

const log = createLogger("chatService");

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant integrated with the user's Obsidian vault. " +
  "Be concise, accurate, and structured. When useful, suggest action items the user can save.";

/**
 * Budget knobs for rolling-summary context management. The goal is to keep
 * the prompt input under ~100k tokens forever (GPT-4o / Sonnet comfortable
 * range) even on very long chats, without paying the linear cost of resending
 * the full transcript on every turn.
 *
 * How it works:
 *   1. Whenever the estimated prompt exceeds {@link COMPACT_TRIGGER_TOKENS},
 *      we fold everything older than the last {@link KEEP_TAIL_MESSAGES}
 *      turns into a rolling plain-prose summary via the LLM.
 *   2. The pinned first user message is always kept raw — it anchors the
 *      model to the original task wording and costs at most a few hundred
 *      tokens.
 *   3. Only the summary + pinned + tail are sent on subsequent turns.
 */
const TOKEN_HARD_LIMIT = 100_000;
const COMPACT_TRIGGER_TOKENS = 80_000;
const KEEP_TAIL_MESSAGES = 10;
/** Safety floor: don't attempt to compact when there's barely anything. */
const MIN_MESSAGES_TO_COMPACT = KEEP_TAIL_MESSAGES + 4;

const ROLLING_SUMMARY_SYSTEM_PROMPT =
  "You maintain a rolling summary of a long-running chat so later turns can " +
  "reuse earlier context without resending the full transcript. You will be " +
  "given the PREVIOUS SUMMARY (may be empty) and NEW TURNS since it was " +
  "written. Produce an UPDATED SUMMARY that preserves, verbatim where " +
  "possible: the user's stated goals and constraints, decisions the " +
  "assistant committed to, open questions, and concrete identifiers (file " +
  "paths, names, numbers, code symbols). Write plain prose, 1–4 short " +
  "paragraphs. No headings, no bullet lists, no preamble, no meta " +
  "commentary. Do not invent anything that isn't in the prior summary or " +
  "the new turns.";

export interface CreateSessionInput {
  title?: string;
  systemPrompt?: string;
}

export interface AppendMessageInput {
  sessionId: string;
  content: string;
}

export interface SummaryResult {
  summaryPath: string;
  summary: string;
  actionItems: string[];
}

export interface StreamEvent {
  delta: string;
  done: boolean;
  assistantMessageId: string;
  /**
   * Populated on the terminal (`done: true`) event with the session-wide
   * cumulative token counters after this turn. Absent on incremental frames
   * so consumers can keep appending `delta` without branching.
   */
  usage?: SessionTokenUsage;
}

export interface SessionTokenUsage {
  /** Real tokens reported by the provider for the most recent turn. */
  lastTurnTotalTokens?: number;
  lastTurnPromptTokens?: number;
  lastTurnCompletionTokens?: number;
  /**
   * Subset of `lastTurnPromptTokens` that the provider served from its
   * prompt cache. Higher = lower marginal cost on this turn.
   */
  lastTurnCachedTokens?: number;
  /** Cumulative total across every turn in this session. */
  sessionTotalTokens: number;
  /**
   * Estimated prompt size for the NEXT turn (system + summary + pinned +
   * raw tail), based on a heuristic — this is the "context window in use
   * right now" number you display next to the budget bar.
   */
  nextPromptEstimateTokens: number;
  /** Absolute ceiling used for budget/UI. */
  limitTokens: number;
}

export interface ChatService {
  ensureReady(): Promise<void>;
  createSession(input?: CreateSessionInput): Promise<ChatSession>;
  listSessions(): Promise<ChatSession[]>;
  getSession(id: string): Promise<ChatSession | undefined>;
  /**
   * Heuristic estimate of the prompt size that would be sent on the next
   * turn for this session (system + rolling summary + pinned + raw tail).
   * Cheap pure function — safe to call from list/GET endpoints.
   */
  estimateNextPromptTokens(session: ChatSession): number;
  /**
   * Streams the assistant response for a new user message.
   * Persists the user message before streaming and the assistant message
   * once streaming completes.
   */
  streamUserMessage(input: AppendMessageInput): AsyncIterable<StreamEvent>;
  summarize(sessionId: string): Promise<SummaryResult>;
}

class ChatServiceImpl implements ChatService {
  private readonly vault = getVaultService();
  private readonly store = getChatSessionStore();
  private folderReady = false;

  async ensureReady(): Promise<void> {
    if (!this.folderReady) {
      await this.vault.ensureFolders();
      this.folderReady = true;
    }
    if (!this.store.isHydrated()) {
      await this.hydrateAllFromVault();
      this.store.markHydrated();
    }
  }

  /**
   * Scan `AI Chats/` once per process and load every chat note into the
   * session store. The in-memory store is a hot cache — the vault transcript
   * is the durable source of truth, so a cold process (or an HMR reset that
   * outruns the globalThis cache) can rebuild the world from disk.
   */
  private async hydrateAllFromVault(): Promise<void> {
    const t = log.time("hydrateAllFromVault");
    let files: string[];
    try {
      files = await this.vault.listFiles(VAULT_FOLDERS.aiChats);
    } catch (err) {
      t.fail("hydrateAll: listFiles failed", { err: String(err) });
      return;
    }
    let loaded = 0;
    let skipped = 0;
    for (const rel of files) {
      try {
        const note = await this.vault.readNote(rel);
        const id = this.chatIdFromNote(note);
        if (!id) {
          skipped += 1;
          continue;
        }
        if (this.store.get(id)) {
          skipped += 1;
          continue;
        }
        const session = this.sessionFromNote(rel, note, id);
        this.store.put(session, DEFAULT_SYSTEM_PROMPT);
        loaded += 1;
      } catch (err) {
        skipped += 1;
        log.warn("hydrateAll: skipped bad chat note", {
          path: rel,
          err: String(err),
        });
      }
    }
    t.done("hydrateAllFromVault", { files: files.length, loaded, skipped });
  }

  /**
   * Restore a single session by id from disk on a cache miss. Returns
   * undefined when no chat note in `AI Chats/` carries that id.
   */
  private async hydrateSessionById(
    sessionId: string
  ): Promise<ChatSession | undefined> {
    await this.ensureReady();
    const cached = this.store.get(sessionId);
    if (cached) return cached;

    const files = await this.vault.listFiles(VAULT_FOLDERS.aiChats);
    for (const rel of files) {
      try {
        const note = await this.vault.readNote(rel);
        const id = this.chatIdFromNote(note);
        if (id !== sessionId) continue;
        const session = this.sessionFromNote(rel, note, id);
        this.store.put(session, DEFAULT_SYSTEM_PROMPT);
        return session;
      } catch (err) {
        log.warn("hydrateOne: skipped bad chat note", {
          path: rel,
          err: String(err),
        });
      }
    }
    return undefined;
  }

  private chatIdFromNote(note: ParsedNote): string | undefined {
    const data = note.data as Record<string, unknown>;
    if (data?.type !== "ai-chat") return undefined;
    const id = data?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }

  private sessionFromNote(
    relPath: string,
    note: ParsedNote,
    id: string
  ): ChatSession {
    const data = note.data as Record<string, unknown>;
    const parsed = parseTranscriptMarkdown(note.body);
    const title =
      typeof data.title === "string" && data.title.length > 0
        ? data.title
        : stripMdExt(relPath.split("/").pop() ?? relPath);
    const createdAt =
      (typeof data.created === "string" && data.created) ||
      parsed[0]?.createdAt ||
      nowIso();
    const updatedAt =
      (typeof data.updated === "string" && data.updated) ||
      parsed[parsed.length - 1]?.createdAt ||
      createdAt;

    const messages: ChatMessage[] = parsed.map((p) => ({
      id: newId("msg"),
      role: p.role,
      content: p.content,
      createdAt: p.createdAt || createdAt,
    }));

    const summary =
      typeof data.running_summary === "string" && data.running_summary.length > 0
        ? data.running_summary
        : undefined;
    const summaryUpToRaw = data.summary_up_to;
    const summaryUpTo =
      typeof summaryUpToRaw === "number" &&
      Number.isFinite(summaryUpToRaw) &&
      summaryUpToRaw > 0
        ? Math.min(summaryUpToRaw, messages.length)
        : undefined;
    const totalTokensRaw = data.total_tokens_used;
    const totalTokensUsed =
      typeof totalTokensRaw === "number" &&
      Number.isFinite(totalTokensRaw) &&
      totalTokensRaw > 0
        ? totalTokensRaw
        : undefined;

    return {
      id,
      title,
      createdAt,
      updatedAt,
      messages,
      transcriptPath: relPath,
      summary,
      summaryUpTo,
      totalTokensUsed,
    };
  }

  /**
   * Build the exact message array we hand to the LLM for the next turn.
   *
   * Layout (in order):
   *   1. system prompt (per-session, with rolling summary inlined as extra
   *      system context when present)
   *   2. pinned first user message, when it exists and falls inside the
   *      already-summarized window (so we don't duplicate it)
   *   3. the unsummarized tail of the conversation, verbatim
   *
   * This keeps the model anchored to the original task wording while cutting
   * out the long middle of the chat via summary.
   */
  private buildPromptMessages(
    session: ChatSession,
    baseSystemPrompt: string
  ): LLMMessage[] {
    const msgs = session.messages;
    const summaryUpTo = session.summaryUpTo ?? 0;

    let systemContent = baseSystemPrompt;
    if (session.summary && session.summary.trim().length > 0) {
      systemContent +=
        "\n\nEarlier in this conversation (rolling summary, plain prose, " +
        "not user-visible):\n" +
        session.summary.trim();
    }

    const out: LLMMessage[] = [{ role: "system", content: systemContent }];

    // Pin the original user task if it's inside the summarized head, so the
    // model always sees the exact wording of the first request.
    if (summaryUpTo > 0) {
      const firstUser = msgs.find((m) => m.role === "user");
      if (firstUser) {
        out.push({
          role: "system",
          content: `Original user request (pinned):\n${firstUser.content}`,
        });
      }
    }

    // Raw tail: everything the summary doesn't yet cover.
    for (let i = summaryUpTo; i < msgs.length; i++) {
      const m = msgs[i]!;
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  /**
   * Fold old turns into the rolling summary when the estimated prompt size
   * exceeds the compaction trigger. Mutates `session` in place (summary,
   * summaryUpTo) and persists the new fields to the transcript frontmatter
   * so a restart doesn't lose the compaction.
   *
   * No-op when: there aren't enough messages, or the budget is comfortably
   * under the trigger.
   */
  private async maybeCompact(
    session: ChatSession,
    baseSystemPrompt: string
  ): Promise<void> {
    if (session.messages.length < MIN_MESSAGES_TO_COMPACT) return;
    const promptNow = this.buildPromptMessages(session, baseSystemPrompt);
    const estimated = estimateTokensForMessages(promptNow);
    if (estimated < COMPACT_TRIGGER_TOKENS) return;

    const summaryUpTo = session.summaryUpTo ?? 0;
    const foldUpTo = session.messages.length - KEEP_TAIL_MESSAGES;
    if (foldUpTo <= summaryUpTo) return;

    const newTurns = session.messages.slice(summaryUpTo, foldUpTo);
    if (newTurns.length === 0) return;

    const prevSummary = session.summary?.trim() ?? "";
    const transcriptBlock = newTurns
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    const userPayload =
      `PREVIOUS SUMMARY:\n${prevSummary || "(none yet)"}\n\n` +
      `NEW TURNS:\n${transcriptBlock}`;

    const llm = llmProviderFactory.get();
    let rolled: string;
    try {
      const response = await llm.sendMessage({
        temperature: 0.1,
        messages: [
          { role: "system", content: ROLLING_SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: userPayload },
        ],
      });
      rolled = response.content.trim();
    } catch (err) {
      // Don't fail the user's turn if compaction fails — log and keep the
      // full context this round; we'll retry on the next turn.
      log.warn("maybeCompact: rolling summary failed, deferring", {
        sessionId: session.id,
        err: String(err),
      });
      return;
    }

    if (!rolled) {
      log.warn("maybeCompact: empty summary, skipping", { sessionId: session.id });
      return;
    }

    session.summary = rolled;
    session.summaryUpTo = foldUpTo;
    await this.persistSessionState(session);

    log.info("maybeCompact", {
      sessionId: session.id,
      beforeEst: estimated,
      summaryUpTo: foldUpTo,
      summaryChars: rolled.length,
    });
  }

  /**
   * Write the mutable session fields (summary / summaryUpTo / token totals)
   * into the transcript frontmatter. Cheap re-read+re-write; chat turns are
   * rare events at human typing rate.
   */
  private async persistSessionState(session: ChatSession): Promise<void> {
    if (!session.transcriptPath) return;
    const patch: NoteFrontmatter = {
      updated: session.updatedAt,
    };
    if (session.summary !== undefined) patch.running_summary = session.summary;
    if (session.summaryUpTo !== undefined) patch.summary_up_to = session.summaryUpTo;
    if (session.totalTokensUsed !== undefined) {
      patch.total_tokens_used = session.totalTokensUsed;
    }
    try {
      await this.vault.updateFrontmatter(session.transcriptPath, patch);
    } catch (err) {
      log.warn("persistSessionState: updateFrontmatter failed", {
        sessionId: session.id,
        err: String(err),
      });
    }
  }

  async createSession(input?: CreateSessionInput): Promise<ChatSession> {
    await this.ensureReady();

    const llm = llmProviderFactory.get();
    const id = newId("chat");
    const now = nowIso();
    const title = (input?.title ?? `Chat ${compactLocalStamp()}`).trim() || "Chat";

    const session: ChatSession = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    const stamp = compactLocalStamp();
    const filename = ensureMarkdownExt(`${stamp} ${title}`);
    const created = await this.vault.createNote({
      folder: VAULT_FOLDERS.aiChats,
      title: filename,
      content: "",
      metadata: {
        type: "ai-chat",
        id,
        title,
        created: now,
        updated: now,
        provider: llm.id,
        model: llm.defaultModel,
      },
      uniqueOnConflict: true,
    });

    session.transcriptPath = created.path;
    this.store.put(session, input?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    log.info("createSession", { id, title, transcriptPath: created.path });
    return session;
  }

  async listSessions(): Promise<ChatSession[]> {
    await this.ensureReady();
    return this.store.all();
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    await this.ensureReady();
    const cached = this.store.get(id);
    if (cached) return cached;
    return this.hydrateSessionById(id);
  }

  estimateNextPromptTokens(session: ChatSession): number {
    const systemPrompt =
      this.store.getSystemPrompt(session.id) ?? DEFAULT_SYSTEM_PROMPT;
    const messages = this.buildPromptMessages(session, systemPrompt);
    return estimateTokensForMessages(messages);
  }

  async *streamUserMessage(input: AppendMessageInput): AsyncIterable<StreamEvent> {
    await this.ensureReady();
    let session = this.store.get(input.sessionId);
    if (!session) session = await this.hydrateSessionById(input.sessionId);
    if (!session) {
      log.warn("streamUserMessage: unknown session", {
        sessionId: input.sessionId,
      });
      throw new Error(`Unknown chat session: ${input.sessionId}`);
    }

    const tTurn = log.time("streamUserMessage");
    log.info("chat turn: start", {
      sessionId: session.id,
      messageCount: session.messages.length,
      userChars: input.content.length,
    });

    const userMessage: ChatMessage = {
      id: newId("msg"),
      role: "user",
      content: input.content,
      createdAt: nowIso(),
    };
    session.messages.push(userMessage);
    session.updatedAt = userMessage.createdAt;
    if (session.transcriptPath) {
      await this.vault.appendToNote(
        session.transcriptPath,
        renderChatMessageMarkdown(userMessage)
      );
    }

    const systemPrompt =
      this.store.getSystemPrompt(session.id) ?? DEFAULT_SYSTEM_PROMPT;

    // Compact BEFORE building the prompt so the new user message participates
    // in the decision on whether we've hit the trigger. The summary already
    // excludes the tail (including the just-appended user message), so the
    // new message is guaranteed to reach the model raw.
    await this.maybeCompact(session, systemPrompt);

    const llmMessages = this.buildPromptMessages(session, systemPrompt);

    const assistantId = newId("msg");
    let buffer = "";
    let lastUsage: ChatUsage | undefined;
    let chunks = 0;
    let firstChunkAt: number | undefined;
    const generationStart = Date.now();

    const llm = llmProviderFactory.get();
    try {
      for await (const frame of llm.streamMessage({ messages: llmMessages })) {
        if (frame.usage) lastUsage = frame.usage;
        if (!frame.delta) continue;
        if (firstChunkAt === undefined) firstChunkAt = Date.now();
        buffer += frame.delta;
        chunks += 1;
        yield {
          delta: frame.delta,
          done: false,
          assistantMessageId: assistantId,
        };
      }
    } catch (err) {
      tTurn.fail("streamUserMessage: provider stream failed", {
        sessionId: session.id,
        chunks,
        bufferedChars: buffer.length,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: buffer,
      createdAt: nowIso(),
    };
    session.messages.push(assistantMessage);
    session.updatedAt = assistantMessage.createdAt;

    // Token accounting. Prefer the provider's real counts; fall back to
    // a local estimate so the UI counter never regresses to zero on
    // providers/models that omit `usage` for streamed completions.
    const turnTokens =
      lastUsage?.totalTokens ??
      (estimateTokensForMessages(llmMessages) + estimateTokensForMessages([
        { role: "assistant", content: buffer },
      ]));
    session.totalTokensUsed = (session.totalTokensUsed ?? 0) + turnTokens;

    if (session.transcriptPath) {
      await this.vault.appendToNote(
        session.transcriptPath,
        renderChatMessageMarkdown(assistantMessage)
      );
    }
    await this.persistSessionState(session);

    const usage: SessionTokenUsage = {
      lastTurnTotalTokens: lastUsage?.totalTokens,
      lastTurnPromptTokens: lastUsage?.promptTokens,
      lastTurnCompletionTokens: lastUsage?.completionTokens,
      lastTurnCachedTokens: lastUsage?.cachedPromptTokens,
      sessionTotalTokens: session.totalTokensUsed,
      nextPromptEstimateTokens: this.estimateNextPromptTokens(session),
      limitTokens: TOKEN_HARD_LIMIT,
    };

    tTurn.done("streamUserMessage", {
      sessionId: session.id,
      chunks,
      assistantChars: buffer.length,
      timeToFirstChunkMs:
        firstChunkAt !== undefined ? firstChunkAt - generationStart : null,
      promptTokens: lastUsage?.promptTokens,
      completionTokens: lastUsage?.completionTokens,
      cachedPromptTokens: lastUsage?.cachedPromptTokens,
      turnTokens,
      sessionTotalTokens: session.totalTokensUsed,
      nextPromptEstimateTokens: usage.nextPromptEstimateTokens,
    });

    yield { delta: "", done: true, assistantMessageId: assistantId, usage };
  }

  async summarize(sessionId: string): Promise<SummaryResult> {
    await this.ensureReady();
    let session = this.store.get(sessionId);
    if (!session) session = await this.hydrateSessionById(sessionId);
    if (!session) {
      log.warn("summarize: unknown session", { sessionId });
      throw new Error(`Unknown chat session: ${sessionId}`);
    }
    if (session.messages.length === 0) {
      log.warn("summarize: empty session", { sessionId });
      throw new Error("Cannot summarize an empty chat session");
    }

    const t = log.time("summarize");
    log.debug("summarize: start", {
      sessionId,
      messageCount: session.messages.length,
    });

    const llm = llmProviderFactory.get();
    let result;
    try {
      result = await llm.summarize({
        messages: session.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });
    } catch (err) {
      t.fail("summarize: provider failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const stamp = compactLocalStamp();
    const filename = ensureMarkdownExt(`${stamp} ${session.title}`);
    const body =
      `> Source chat: [[${stripMdExt(session.transcriptPath ?? "")}]]\n\n` +
      result.markdown;

    const created = await this.vault.createNote({
      folder: VAULT_FOLDERS.aiSummaries,
      title: filename,
      content: body,
      metadata: {
        type: "ai-summary",
        chat_id: session.id,
        chat_title: session.title,
        created: nowIso(),
        provider: result.provider,
        model: result.model,
        source_chat: session.transcriptPath,
        action_items: result.actionItems,
      },
      uniqueOnConflict: true,
    });

    t.done("summarize", {
      sessionId,
      path: created.path,
      actionItems: result.actionItems.length,
      summaryChars: result.markdown.length,
      provider: result.provider,
      model: result.model,
    });
    return {
      summaryPath: created.path,
      summary: result.markdown,
      actionItems: result.actionItems,
    };
  }
}

let cached: ChatService | null = null;

export function getChatService(): ChatService {
  if (cached) return cached;
  cached = new ChatServiceImpl();
  return cached;
}

/**
 * Public hard cap on prompt-input tokens for a single turn. Exposed so API
 * routes and the UI can render progress bars / budget warnings without
 * drifting out of sync with the compaction policy.
 */
export const CHAT_TOKEN_LIMIT = TOKEN_HARD_LIMIT;
