import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { fail, handleError } from "@/lib/api/responses";
import { sseResponse } from "@/lib/api/sse";
import { createLogger } from "@/lib/utils/logger";

export const runtime = "nodejs";

const log = createLogger("api.chat.message");

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
    log.warn("invalid body", {
      err: err instanceof Error ? err.message : String(err),
    });
    return handleError("POST /api/chat/message", err);
  }

  const chat = getChatService();
  if (!(await chat.getSession(body.sessionId))) {
    log.warn("unknown session", { sessionId: body.sessionId });
    return fail(`Unknown chat session: ${body.sessionId}`, 404);
  }

  log.info("stream: open", {
    sessionId: body.sessionId,
    userChars: body.content.length,
  });

  return sseResponse(
    async function* () {
      let chunks = 0;
      for await (const chunk of chat.streamUserMessage(body)) {
        if (chunk.delta) chunks += 1;
        yield {
          data: {
            delta: chunk.delta,
            done: chunk.done,
            messageId: chunk.assistantMessageId,
            usage: chunk.usage,
          },
        };
        if (chunk.done) {
          log.info("stream: done", {
            sessionId: body.sessionId,
            chunks,
            sessionTotalTokens: chunk.usage?.sessionTotalTokens,
            lastTurnTotalTokens: chunk.usage?.lastTurnTotalTokens,
          });
          break;
        }
      }
      yield { event: "end", data: {} };
    },
    { scope: "POST /api/chat/message" }
  );
}
