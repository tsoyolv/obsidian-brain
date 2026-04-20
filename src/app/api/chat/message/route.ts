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
 *
 * Two stream shapes share this endpoint, dispatched by the chat session's
 * `agentEnabled` flag (chosen on the server, not the client):
 *
 *   1. Plain chat (legacy): one or more `delta` events followed by an
 *      `end` event. Frame payload:
 *        { delta: string, done: boolean, messageId: string, usage? }
 *
 *   2. Agent chat: one event per orchestrator {@link AgentEvent}:
 *        event: tool_call          data: { type, callId, name, args }
 *        event: tool_result        data: { type, callId, name, result }
 *        event: message_delta      data: { type, text }
 *        event: needs_confirmation data: { type, token, toolName, args, preview }
 *        event: final              data: { type, message }
 *      Followed by a terminal `done` event carrying turn-level usage so the
 *      chat budget bar updates after agent turns too:
 *        event: done               data: { messageId, usage }
 *
 * Both shapes terminate with an `end` event.
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
  const session = await chat.getSession(body.sessionId);
  if (!session) {
    log.warn("unknown session", { sessionId: body.sessionId });
    return fail(`Unknown chat session: ${body.sessionId}`, 404);
  }

  log.info("stream: open", {
    sessionId: body.sessionId,
    userChars: body.content.length,
    agentEnabled: Boolean(session.agentEnabled),
  });

  return sseResponse(
    async function* () {
      let chunks = 0;
      let agentEvents = 0;
      for await (const frame of chat.streamUserMessage(body)) {
        if (frame.kind === "chat") {
          if (frame.delta) chunks += 1;
          yield {
            data: {
              delta: frame.delta,
              done: frame.done,
              messageId: frame.assistantMessageId,
              usage: frame.usage,
            },
          };
          if (frame.done) {
            log.info("stream: done (chat)", {
              sessionId: body.sessionId,
              chunks,
              sessionTotalTokens: frame.usage?.sessionTotalTokens,
              lastTurnTotalTokens: frame.usage?.lastTurnTotalTokens,
            });
            break;
          }
        } else if (frame.kind === "agent") {
          agentEvents += 1;
          yield { event: frame.event.type, data: frame.event };
        } else if (frame.kind === "agent_done") {
          log.info("stream: done (agent)", {
            sessionId: body.sessionId,
            agentEvents,
            sessionTotalTokens: frame.usage.sessionTotalTokens,
            lastTurnTotalTokens: frame.usage.lastTurnTotalTokens,
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
    { scope: "POST /api/chat/message" }
  );
}
