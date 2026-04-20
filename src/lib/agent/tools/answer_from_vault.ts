import { z } from "zod";
import { llmProviderFactory } from "@/lib/providers/llm";
import { getSearchService } from "@/lib/services/search";
import { getChatService } from "@/lib/services/chat";
import { getVaultService } from "@/lib/services/vault";
import type { ChatSession, SearchHit } from "@/lib/types";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe("Natural-language question to answer from vault content."),
  topK: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "How many strong matches to pull as bounded context (default 5). " +
        "A single near-miss is also included when available."
    ),
});

export interface AnswerFromVaultOutput {
  answer: string;
  sources: { path: string; title: string; origin: "data" | "active_chat" | "recent_chat" }[];
}

/**
 * Hard upper bound on how much of an existing note we will read into the
 * context window for a vault-grounded answer.
 *
 * The full file is NEVER loaded without explicit user confirmation; this
 * cap keeps any incidental context read strictly partial — same invariant
 * captureService.ts has historically enforced.
 */
const ASK_CONTEXT_HEAD_CHARS = 1500;
const RECENT_CHAT_CANDIDATES = 5;
const ACTIVE_CHAT_SCORE_BOOST = 3;
const CHAT_MESSAGE_TAIL = 24;

interface UnifiedHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  origin: "data" | "active_chat" | "recent_chat";
  chatSessionId?: string;
}

/**
 * Answer a question using only vault content.
 *
 * Uses {@link SearchService.searchLayered} so the context is built from
 * `strong` content matches first; when there are fewer than `topK` strong
 * hits we top up with the single highest-scoring `near`-miss to give the
 * model a fighting chance on questions whose phrasing didn't quite line
 * up with the body wording. We deliberately stop at one near-miss — more
 * would dilute the prompt and waste the bounded read budget.
 *
 *   1. layered keyword search (`strong` + top-1 of `near`)
 *   2. read ONLY the head of each picked note (`ASK_CONTEXT_HEAD_CHARS`)
 *   3. ask the LLM to answer using strictly that bounded context
 *
 * The bounded read is the safety guarantee: a misbehaving agent loop
 * cannot escalate this tool into a full file read.
 */
export const answerFromVaultTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  AnswerFromVaultOutput
> = {
  name: "answer_from_vault",
  description:
    "Answer a question using ONLY the user's vault notes. Picks the top " +
    "strong matches (plus one near-miss when needed) and reads only the " +
    "first ~1500 chars of each (no full reads). Use for 'what did I " +
    "write about X?' style questions.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const search = getSearchService();
    const chat = getChatService();
    const vault = getVaultService();
    const llm = llmProviderFactory.get();

    const topK = input.topK ?? 5;
    const layeredData = await search.searchLayered(input.question, {
      limit: topK,
      folder: "Data",
    });

    // strong-first; one near-miss appended when we have headroom and at
    // least one near hit. De-dupe by path so the same file doesn't burn
    // two slots of the context budget.
    const seenData = new Set<string>();
    const dataPicked: SearchHit[] = [];
    for (const h of layeredData.strong.slice(0, topK)) {
      if (seenData.has(h.path)) continue;
      seenData.add(h.path);
      dataPicked.push(h);
    }
    if (dataPicked.length < topK && layeredData.near.length > 0) {
      const candidate = layeredData.near[0]!;
      if (!seenData.has(candidate.path)) {
        seenData.add(candidate.path);
        dataPicked.push(candidate);
      }
    }

    const tokens = tokenize(input.question);
    const activeSession = await chat.getSession(ctx.sessionId);
    const allSessions = await chat.listSessions();
    const recentSessions = allSessions
      .filter((s) => s.id !== ctx.sessionId && Boolean(s.transcriptPath))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, RECENT_CHAT_CANDIDATES);

    const unified: UnifiedHit[] = [];
    for (const h of dataPicked) {
      unified.push({
        ...h,
        origin: "data",
      });
    }
    if (activeSession) {
      const hit = makeChatHit(activeSession, "active_chat", tokens);
      if (hit) {
        hit.score += ACTIVE_CHAT_SCORE_BOOST;
        unified.push(hit);
      }
    }
    for (const s of recentSessions) {
      const hit = makeChatHit(s, "recent_chat", tokens);
      if (hit) unified.push(hit);
    }
    unified.sort((a, b) => b.score - a.score);
    const picked = dedupeUnified(unified).slice(0, topK);

    const contextParts: string[] = [];
    for (const h of picked) {
      if (h.origin === "data") {
        try {
          const note = await vault.readNote(h.path);
          const trimmed = note.body.slice(0, ASK_CONTEXT_HEAD_CHARS);
          contextParts.push(`--- ${h.path} (${h.origin}) ---\n${trimmed}`);
        } catch {
          // unreadable notes just don't contribute context
        }
        continue;
      }
      contextParts.push(`--- ${h.path} (${h.origin}) ---\n${h.snippet}`);
    }
    const context =
      contextParts.join("\n\n") || "(no relevant notes found)";

    const resp = await llm.sendMessage({
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You answer the user's question using ONLY the provided notes. " +
            "If the answer isn't in the notes, say so plainly. Be concise.",
        },
        {
          role: "user",
          content: `Question: ${input.question}\n\nNotes:\n${context}`,
        },
      ],
    });

    ctx.logger.info("answer_from_vault: done", {
      question: input.question,
      dataStrong: layeredData.strong.length,
      dataNear: layeredData.near.length,
      picked: picked.length,
      answerChars: resp.content.length,
    });

    return {
      answer: resp.content.trim() || "(no answer)",
      sources: picked.map((h) => ({ path: h.path, title: h.title, origin: h.origin })),
    };
  },
};

function makeChatHit(
  session: ChatSession,
  origin: "active_chat" | "recent_chat",
  tokens: string[]
): UnifiedHit | undefined {
  const recentMessages = session.messages.slice(-CHAT_MESSAGE_TAIL);
  const text = recentMessages.map((m) => m.content).join("\n");
  const score = scoreQuery(tokens, `${session.title}\n${text}`);
  if (score <= 0) return undefined;
  const path = session.transcriptPath ?? `chat:${session.id}`;
  return {
    path,
    title: session.title,
    snippet: text.slice(0, ASK_CONTEXT_HEAD_CHARS),
    score,
    origin,
    chatSessionId: session.id,
  };
}

function dedupeUnified(hits: UnifiedHit[]): UnifiedHit[] {
  const out: UnifiedHit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const key = `${h.origin}:${h.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function tokenize(query: string): string[] {
  const trimmed = query.trim();
  const minLen = trimmed.length <= 3 ? 1 : 2;
  return trimmed
    .toLowerCase()
    .split(/[^a-z0-9_\-а-яё]+/i)
    .filter((s) => s.length >= minLen);
}

function scoreQuery(tokens: string[], haystack: string): number {
  if (tokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (lower.includes(t)) score += 2;
    score += countOccurrences(lower, t);
  }
  return score;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}
