import { llmProviderFactory } from "@/lib/providers/llm";
import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { compactLocalStamp, newId, nowIso } from "@/lib/utils/id";
import { ensureMarkdownExt } from "@/lib/utils/filenames";
import { createLogger } from "@/lib/utils/logger";
import type { ChatMessage, ChatSession } from "@/lib/types";
import { getChatSessionStore } from "./sessionStore";
import { renderChatMessageMarkdown, stripMdExt } from "./transcripts";

const log = createLogger("chatService");

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant integrated with the user's Obsidian vault. " +
  "Be concise, accurate, and structured. When useful, suggest action items the user can save.";

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
}

export interface ChatService {
  ensureReady(): Promise<void>;
  createSession(input?: CreateSessionInput): Promise<ChatSession>;
  listSessions(): ChatSession[];
  getSession(id: string): ChatSession | undefined;
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

  listSessions(): ChatSession[] {
    return this.store.all();
  }

  getSession(id: string): ChatSession | undefined {
    return this.store.get(id);
  }

  async *streamUserMessage(input: AppendMessageInput): AsyncIterable<StreamEvent> {
    const session = this.store.get(input.sessionId);
    if (!session) throw new Error(`Unknown chat session: ${input.sessionId}`);

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

    const llm = llmProviderFactory.get();
    const systemPrompt =
      this.store.getSystemPrompt(session.id) ?? DEFAULT_SYSTEM_PROMPT;

    const llmMessages = [
      { role: "system" as const, content: systemPrompt },
      ...session.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const assistantId = newId("msg");
    let buffer = "";

    // streamMessage now yields plain text deltas; iterable end == done.
    for await (const delta of llm.streamMessage({ messages: llmMessages })) {
      if (!delta) continue;
      buffer += delta;
      yield { delta, done: false, assistantMessageId: assistantId };
    }
    yield { delta: "", done: true, assistantMessageId: assistantId };

    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: buffer,
      createdAt: nowIso(),
    };
    session.messages.push(assistantMessage);
    session.updatedAt = assistantMessage.createdAt;
    if (session.transcriptPath) {
      await this.vault.appendToNote(
        session.transcriptPath,
        renderChatMessageMarkdown(assistantMessage)
      );
    }
  }

  async summarize(sessionId: string): Promise<SummaryResult> {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Unknown chat session: ${sessionId}`);
    if (session.messages.length === 0) {
      throw new Error("Cannot summarize an empty chat session");
    }

    const llm = llmProviderFactory.get();
    const result = await llm.summarize({
      messages: session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

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

    log.info("summarize", {
      sessionId,
      path: created.path,
      actionItems: result.actionItems.length,
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
