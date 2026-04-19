import { z } from "zod";
import { llmProviderFactory } from "@/lib/providers/llm";
import { getSearchService } from "@/lib/services/search";
import { getVaultService } from "@/lib/services/vault";
import type { SearchHit } from "@/lib/types";
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
  sources: { path: string; title: string }[];
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
    const vault = getVaultService();
    const llm = llmProviderFactory.get();

    const topK = input.topK ?? 5;
    const layered = await search.searchLayered(input.question, {
      limit: topK,
    });

    // strong-first; one near-miss appended when we have headroom and at
    // least one near hit. De-dupe by path so the same file doesn't burn
    // two slots of the context budget.
    const seen = new Set<string>();
    const picked: SearchHit[] = [];
    for (const h of layered.strong.slice(0, topK)) {
      if (seen.has(h.path)) continue;
      seen.add(h.path);
      picked.push(h);
    }
    if (picked.length < topK && layered.near.length > 0) {
      const candidate = layered.near[0]!;
      if (!seen.has(candidate.path)) {
        seen.add(candidate.path);
        picked.push(candidate);
      }
    }

    const contextParts: string[] = [];
    for (const h of picked) {
      try {
        const note = await vault.readNote(h.path);
        const trimmed = note.body.slice(0, ASK_CONTEXT_HEAD_CHARS);
        contextParts.push(`--- ${h.path} ---\n${trimmed}`);
      } catch {
        // unreadable notes just don't contribute context
      }
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
      strong: layered.strong.length,
      near: layered.near.length,
      picked: picked.length,
      answerChars: resp.content.length,
    });

    return {
      answer: resp.content.trim() || "(no answer)",
      sources: picked.map((h) => ({ path: h.path, title: h.title })),
    };
  },
};
