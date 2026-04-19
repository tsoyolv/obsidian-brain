import type { Role } from "@/lib/types";

/**
 * Data-transfer objects exchanged between the service layer and any LLM
 * provider. These shapes are deliberately provider-agnostic: no backend
 * identity, no SDK-specific field names, no response envelopes that tie
 * callers to a particular vendor (OpenAI, Anthropic, local, …).
 *
 * If you find yourself adding a provider-named field here, stop — push it
 * down into the provider implementation instead.
 */

// ---- Chat ----

export interface LLMMessage {
  role: Role;
  content: string;
}

/**
 * Input to a single chat completion. Every field is a generic concept that
 * any modern chat LLM supports; provider-specific tuning (system prompt
 * wrapping, stop sequences, tool schemas, …) stays inside the provider.
 */
export interface ChatInput {
  /** Optional model override; falls back to the provider's default model. */
  model?: string;
  messages: LLMMessage[];
  /** 0–2 (provider clamps as needed). */
  temperature?: number;
  /** Hint that the response must be a JSON object. */
  responseFormat?: "text" | "json_object";
  /** Soft token cap for output. */
  maxOutputTokens?: number;
}

/**
 * Output of a single chat completion. Intentionally omits the provider id:
 * the caller is talking to an abstract `LLMProvider` and should not branch
 * on which backend produced the text. If you truly need provenance for
 * logging or persistence, read it off the provider instance instead.
 */
export interface ChatResponse {
  content: string;
  /** The model that actually ran (echo of input.model or the default). */
  model: string;
  /** Token accounting, if the provider exposed it. */
  usage?: ChatUsage;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * Subset of `promptTokens` that the provider served from its prompt cache.
   * Surfaced for visibility/cost monitoring; providers without prompt
   * caching (or below the cache threshold, currently ~1024 tokens for
   * OpenAI) leave this undefined.
   */
  cachedPromptTokens?: number;
}

/**
 * One frame from a streamed completion. `delta` holds the incremental text
 * produced so far (may be empty). `usage` is populated exactly once at the
 * end of the stream — callers should accumulate it on the final frame and
 * not assume it is set on every chunk.
 */
export interface StreamDelta {
  delta: string;
  usage?: ChatUsage;
}

// ---- Intent classification ----

export type Intent =
  | "note"
  | "create_task"
  | "complete_task"
  | "search"
  | "ask_vault_question"
  | "find_file"
  | "open_file_for_task"
  | "unknown";

/**
 * Per-intent payload shapes. The LLM must return `{ intent, data }` matching
 * exactly one of these variants. The provider validates the JSON before
 * surfacing it to the business layer.
 */
export interface IntentDataMap {
  note: {
    /** Cleaned-up note body. */
    text: string;
    /** Optional title hint. */
    title?: string;
    /** Optional free-form tags. */
    tags?: string[];
  };
  create_task: {
    /** Task body to add (no checkbox / bullet). */
    taskText: string;
  };
  complete_task: {
    /** Search text used to fuzzy-match an existing open task. */
    taskText: string;
  };
  search: {
    /** Free-text query for keyword search. */
    query: string;
  };
  ask_vault_question: {
    /** Natural-language question to answer from vault content. */
    question: string;
  };
  find_file: {
    /** File name / title fragment to look up. Names only — no body reads. */
    query: string;
  };
  open_file_for_task: {
    /** File name / title fragment to locate. */
    query: string;
    /** What the user wants to do once the file is opened. */
    task: string;
  };
  unknown: {
    /** Optional human-readable reason the request didn't match. */
    reason?: string;
  };
}

/**
 * Discriminated union of all intent envelopes. Using a mapped type keeps
 * `intent` and `data` perfectly aligned — adding a new entry to
 * {@link IntentDataMap} automatically produces a new variant here.
 */
export type IntentResult = {
  [K in Intent]: { intent: K; data: IntentDataMap[K] };
}[Intent];
