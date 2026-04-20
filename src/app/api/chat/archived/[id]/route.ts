import { CHAT_TOKEN_LIMIT, getChatService } from "@/lib/services/chat";
import { fail, handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chat = getChatService();
    const session = await chat.getArchivedSession(id);
    if (!session) return fail(`Unknown archived chat session: ${id}`, 404);
    return ok({
      ...chat.getSessionModelInfo(session),
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcriptPath: session.transcriptPath,
      messages: session.messages,
      agentEnabled: false,
      webSearchEnabled: false,
      totalTokensUsed: session.totalTokensUsed ?? 0,
      nextPromptEstimateTokens: chat.estimateNextPromptTokens(session),
      tokenLimit: CHAT_TOKEN_LIMIT,
      chatSummary: session.chatSummary,
      archived: true,
    });
  } catch (err) {
    return handleError("GET /api/chat/archived/[id]", err);
  }
}
