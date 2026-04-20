import { z } from "zod";
import { getTaskService } from "@/lib/services/task";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  taskText: z
    .string()
    .min(1)
    .describe("Concrete TODO text. No checkbox / bullet prefix."),
  targetFile: z
    .string()
    .optional()
    .describe(
      "Optional vault-relative file to append the task to. Defaults to Tasks/tasks.md."
    ),
});

export interface CreateTaskOutput {
  path: string;
  text: string;
}

/**
 * Append `- [ ] <text>` to a tasks file via `taskService.createTask`.
 * Defaults to `Tasks/tasks.md` when `targetFile` is omitted.
 */
export const createTaskTool: AgentTool<z.infer<typeof ParamsSchema>, CreateTaskOutput> = {
  name: "create_task",
  description:
    "Add a new TODO / action item to the user's task list. Use when the " +
    "user asks to remember to do something.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const tasks = getTaskService();
    const result = await tasks.createTask({
      text: input.taskText,
      targetFile: input.targetFile,
    });
    ctx.logger.info("create_task: created", {
      path: result.path,
      text: result.text,
    });
    return result;
  },
};
