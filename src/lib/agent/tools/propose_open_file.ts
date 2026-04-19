import { z } from "zod";
import { getFileCandidateService } from "@/lib/services/fileCandidate";
import type { FileCandidateResult } from "@/lib/types";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Filename / title fragment to look up."),
  task: z
    .string()
    .min(1)
    .describe(
      "What the user wants to do once the file is opened. Helps disambiguate similar files."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Maximum number of candidates (default 5)."),
});

/**
 * Steps 1–3 of the file-candidate workflow: filename search + LLM ranking.
 * Read-only — NO file body is read here. The orchestrator surfaces the
 * `bestGuess` to the user; an actual read requires `read_confirmed_file`.
 */
export const proposeOpenFileTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  FileCandidateResult
> = {
  name: "propose_open_file",
  description:
    "Propose a vault file to open for a follow-up task. Returns ranked " +
    "candidates (filename-only) WITHOUT reading file contents. Always pair " +
    "with read_confirmed_file once the user confirms the pick.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const fileCandidates = getFileCandidateService();
    const result = await fileCandidates.findCandidates({
      query: input.query,
      task: input.task,
      limit: input.limit ?? 5,
    });
    ctx.logger.info("propose_open_file: done", {
      query: input.query,
      candidates: result.candidates.length,
      bestGuess: result.bestGuess?.path,
    });
    return result;
  },
};
