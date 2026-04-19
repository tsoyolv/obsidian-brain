import { z } from "zod";
import { getFileCandidateService } from "@/lib/services/fileCandidate";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Step 5 of the file-candidate workflow: actually read a file the user has
 * just confirmed. Until this endpoint is hit, no file body has been opened.
 *
 * The path MUST be one previously surfaced by `findCandidates` and explicitly
 * confirmed by the user. The vault layer re-validates the path (rejecting
 * traversal / absolute / illegal paths) before any I/O.
 */
const BodySchema = z.object({
  path: z.string().min(1),
  task: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const result = await getFileCandidateService().readForTask({
      path: body.path,
      task: body.task,
    });
    return ok(result);
  } catch (err) {
    return handleError("POST /api/files/read-for-task", err);
  }
}
