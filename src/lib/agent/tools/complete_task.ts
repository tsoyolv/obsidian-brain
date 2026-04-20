import { z } from "zod";
import { getTaskService } from "@/lib/services/task";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  taskText: z
    .string()
    .min(1)
    .describe(
      "Fuzzy-search needle for the open task to mark done. Need not match verbatim."
    ),
});

export type CompleteTaskOutput =
  | { status: "ok"; path: string; line: number; text: string }
  | { status: "ambiguous"; matches: { text: string; path: string; line: number }[] }
  | { status: "not_found" };

/**
 * Mark an existing OPEN task as done. Wraps `taskService.completeTask`,
 * which fuzzy-matches across the vault and returns `ambiguous` /
 * `not_found` outcomes the agent must surface verbatim instead of guessing.
 */
export const completeTaskTool: AgentTool<z.infer<typeof ParamsSchema>, CompleteTaskOutput> = {
  name: "complete_task",
  description:
    "Mark an existing open task as completed by fuzzy-matching its text. " +
    "Returns 'ambiguous' when multiple tasks match. If the user explicitly " +
    "allows autonomous choice ('pick any'), the agent should pick one " +
    "candidate and retry with exact task text; otherwise ask for disambiguation.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const tasks = getTaskService();
    const result = await tasks.completeTask(input.taskText);
    if (result.status === "ok") {
      ctx.logger.info("complete_task: ok", {
        path: result.hit.path,
        line: result.hit.line,
      });
      return {
        status: "ok",
        path: result.hit.path,
        line: result.hit.line,
        text: result.hit.text,
      };
    }
    if (result.status === "ambiguous") {
      return {
        status: "ambiguous",
        matches: result.matches.map((m) => ({
          text: m.text,
          path: m.path,
          line: m.line,
        })),
      };
    }
    return { status: "not_found" };
  },
};
