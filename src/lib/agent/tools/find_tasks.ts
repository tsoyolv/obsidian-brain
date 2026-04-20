import { z } from "zod";
import { getTaskService } from "@/lib/services/task";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Free-text query to search tasks across the vault."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Maximum number of results to return (default 10)."),
});

export interface FindTasksOutput {
  query: string;
  matches: { text: string; path: string; line: number; done: boolean }[];
}

export const findTasksTool: AgentTool<z.infer<typeof ParamsSchema>, FindTasksOutput> = {
  name: "find_tasks",
  description:
    "Search tasks by text across the user's vault (open and completed).",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const tasks = getTaskService();
    const hits = await tasks.findTasks(input.query);
    const limit = input.limit ?? 10;
    const matches = hits.slice(0, limit).map((h) => ({
      text: h.text,
      path: h.path,
      line: h.line,
      done: h.done,
    }));
    ctx.logger.info("find_tasks: done", {
      query: input.query,
      returned: matches.length,
    });
    return {
      query: input.query,
      matches,
    };
  },
};
