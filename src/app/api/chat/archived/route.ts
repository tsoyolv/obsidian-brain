import { getChatService } from "@/lib/services/chat";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const chat = getChatService();
    const sessions = await chat.listArchivedSessions();
    return ok({ sessions });
  } catch (err) {
    return handleError("GET /api/chat/archived", err);
  }
}
