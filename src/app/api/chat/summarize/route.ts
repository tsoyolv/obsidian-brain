import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";

const BodySchema = z.object({
  sessionId: z.string().min(1),
});

/**
 * Generate (or regenerate) the "summary of this chat" that's pinned to
 * the top of the chat UI. The summary is stored INLINE in the chat's
 * own transcript — specifically in its YAML frontmatter under
 * `chat_summary`, `chat_summary_action_items`, `chat_summary_generated_at`,
 * `chat_summary_provider`, `chat_summary_model`. No separate file under
 * `AI Summaries/` is created anymore, so the chat stays self-contained
 * on disk.
 *
 * Response shape: `{ chatSummary: ChatSummary }` (see `lib/types`).
 */
export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const result = await getChatService().summarize(body.sessionId);
    return ok(result);
  } catch (err) {
    return handleError("POST /api/chat/summarize", err);
  }
}
