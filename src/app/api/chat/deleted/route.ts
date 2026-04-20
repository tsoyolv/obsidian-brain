import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RestoreSchema = z.object({
  deletedPath: z.string().min(1),
});

export async function GET() {
  try {
    const chat = getChatService();
    const sessions = await chat.listDeletedSessions();
    return ok({ sessions });
  } catch (err) {
    return handleError("GET /api/chat/deleted", err);
  }
}

export async function POST(req: Request) {
  try {
    const raw = (await req.json().catch(() => ({}))) as unknown;
    const { deletedPath } = RestoreSchema.parse(raw ?? {});
    const chat = getChatService();
    const restored = await chat.restoreDeletedSession(deletedPath);
    return ok(restored);
  } catch (err) {
    return handleError("POST /api/chat/deleted", err);
  }
}
