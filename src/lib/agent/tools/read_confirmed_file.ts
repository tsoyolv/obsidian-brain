import { z } from "zod";
import { getFileCandidateService } from "@/lib/services/fileCandidate";
import type { FileReadResult } from "@/lib/types";
import { getAgentSessionStore } from "../session";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Vault-relative path of a file the user has explicitly confirmed reading."
    ),
  task: z
    .string()
    .optional()
    .describe("Echo of the follow-up task this read was confirmed for."),
  confirmationToken: z
    .string()
    .optional()
    .describe(
      "INTERNAL — orchestrator-injected. Models MUST NOT set this; any " +
        "model-supplied value is stripped before validation."
    ),
});

/**
 * Read the body of a previously-surfaced candidate. The vault-safety model
 * requires explicit user confirmation before ANY file body is loaded into
 * the context window, so this tool is hard-gated.
 *
 * Two confirmation paths land here:
 *   1. The model calls without `confirmationToken` → `needsConfirmation`
 *      fires → orchestrator stashes pending + surfaces a confirm event.
 *   2. After the user confirms (button click OR natural-language "yes"),
 *      the orchestrator re-invokes this tool with the issued token; `run`
 *      atomically verifies + consumes the pending record before reading.
 */
export const readConfirmedFileTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  FileReadResult
> = {
  name: "read_confirmed_file",
  description:
    "Read the FULL body of a single confirmed vault file. REQUIRES explicit " +
    "user confirmation — do not call until the user has agreed to open the " +
    "specific path returned by propose_open_file. NEVER set confirmationToken; " +
    "the orchestrator injects it after the user approves.",
  parameters: ParamsSchema,
  needsConfirmation: (input) => (input.confirmationToken ? false : "always"),
  async run(input, ctx) {
    if (!input.confirmationToken) {
      throw new Error(
        "read_confirmed_file invoked without a confirmation token."
      );
    }
    const consumed = getAgentSessionStore().consumePendingConfirmation(
      ctx.sessionId,
      input.confirmationToken,
      "read_confirmed_file"
    );
    if (!consumed) {
      throw new Error(
        "Confirmation token did not match a pending request — it may have expired or already been consumed."
      );
    }

    const fileCandidates = getFileCandidateService();
    const result = await fileCandidates.readForTask({
      path: input.path,
      task: input.task,
    });
    ctx.logger.info("read_confirmed_file: read", {
      path: result.path,
      chars: result.content.length,
    });
    return result;
  },
};
