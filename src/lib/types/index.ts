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
  /**
   * Rolling plain-prose summary of the head of the conversation. Injected as
   * a system message at the top of the next prompt so the model sees the
   * gist of everything older than {@link summaryUpTo} without paying the
   * token cost of the full transcript.
   */
  summary?: string;
  /**
   * Count of messages (from index 0) already folded into {@link summary}.
   * Everything from index `summaryUpTo` onwards is still sent raw.
   */
  summaryUpTo?: number;
  /**
   * Cumulative token usage across every completion in this session
   * (prompt + completion tokens, as reported by the provider). Displayed in
   * the UI; persisted in the transcript frontmatter so it survives a
   * restart. Missing when no completion has been observed yet.
   */
  totalTokensUsed?: number;
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
  | "find_file"
  | "open_file_for_task"
  | "unknown";

export type CaptureStatus =
  | "ok"
  | "ambiguous"
  | "not_found"
  | "needs_confirmation"
  | "error";

export interface CaptureActionResult {
  intent: CaptureIntent;
  status: CaptureStatus;
  /** Conversational message to show to the user. */
  message: string;
  /** Optional structured details about what happened. */
  details?: Record<string, unknown>;
  /**
   * Vault-relative path of the raw capture log written before the request was
   * classified. Always present for inputs that were persisted (text + voice).
   */
  rawLogPath?: string;
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

/**
 * One candidate file produced by the file-candidate workflow.
 *
 * `score` comes from the cheap filename-only fuzzy match that runs first;
 * `isBestGuess` is set on the single candidate the LLM ranked highest (or on
 * the lone candidate when only one was found).
 */
export interface FileCandidate {
  /** Vault-relative path. */
  path: string;
  /** Filename without the `.md` extension. */
  title: string;
  /** Filename-match score (higher = better). Opaque integer. */
  score: number;
  /** True for the LLM's pick (or the only candidate). At most one per result. */
  isBestGuess?: boolean;
}

/**
 * Result of the file-candidate workflow's "search + rank + ask confirmation"
 * phase. Importantly, NO file body has been read at this point — the user
 * must confirm before any actual read happens (`fileCandidateService.readForTask`).
 */
export interface FileCandidateResult {
  /** Echo of the user's lookup query. */
  query: string;
  /** Echo of the optional follow-up task. */
  task?: string;
  /** All candidates surfaced by the filename-only search, ordered by score desc. */
  candidates: FileCandidate[];
  /**
   * The LLM's pick (or the lone candidate). Undefined when no candidates were
   * found, or when the LLM declined to choose AND no fallback was applied.
   */
  bestGuess?: FileCandidate;
  /**
   * `true` whenever there is at least one candidate to act on. The caller
   * MUST surface a confirm prompt to the user before any file read.
   */
  requiresConfirmation: boolean;
  /** Optional rationale from the ranker. Never includes file body content. */
  reason?: string;
}

/**
 * Result of the confirmation step — the FIRST and only point at which a
 * vault file body is read for a candidate workflow.
 */
export interface FileReadResult {
  /** Vault-relative path of the file that was read. */
  path: string;
  /** Filename without `.md`. */
  title: string;
  /** Full file body (without YAML frontmatter). */
  content: string;
  /** Echo of the follow-up task, when provided. */
  task?: string;
}

/**
 * Supported LLM operations against a single confirmed file. Mirrors
 * `FileTaskKind` from the LLM provider layer; duplicated here so service
 * consumers don't need to import provider types.
 */
export type FileTaskKind =
  | "summarize"
  | "extract"
  | "answer"
  | "generate_tasks";

/**
 * Result of running an LLM file task on a confirmed file. The body has
 * already been read; consumers receive only the model's output, not the
 * raw note content.
 */
export interface FileTaskExecution {
  /** Vault-relative path of the file the task ran against. */
  path: string;
  /** Filename without `.md`. */
  title: string;
  /** Which task was executed. */
  kind: FileTaskKind;
  /** User-supplied instruction (echoed back). */
  instruction?: string;
  /** Markdown result produced by the LLM. */
  markdown: string;
  /**
   * Parsed `- [ ]` checklist items for `kind: "generate_tasks"`; an empty
   * array for every other kind.
   */
  tasks: string[];
  /** True when the file body had to be truncated to fit the context cap. */
  truncated: boolean;
  /** Provider id (e.g. "openai") that executed the task. */
  provider: string;
  /** Concrete model id used. */
  model: string;
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
