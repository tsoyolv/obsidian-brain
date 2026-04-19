import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { handleError, ok } from "@/lib/api/responses";
import { createLogger } from "@/lib/utils/logger";

export const runtime = "nodejs";

const log = createLogger("api.chat.cancel");

const BodySchema = z.object({
  sessionId: z.string().min(1),
  token: z.string().min(1),
});

/**
 * Cancel a pending tool confirmation in an agent-enabled chat session.
 * Idempotent — a stale or unknown token returns `{ matched: false }`
 * rather than an error so the UI can fire-and-forget on dismissal.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return handleError("POST /api/chat/cancel", err);
  }
  try {
    const chat = getChatService();
    const result = await chat.cancelAgentConfirmation(body);
    log.info("cancel", {
      sessionId: body.sessionId,
      token: body.token,
      matched: result.matched,
    });
    return ok(result);
  } catch (err) {
    return handleError("POST /api/chat/cancel", err);
  }
}
