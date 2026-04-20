import { z } from "zod";
import { getTaskService } from "@/lib/services/task";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of open tasks to return (default 20)."),
});

export interface ListOpenTasksOutput {
  totalOpen: number;
  tasks: { text: string; path: string; line: number }[];
}

export const listOpenTasksTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  ListOpenTasksOutput
> = {
  name: "list_open_tasks",
  description: "List currently open tasks across the user's vault.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const tasks = getTaskService();
    const open = await tasks.listOpenTasks();
    const limit = input.limit ?? 20;
    const sliced = open.slice(0, limit).map((t) => ({
      text: t.text,
      path: t.path,
      line: t.line,
    }));
    ctx.logger.info("list_open_tasks: done", {
      totalOpen: open.length,
      returned: sliced.length,
    });
    return {
      totalOpen: open.length,
      tasks: sliced,
    };
  },
};
