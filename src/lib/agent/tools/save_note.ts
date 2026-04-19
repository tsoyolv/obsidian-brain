import { z } from "zod";
import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import { ensureMarkdownExt, sanitizeFilename } from "@/lib/utils/filenames";
import { nowIso, todayLocalDate } from "@/lib/utils/id";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe("The full body of the note to save (plain markdown)."),
  title: z
    .string()
    .optional()
    .describe(
      "Optional short title. If omitted, derived from the first line of `text`."
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Optional list of free-form tags for the note's frontmatter."),
});

export interface SaveNoteOutput {
  path: string;
  title: string;
}

/**
 * Persist a new note to `Inbox/`. Mirrors the `note` capture intent —
 * delegates to `vaultService.createNote`, which enforces the writable-folder
 * allowlist and unique-filename policy. NEVER bypasses the vault service.
 */
export const saveNoteTool: AgentTool<z.infer<typeof ParamsSchema>, SaveNoteOutput> = {
  name: "save_note",
  description:
    "Save a new markdown note to the vault Inbox. Use when the user wants " +
    "to capture a thought / idea / piece of content as a note.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const vault = getVaultService();
    const body = input.text.trim();
    const title = (input.title ?? deriveTitle(body)).trim() || "note";
    const filename = ensureMarkdownExt(`${todayLocalDate()} ${title}`);

    const created = await vault.createNote({
      folder: VAULT_FOLDERS.inbox,
      title: filename,
      content: body,
      metadata: {
        type: "note",
        created: nowIso(),
        source: "agent",
        tags: input.tags,
      },
      uniqueOnConflict: true,
    });

    ctx.logger.info("save_note: created", {
      path: created.path,
      title: sanitizeFilename(title),
      bodyChars: body.length,
      tags: input.tags,
    });

    return { path: created.path, title: sanitizeFilename(title) };
  },
};

function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const trimmed = firstLine.trim().replace(/[#*_>`]+/g, "");
  if (trimmed.length <= 60) return trimmed || "note";
  return trimmed.slice(0, 60).trim() + "…";
}
