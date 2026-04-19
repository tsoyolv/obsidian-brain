import type { Role } from "@/lib/types";

/**
 * Public LLM provider contract.
 *
 * The interface intentionally exposes a small set of HIGH-LEVEL operations:
 *  - sendMessage / streamMessage  — generic chat completion
 *  - classifyIntent               — parse a free-form user request into a typed intent
 *  - summarize                    — turn a chat transcript into structured markdown
 *
 * `classifyIntent` and `summarize` live on the provider (rather than in
 * services) so each provider can tune prompts, response_format, and parsing
 * for its own model family without leaking provider-specific concerns into
 * the business layer.
 */

export interface LLMMessage {
  role: Role;
  content: string;
}

export interface ChatInput {
  /** Optional model override; falls back to the provider's defaultModel. */
  model?: string;
  messages: LLMMessage[];
  /** 0–2 (provider clamps as needed). */
  temperature?: number;
  /** Hint that the response must be a JSON object. */
  responseFormat?: "text" | "json_object";
  /** Soft token cap for output. */
  maxOutputTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  /** Provider id, e.g. "openai". */
  provider: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

// ---- Intent classification ----

export type Intent =
  | "note"
  | "create_task"
  | "complete_task"
  | "search"
  | "ask_vault_question"
  | "unknown";

export interface IntentResult {
  intent: Intent;
  /** Cleaned-up content of the user's request (no command chrome). */
  text: string;
  /** Optional title hint, used for note saves. */
  title?: string;
  /** Optional task text used for create_task / complete_task lookups. */
  taskText?: string;
  /** Optional free-form tags suggested by the model. */
  tags?: string[];
}

// ---- Summarization ----

export interface SummaryInput {
  /** Conversation to summarize, in chronological order. */
  messages: LLMMessage[];
  /** Optional extra instructions appended to the system prompt. */
  instructions?: string;
}

export interface SummaryResult {
  /** Markdown body, including '## Summary' and '## Action Items' sections. */
  markdown: string;
  /** Action items extracted from the markdown, in order. */
  actionItems: string[];
  /** Provider id and model that produced the summary. */
  provider: string;
  model: string;
}

// ---- The provider interface ----

export interface LLMProvider {
  /** Stable identifier of this provider (e.g. "openai"). */
  readonly id: string;
  /** Default chat model, used when ChatInput.model is not specified. */
  readonly defaultModel: string;

  sendMessage(input: ChatInput): Promise<ChatResponse>;
  /** Yields incremental text deltas; consumer detects end-of-stream by iterable completion. */
  streamMessage(input: ChatInput): AsyncIterable<string>;
  classifyIntent(input: string): Promise<IntentResult>;
  summarize(input: SummaryInput): Promise<SummaryResult>;
}
