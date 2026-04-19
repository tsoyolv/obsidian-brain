/**
 * Shared domain types used across services, providers, and API.
 */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string; // ISO
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Vault-relative path of transcript markdown file, if persisted. */
  transcriptPath?: string;
}

/**
 * Domain-side capture intent. Mirrors the provider-level `Intent` type from
 * `lib/providers/llm/types`; kept here so the service result type doesn't
 * leak the provider package as an import requirement on its consumers.
 */
export type CaptureIntent =
  | "note"
  | "create_task"
  | "complete_task"
  | "search"
  | "ask_vault_question"
  | "unknown";

export interface CaptureActionResult {
  intent: CaptureIntent;
  status: "ok" | "ambiguous" | "not_found" | "error";
  /** Conversational message to show to the user. */
  message: string;
  /** Optional structured details about what happened. */
  details?: Record<string, unknown>;
}

export interface VoiceLogResult {
  path: string; // vault-relative
  transcript: string;
  provider: string;
  model: string;
}

export interface SearchHit {
  path: string; // vault-relative
  title: string;
  snippet: string;
  score: number;
}

export interface NoteFrontmatter {
  type?: string;
  created?: string;
  updated?: string;
  source?: string;
  provider?: string;
  model?: string;
  status?: string;
  tags?: string[];
  [key: string]: unknown;
}
