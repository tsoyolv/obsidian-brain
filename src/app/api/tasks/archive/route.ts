import { z } from "zod";
import { handleError, ok } from "@/lib/api/responses";
import { getTaskService } from "@/lib/services/task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  targetFile: z.string().optional(),
});

/**
 * Force-archive completed tasks. Intended for explicit UI actions (button),
 * not natural-language chat commands.
 */
export async function POST(req: Request) {
  try {
    const raw = (await req.json().catch(() => ({}))) as unknown;
    const body = BodySchema.parse(raw ?? {});
    const tasks = getTaskService();
    const result = await tasks.archiveTasksNow(body.targetFile);
    return ok(result);
  } catch (err) {
    return handleError("POST /api/tasks/archive", err);
  }
}
