import type {
  ChatInput,
  ChatResponse,
  IntentResult,
  LLMMessage,
  StreamDelta,
} from "./dto";

export type {
  ChatInput,
  ChatResponse,
  ChatUsage,
  Intent,
  IntentDataMap,
  IntentResult,
  LLMMessage,
  StreamDelta,
} from "./dto";

/**
 * Public LLM provider contract.
 *
 * The interface exposes a small set of HIGH-LEVEL operations:
 *  - sendMessage / streamMessage  — generic chat completion (DTO in / out)
 *  - classifyIntent               — parse a free-form user request into a typed intent
 *  - summarize                    — turn a chat transcript into structured markdown
 *  - rankFileCandidates           — pick the best vault file from a candidate list
 *  - runFileTask                  — run a typed task (summarize / extract / answer
 *                                    / generate_tasks) against a single confirmed file
 *
 * The DTOs in `./dto` ({@link ChatInput}, {@link ChatResponse},
 * {@link IntentResult}) are deliberately provider-agnostic. Provider-
 * specific concerns (response_format tricks, per-model token limits, prompt
 * tuning) stay inside implementations so services never branch on the
 * backend they happen to be wired to.
 */

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
  /**
   * Provenance fields, intended for metadata stamping (YAML frontmatter).
   * NOT for control flow: services must not branch on these values.
   */
  provider: string;
  model: string;
}

// ---- File candidate ranking ----

export interface FileRankCandidate {
  /** Vault-relative path of the candidate file. */
  path: string;
  /** Filename without the `.md` extension. */
  title: string;
}

export interface FileRankInput {
  /** The user's free-form lookup query (e.g. "shopping list"). */
  query: string;
  /**
   * What the user wants to do once the right file is opened. Helps the model
   * disambiguate between similarly-named files (e.g. "reading list" vs
   * "reading log" when the task is "add Dune").
   */
  task?: string;
  /** Pre-filtered candidates produced by a filename-only search. */
  candidates: FileRankCandidate[];
}

export interface FileRankResult {
  /**
   * Vault-relative path of the candidate the model picked, or `null` when no
   * candidate is a confident fit. The path is guaranteed to be one of the
   * input candidates' paths (or `null`); callers should still treat it as
   * untrusted input and re-validate.
   */
  bestPath: string | null;
  /** Short rationale; may be empty. Never includes any file body content. */
  reason?: string;
}

// ---- File task execution ----

/**
 * Supported LLM operations against a single confirmed file. Each kind has a
 * stable contract — see `runFileTask` for what the result holds.
 */
export type FileTaskKind =
  | "summarize"
  | "extract"
  | "answer"
  | "generate_tasks";

export interface FileTaskInput {
  kind: FileTaskKind;
  /** Filename without `.md`. Surfaced to the model for context. */
  title: string;
  /** File body (frontmatter already stripped). May arrive truncated. */
  content: string;
  /**
   * User-supplied instruction. REQUIRED for `extract` and `answer`; optional
   * (and largely ignored) for `summarize` and `generate_tasks`. Implementations
   * MUST throw when a required instruction is missing.
   */
  instruction?: string;
  /** True if the caller truncated the body before passing it in. */
  truncated?: boolean;
}

export interface FileTaskOutput {
  /**
   * Markdown result. For `generate_tasks` this is a `- [ ]` checklist; for
   * `summarize` two markdown sections; for `answer` a concise prose answer;
   * for `extract` whatever the instruction asked for.
   */
  markdown: string;
  /**
   * Parsed task texts for `generate_tasks`; empty array for every other kind.
   * Each entry is the body of a `- [ ]` line, trimmed.
   */
  tasks: string[];
}

// ---- The provider interface ----

export interface LLMProvider {
  /** Stable identifier of this provider (e.g. "openai"). */
  readonly id: string;
  /** Default chat model, used when ChatInput.model is not specified. */
  readonly defaultModel: string;

  sendMessage(input: ChatInput): Promise<ChatResponse>;
  /**
   * Yields incremental text deltas. The final frame additionally carries
   * `usage` (when the provider exposes token accounting for streams);
   * consumers should treat stream completion as end-of-message regardless.
   */
  streamMessage(input: ChatInput): AsyncIterable<StreamDelta>;
  classifyIntent(input: string): Promise<IntentResult>;
  summarize(input: SummaryInput): Promise<SummaryResult>;
  /**
   * Rank a list of vault file candidates against a user query (and optional
   * follow-up task). Returns the best pick or `null` when nothing fits.
   *
   * Implementations MUST NOT read file bodies — they only see paths and
   * titles. The `bestPath` returned is advisory; the caller still asks the
   * user for explicit confirmation before any read happens.
   */
  rankFileCandidates(input: FileRankInput): Promise<FileRankResult>;
  /**
   * Run a typed task against the body of a single, user-confirmed file.
   * Implementations dispatch on `input.kind` to a stable per-kind prompt
   * and return both the raw markdown and (for `generate_tasks`) a parsed
   * checklist for downstream automation.
   */
  runFileTask(input: FileTaskInput): Promise<FileTaskOutput>;
}
