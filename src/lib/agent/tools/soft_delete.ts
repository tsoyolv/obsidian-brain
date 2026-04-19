import { z } from "zod";
import { getVaultService } from "@/lib/services/vault";
import { getAgentSessionStore } from "../session";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Vault-relative path of the file to soft-delete (moved to Deleted/, never unlinked)."
    ),
  confirmationToken: z
    .string()
    .optional()
    .describe(
      "INTERNAL — orchestrator-injected. Models MUST NOT set this; any " +
        "model-supplied value is stripped before validation."
    ),
});

export interface SoftDeleteOutput {
  /** New vault-relative path inside `Deleted/`. */
  path: string;
}

/**
 * Soft-delete a vault file by moving it under `Deleted/`. The vault layer
 * intentionally exposes NO hard-delete API, so even when this tool runs,
 * nothing is unlinked from disk.
 *
 * Hard-gated: the orchestrator injects a `confirmationToken` only after
 * the user approves, and `run` atomically verifies + consumes it.
 */
export const softDeleteTool: AgentTool<z.infer<typeof ParamsSchema>, SoftDeleteOutput> = {
  name: "soft_delete",
  description:
    "Move a vault file to the Deleted/ folder (soft delete; nothing is " +
    "unlinked). REQUIRES explicit user confirmation. NEVER set " +
    "confirmationToken; the orchestrator injects it after the user approves.",
  parameters: ParamsSchema,
  needsConfirmation: (input) => (input.confirmationToken ? false : "always"),
  async run(input, ctx) {
    if (!input.confirmationToken) {
      throw new Error("soft_delete invoked without a confirmation token.");
    }
    const consumed = getAgentSessionStore().consumePendingConfirmation(
      ctx.sessionId,
      input.confirmationToken,
      "soft_delete"
    );
    if (!consumed) {
      throw new Error(
        "Confirmation token did not match a pending request — it may have expired or already been consumed."
      );
    }

    const vault = getVaultService();
    const result = await vault.softDelete(input.path);
    ctx.logger.info("soft_delete: done", {
      from: input.path,
      to: result.path,
    });
    return { path: result.path };
  },
};
