import { llmProviderFactory } from "@/lib/providers/llm";
import { getFileCandidateService } from "@/lib/services/fileCandidate";
import type { FileTaskExecution, FileTaskKind } from "@/lib/types";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("fileTaskService");

export interface ExecuteFileTaskInput {
  /**
   * Vault-relative path of the file to operate on. MUST already have been
   * confirmed by the user (e.g. surfaced by `fileCandidateService.findCandidates`
   * and explicitly accepted client-side). The service does not enforce this
   * itself — confirmation is a UI/transport concern.
   */
  path: string;
  /** Which LLM operation to run. */
  kind: FileTaskKind;
  /** REQUIRED for `extract` and `answer`; ignored otherwise. */
  instruction?: string;
}

/**
 * Step 5+ of the file-candidate workflow.
 *
 * `fileCandidateService.findCandidates` surfaces candidates and the user
 * confirms one. This service then:
 *
 *   1. Reads the confirmed file via `fileCandidateService.readForTask` (the
 *      single, audited read path).
 *   2. Trims the body to a hard context cap so very large notes don't blow
 *      the model window — the caller is told whether truncation happened.
 *   3. Invokes `llm.runFileTask` with a per-kind prompt and returns both the
 *      markdown answer and (for `generate_tasks`) the parsed checklist.
 *
 * The service does NOT itself write anything back to the vault. Acting on
 * generated tasks (e.g. appending to `Tasks/Inbox.md`) is the caller's
 * decision — kept explicit to match the project's "no surprise mutations"
 * safety model.
 */
export interface FileTaskService {
  execute(input: ExecuteFileTaskInput): Promise<FileTaskExecution>;
}

/**
 * Hard cap on file-body chars sent to the LLM. Comfortably below the
 * smallest mainstream chat-model context windows once you account for the
 * system prompt and the model's reply budget.
 */
const MAX_BODY_CHARS = 12000;

class FileTaskServiceImpl implements FileTaskService {
  private readonly fileCandidates = getFileCandidateService();

  async execute(input: ExecuteFileTaskInput): Promise<FileTaskExecution> {
    const kind = input.kind;
    const instruction = input.instruction?.trim() || undefined;
    if ((kind === "extract" || kind === "answer") && !instruction) {
      throw new Error(`File task "${kind}" requires an instruction`);
    }

    // Step 1 — read via the audited path. No `vault.readNote` calls leak
    // into this service so any future safeguard added there applies here too.
    const file = await this.fileCandidates.readForTask({ path: input.path });

    // Step 2 — bounded slice. Whole-file context isn't worth blowing the
    // model window over; we surface `truncated` so the UI can warn.
    const truncated = file.content.length > MAX_BODY_CHARS;
    const body = truncated ? file.content.slice(0, MAX_BODY_CHARS) : file.content;

    // Step 3 — dispatch to the provider. The prompt template lives there so
    // each provider can tune for its own model family.
    const llm = llmProviderFactory.get();
    const out = await llm.runFileTask({
      kind,
      title: file.title,
      content: body,
      instruction,
      truncated,
    });

    log.info("execute", {
      path: file.path,
      kind,
      truncated,
      tasks: out.tasks.length,
    });

    return {
      path: file.path,
      title: file.title,
      kind,
      instruction,
      markdown: out.markdown,
      tasks: out.tasks,
      truncated,
      provider: llm.id,
      model: llm.defaultModel,
    };
  }
}

let cached: FileTaskService | null = null;

export function getFileTaskService(): FileTaskService {
  if (cached) return cached;
  cached = new FileTaskServiceImpl();
  return cached;
}

export function _resetFileTaskServiceCache(): void {
  cached = null;
}
