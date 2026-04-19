import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";

const BodySchema = z.object({
  sessionId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const result = await getChatService().summarize(body.sessionId);
    return ok(result);
  } catch (err) {
    return handleError("POST /api/chat/summarize", err);
  }
}
