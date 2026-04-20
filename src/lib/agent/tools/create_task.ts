import { z } from "zod";
import { getTaskService } from "@/lib/services/task";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  taskText: z
    .string()
    .min(1)
    .describe("Concrete TODO text. No checkbox / bullet prefix."),
  priority: z
    .enum(["high", "medium", "low"])
    .optional()
    .describe(
      "Optional task priority: high=⏫, medium=🔼, low=🔽. Defaults to medium."
    ),
  tags: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Optional list of hashtags, with or without leading #."),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Optional due date in ISO format YYYY-MM-DD, rendered as 📅 YYYY-MM-DD."),
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
      priority: input.priority,
      tags: input.tags,
      dueDate: input.dueDate,
      targetFile: input.targetFile,
    });
    ctx.logger.info("create_task: created", {
      path: result.path,
      text: result.text,
    });
    return result;
  },
};
