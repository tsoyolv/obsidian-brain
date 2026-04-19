import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export async function GET() {
  try {
    const sessions = getChatService()
      .listSessions()
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        transcriptPath: s.transcriptPath,
      }));
    return ok({ sessions });
  } catch (err) {
    return handleError("GET /api/chat/sessions", err);
  }
}

export async function POST(req: Request) {
  try {
    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      // empty body is acceptable
    }
    const input = CreateSchema.parse(raw ?? {});
    const session = await getChatService().createSession(input);
    return ok({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcriptPath: session.transcriptPath,
      messages: session.messages,
    });
  } catch (err) {
    return handleError("POST /api/chat/sessions", err);
  }
}
