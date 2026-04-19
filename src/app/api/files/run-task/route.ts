import { z } from "zod";
import { getFileTaskService } from "@/lib/services/fileTask";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Step 5+ of the file-candidate workflow: read the user-confirmed file and
 * run an LLM task against its content. The body of the file is read only
 * inside this request — the response carries the model's output, never the
 * raw note content.
 *
 * `instruction` is REQUIRED for `extract` and `answer`; ignored for
 * `summarize` and `generate_tasks`.
 */
const BodySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["summarize", "extract", "answer", "generate_tasks"]),
  instruction: z.string().trim().min(1).optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const result = await getFileTaskService().execute({
      path: body.path,
      kind: body.kind,
      instruction: body.instruction,
    });
    return ok(result);
  } catch (err) {
    return handleError("POST /api/files/run-task", err);
  }
}
