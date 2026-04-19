import { z } from "zod";
import { getVaultService, type FileMatch } from "@/lib/services/vault";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Filename / title fragment. NEVER reads file bodies."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Maximum number of matches to return (default 10)."),
});

export interface FindFileOutput {
  query: string;
  matches: FileMatch[];
}

/**
 * Filename-only fuzzy match. Read-only and SAFE — `vault.findFilesByName`
 * never opens file bodies, so this tool can be invoked freely without
 * surfacing note contents.
 */
export const findFileTool: AgentTool<z.infer<typeof ParamsSchema>, FindFileOutput> = {
  name: "find_file",
  description:
    "Locate vault files by filename only. Returns paths/titles/scores; " +
    "DOES NOT read file contents. Use as a precursor to propose_open_file " +
    "when the user wants to open a specific file.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const vault = getVaultService();
    const limit = input.limit ?? 10;
    const matches = await vault.findFilesByName(input.query, { limit });
    ctx.logger.info("find_file: done", {
      query: input.query,
      matches: matches.length,
    });
    return { query: input.query, matches };
  },
};
