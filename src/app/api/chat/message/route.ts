import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { fail, handleError } from "@/lib/api/responses";
import { sseResponse } from "@/lib/api/sse";

export const runtime = "nodejs";

const BodySchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
});

/**
 * Streams the assistant's response for a single user message via SSE.
 * Frame payload shape:
 *   { delta: string, done: boolean, messageId: string }
 * Followed by an `end` event when the stream completes.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return handleError("POST /api/chat/message", err);
  }

  const chat = getChatService();
  if (!chat.getSession(body.sessionId)) {
    return fail(`Unknown chat session: ${body.sessionId}`, 404);
  }

  return sseResponse(
    async function* () {
      for await (const chunk of chat.streamUserMessage(body)) {
        yield {
          data: {
            delta: chunk.delta,
            done: chunk.done,
            messageId: chunk.assistantMessageId,
          },
        };
        if (chunk.done) break;
      }
      yield { event: "end", data: {} };
    },
    { scope: "POST /api/chat/message" }
  );
}
