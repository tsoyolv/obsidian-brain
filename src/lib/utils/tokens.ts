import type { LLMMessage } from "@/lib/providers/llm/types";

/**
 * Cheap, dependency-free token estimator.
 *
 * Accuracy target: within ~15% of OpenAI's real tokenization for mixed
 * English/Russian text. Good enough to drive budget decisions and UI
 * counters; do NOT use this for billing or to enforce hard API limits —
 * read `usage.total_tokens` from the provider response for that.
 *
 * The constant 3.5 chars/token is a common heuristic across BPE tokenizers
 * for natural language. English runs closer to 4, Russian closer to 2.5
 * (Cyrillic glyphs tend to split into 2 BPE pieces); 3.5 averages the two.
 */
const CHARS_PER_TOKEN = 3.5;

/** Per-message framing overhead in OpenAI chat tokenization. */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTokensForMessages(messages: LLMMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + estimateTokens(m.role) + MESSAGE_OVERHEAD_TOKENS;
  }
  // Account for the assistant-reply priming overhead the model adds server-side.
  return total + 2;
}
