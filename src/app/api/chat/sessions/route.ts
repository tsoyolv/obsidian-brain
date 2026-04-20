import { z } from "zod";
import { CHAT_TOKEN_LIMIT, getChatService } from "@/lib/services/chat";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().optional(),
  systemPrompt: z.string().optional(),
  agentEnabled: z.boolean().optional(),
  webSearchEnabled: z.boolean().optional(),
});

export async function GET() {
  try {
    const chat = getChatService();
    const all = await chat.listSessions();
    const sessions = all.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      transcriptPath: s.transcriptPath,
      agentEnabled: Boolean(s.agentEnabled),
      webSearchEnabled: s.webSearchEnabled !== false,
      totalTokensUsed: s.totalTokensUsed ?? 0,
      nextPromptEstimateTokens: chat.estimateNextPromptTokens(s),
    }));
    return ok({ sessions, tokenLimit: CHAT_TOKEN_LIMIT });
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
    const chat = getChatService();
    const session = await chat.createSession(input);
    return ok({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcriptPath: session.transcriptPath,
      messages: session.messages,
      agentEnabled: Boolean(session.agentEnabled),
      webSearchEnabled: session.webSearchEnabled !== false,
      totalTokensUsed: session.totalTokensUsed ?? 0,
      nextPromptEstimateTokens: chat.estimateNextPromptTokens(session),
      tokenLimit: CHAT_TOKEN_LIMIT,
    });
  } catch (err) {
    return handleError("POST /api/chat/sessions", err);
  }
}
