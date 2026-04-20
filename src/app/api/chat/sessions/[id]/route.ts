import { z } from "zod";
import { CHAT_TOKEN_LIMIT, getChatService } from "@/lib/services/chat";
import { fail, handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  agentEnabled: z.boolean().optional(),
});

/**
 * Returns a single chat session including the full message history rebuilt
 * from the vault transcript. The list endpoint omits messages to keep the
 * sidebar payload small; the UI calls this when the user opens a session.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chat = getChatService();
    const session = await chat.getSession(id);
    if (!session) return fail(`Unknown chat session: ${id}`, 404);
    return ok({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcriptPath: session.transcriptPath,
      messages: session.messages,
      agentEnabled: Boolean(session.agentEnabled),
      totalTokensUsed: session.totalTokensUsed ?? 0,
      nextPromptEstimateTokens: chat.estimateNextPromptTokens(session),
      tokenLimit: CHAT_TOKEN_LIMIT,
      chatSummary: session.chatSummary,
    });
  } catch (err) {
    return handleError("GET /api/chat/sessions/[id]", err);
  }
}

/**
 * Partial update for a chat session. Currently only `agentEnabled` is
 * mutable from the client; the toggle persists to the transcript
 * frontmatter so the choice survives restarts.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const raw = (await req.json().catch(() => ({}))) as unknown;
    const patch = PatchSchema.parse(raw ?? {});
    const chat = getChatService();
    const existing = await chat.getSession(id);
    if (!existing) return fail(`Unknown chat session: ${id}`, 404);
    let session = existing;
    if (patch.agentEnabled !== undefined) {
      session = await chat.setAgentEnabled(id, patch.agentEnabled);
    }
    return ok({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcriptPath: session.transcriptPath,
      messages: session.messages,
      agentEnabled: Boolean(session.agentEnabled),
      totalTokensUsed: session.totalTokensUsed ?? 0,
      nextPromptEstimateTokens: chat.estimateNextPromptTokens(session),
      tokenLimit: CHAT_TOKEN_LIMIT,
      chatSummary: session.chatSummary,
    });
  } catch (err) {
    return handleError("PATCH /api/chat/sessions/[id]", err);
  }
}
