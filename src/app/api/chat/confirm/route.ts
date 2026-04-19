import { z } from "zod";
import { getChatService } from "@/lib/services/chat";
import { handleError } from "@/lib/api/responses";
import { sseResponse } from "@/lib/api/sse";
import { createLogger } from "@/lib/utils/logger";

export const runtime = "nodejs";

const log = createLogger("api.chat.confirm");

const BodySchema = z.object({
  sessionId: z.string().min(1),
  token: z.string().min(1),
});

/**
 * SSE-streamed confirmation endpoint for agent-enabled chat sessions.
 *
 * Mirrors `/api/agent/capture` (confirm shape) so the frontend can route
 * confirmation acknowledgements through a single helper. Yields one event
 * per orchestrator {@link AgentEvent} plus a terminal `done` event with
 * the per-turn usage so the chat budget stays in sync after gated tools
 * complete.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return handleError("POST /api/chat/confirm", err);
  }

  log.info("stream: open (confirm)", {
    sessionId: body.sessionId,
    token: body.token,
  });

  const chat = getChatService();
  return sseResponse(
    async function* () {
      let agentEvents = 0;
      for await (const frame of chat.confirmAgentTurn(body)) {
        if (frame.kind === "agent") {
          agentEvents += 1;
          yield { event: frame.event.type, data: frame.event };
        } else {
          log.info("stream: done (confirm)", {
            sessionId: body.sessionId,
            agentEvents,
          });
          yield {
            event: "done",
            data: {
              messageId: frame.assistantMessageId,
              usage: frame.usage,
            },
          };
        }
      }
      yield { event: "end", data: {} };
    },
    { scope: "POST /api/chat/confirm" }
  );
}
