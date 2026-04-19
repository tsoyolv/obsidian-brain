import { llmProviderFactory } from "@/lib/providers/llm";
import { getVaultService } from "@/lib/services/vault";
import type {
  FileCandidate,
  FileCandidateResult,
  FileReadResult,
} from "@/lib/types";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("fileCandidateService");

export interface FindCandidatesInput {
  /** User's lookup query (filename / title fragment). */
  query: string;
  /** Optional follow-up task — helps the ranker disambiguate similar files. */
  task?: string;
  /** Maximum number of candidates to surface. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
}

export interface ReadForTaskInput {
  /** Vault-relative path of a file the user has explicitly confirmed. */
  path: string;
  /** Echo of the task this read was confirmed for, when present. */
  task?: string;
}

/**
 * File-candidate workflow.
 *
 * Five-step flow that NEVER reads a file body without explicit confirmation:
 *
 *   1. search          — filename-only fuzzy match (`vault.findFilesByName`)
 *   2. return          — surface the raw candidates to the caller
 *   3. LLM ranks       — ask the provider to pick the best candidate
 *   4. ask confirm     — caller shows the bestGuess and waits for a yes
 *   5. read on confirm — caller invokes {@link FileCandidateService.readForTask}
 *
 * `findCandidates` performs steps 1–3 and returns the data the caller needs
 * for step 4. `readForTask` is the only method that actually opens a file.
 */
export interface FileCandidateService {
  findCandidates(input: FindCandidatesInput): Promise<FileCandidateResult>;
  /**
   * Read the body of a previously-surfaced candidate. Callers are expected to
   * have shown the path to the user and received explicit confirmation before
   * invoking this — the service does NOT itself check for a recorded confirm,
   * since the workflow is stateless across HTTP requests.
   */
  readForTask(input: ReadForTaskInput): Promise<FileReadResult>;
}

const DEFAULT_LIMIT = 5;

class FileCandidateServiceImpl implements FileCandidateService {
  private readonly vault = getVaultService();

  async findCandidates(
    input: FindCandidatesInput
  ): Promise<FileCandidateResult> {
    const query = input.query.trim();
    const task = input.task?.trim() || undefined;
    const limit = input.limit ?? DEFAULT_LIMIT;

    if (!query) {
      return {
        query: "",
        task,
        candidates: [],
        requiresConfirmation: false,
      };
    }

    // Step 1: cheap filename-only search. Body bytes are never touched.
    const matches = await this.vault.findFilesByName(query, { limit });
    const candidates: FileCandidate[] = matches.map((m) => ({
      path: m.path,
      title: m.title,
      score: m.score,
    }));

    if (candidates.length === 0) {
      return { query, task, candidates: [], requiresConfirmation: false };
    }

    // Single hit ⇒ that's the best guess; no need to spend an LLM call.
    if (candidates.length === 1) {
      const only = { ...candidates[0]!, isBestGuess: true };
      return {
        query,
        task,
        candidates: [only],
        bestGuess: only,
        requiresConfirmation: true,
      };
    }

    // Step 3: LLM ranks. On any failure we fall back to the top-scored
    // candidate from the cheap filename search — confirmation is still
    // required, so a wrong "best guess" is recoverable by the user.
    const llm = llmProviderFactory.get();
    let bestPath: string | null = null;
    let reason: string | undefined;
    try {
      const ranked = await llm.rankFileCandidates({
        query,
        task,
        candidates: candidates.map((c) => ({ path: c.path, title: c.title })),
      });
      bestPath = ranked.bestPath;
      reason = ranked.reason;
    } catch (err) {
      log.warn("rankFileCandidates threw; falling back to top score", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const fallback = candidates[0]!;
    const picked =
      candidates.find((c) => c.path === bestPath) ?? fallback;
    const annotated = candidates.map((c) =>
      c.path === picked.path ? { ...c, isBestGuess: true } : c
    );

    return {
      query,
      task,
      candidates: annotated,
      bestGuess: { ...picked, isBestGuess: true },
      requiresConfirmation: true,
      reason,
    };
  }

  async readForTask(input: ReadForTaskInput): Promise<FileReadResult> {
    // safePathResolve rejects traversal / absolute / illegal paths and
    // normalizes to a vault-relative form before any I/O.
    const safe = this.vault.safePathResolve(input.path);
    if (!(await this.vault.fileExists(safe))) {
      throw new Error(`File not found: ${input.path}`);
    }
    const note = await this.vault.readNote(safe);
    const title = basenameWithoutMd(safe);
    log.info("readForTask", { path: safe, task: input.task });
    return {
      path: safe,
      title,
      content: note.body,
      task: input.task?.trim() || undefined,
    };
  }
}

let cached: FileCandidateService | null = null;

export function getFileCandidateService(): FileCandidateService {
  if (cached) return cached;
  cached = new FileCandidateServiceImpl();
  return cached;
}

export function _resetFileCandidateServiceCache(): void {
  cached = null;
}

// ---- helpers ----

function basenameWithoutMd(relPath: string): string {
  const idx = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  const base = idx >= 0 ? relPath.slice(idx + 1) : relPath;
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}
