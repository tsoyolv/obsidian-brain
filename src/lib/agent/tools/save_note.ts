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
 * Persist notes into a single daily note in `Notes/Daily/YYYY-MM-DD.md`.
 * This keeps capture low-friction and avoids one-file-per-note churn while
 * preserving chronological ordering for quick review in Obsidian.
 */
export const saveNoteTool: AgentTool<z.infer<typeof ParamsSchema>, SaveNoteOutput> = {
  name: "save_note",
  description:
    "Save captured content into today's daily note in the vault Notes folder. Use when the user wants " +
    "to capture a thought / idea / piece of content as a note.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const vault = getVaultService();
    const body = input.text.trim();
    const title = (input.title ?? deriveTitle(body)).trim() || "note";
    const dailyPath = vault.joinPath(
      vault.joinPath(VAULT_FOLDERS.notes, "Daily"),
      ensureMarkdownExt(todayLocalDate())
    );
    const entry = renderDailyEntry({
      title,
      body,
      createdIso: nowIso(),
      tags: input.tags,
    });

    await vault.ensureNoteExists(
      dailyPath,
      `# Daily Notes ${todayLocalDate()}\n\n`
    );
    await vault.appendToNote(dailyPath, entry);

    ctx.logger.info("save_note: created", {
      path: dailyPath,
      title: sanitizeFilename(title),
      bodyChars: body.length,
      tags: input.tags,
    });

    return { path: dailyPath, title: sanitizeFilename(title) };
  },
};

function deriveTitle(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const trimmed = firstLine.trim().replace(/[#*_>`]+/g, "");
  if (trimmed.length <= 60) return trimmed || "note";
  return trimmed.slice(0, 60).trim() + "…";
}

function renderDailyEntry(input: {
  title: string;
  body: string;
  createdIso: string;
  tags?: string[];
}): string {
  const created = input.createdIso;
  const tags =
    input.tags && input.tags.length > 0 ? `\n- tags: ${input.tags.join(", ")}` : "";
  return [
    `## ${input.title}`,
    `- created: ${created}${tags}`,
    "",
    input.body,
    "",
  ].join("\n");
}
