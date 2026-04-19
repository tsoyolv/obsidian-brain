import { z } from "zod";
import { getFileTaskService } from "@/lib/services/fileTask";
import type { FileTaskExecution } from "@/lib/types";
import { getAgentSessionStore } from "../session";
import type { AgentTool } from "../types";

const KindEnum = z.enum(["summarize", "extract", "answer", "generate_tasks"]);

const ParamsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Vault-relative path of the confirmed file to operate on."
    ),
  kind: KindEnum.describe(
    "Which LLM operation to run against the file."
  ),
  instruction: z
    .string()
    .optional()
    .describe(
      "REQUIRED for kind='extract' and kind='answer'. Describes what to extract / answer."
    ),
  confirmationToken: z
    .string()
    .optional()
    .describe(
      "INTERNAL — orchestrator-injected. Models MUST NOT set this; any " +
        "model-supplied value is stripped before validation."
    ),
});

/**
 * Run a typed LLM task against a single confirmed file. Reads the body
 * via the audited `fileCandidateService.readForTask` path; same hard
 * confirmation requirement as `read_confirmed_file` — the orchestrator
 * injects a `confirmationToken` only after the user has approved, and
 * `run` atomically verifies + consumes the pending record before doing
 * any I/O.
 */
export const runFileTaskTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  FileTaskExecution
> = {
  name: "run_file_task",
  description:
    "Run a typed LLM operation (summarize / extract / answer / generate_tasks) " +
    "against ONE confirmed vault file. REQUIRES explicit user confirmation — " +
    "the file body will be read into the model context. NEVER set " +
    "confirmationToken; the orchestrator injects it after the user approves.",
  parameters: ParamsSchema,
  needsConfirmation: (input) => (input.confirmationToken ? false : "always"),
  async run(input, ctx) {
    if (!input.confirmationToken) {
      throw new Error("run_file_task invoked without a confirmation token.");
    }
    const consumed = getAgentSessionStore().consumePendingConfirmation(
      ctx.sessionId,
      input.confirmationToken,
      "run_file_task"
    );
    if (!consumed) {
      throw new Error(
        "Confirmation token did not match a pending request — it may have expired or already been consumed."
      );
    }

    const fileTasks = getFileTaskService();
    const result = await fileTasks.execute({
      path: input.path,
      kind: input.kind,
      instruction: input.instruction,
    });
    ctx.logger.info("run_file_task: done", {
      path: result.path,
      kind: result.kind,
      tasks: result.tasks.length,
      truncated: result.truncated,
    });
    return result;
  },
};
