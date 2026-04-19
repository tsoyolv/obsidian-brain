import { z } from "zod";
import {
  AGENT_TOKEN_LIMIT,
  confirmTurn,
  estimateAgentNextPromptTokens,
  runTurn,
} from "@/lib/agent/orchestrator";
import type { AgentEvent } from "@/lib/agent/orchestrator";
import { getAgentSessionStore } from "@/lib/agent/session";
import { sseResponse } from "@/lib/api/sse";
import { handleError } from "@/lib/api/responses";
import { getCaptureService } from "@/lib/services/capture";
import { createLogger } from "@/lib/utils/logger";
import { estimateTokens } from "@/lib/utils/tokens";

export const runtime = "nodejs";

const log = createLogger("api.agent.capture");

const VoiceSchema = z.object({
  transcript: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
});

/**
 * Three distinct request shapes go through this single endpoint:
 *
 *   1. User turn:        { sessionId, text, voice? }
 *   2. Confirmation:     { sessionId, confirm: true, token }
 *   3. Cancellation:     { sessionId, cancel: true, token }
 *
 * The discriminator is the presence of the `confirm` / `cancel` field; we
 * inspect that before parsing so zod gives clean error messages either
 * way. Cancellation is server-acknowledged (rather than purely client-
 * side) so the pending confirmation is removed from session state and
 * doesn't leak into the next turn's LLM context.
 */
const UserBodySchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  voice: VoiceSchema.optional(),
});

const ConfirmBodySchema = z.object({
  sessionId: z.string().min(1),
  confirm: z.literal(true),
  token: z.string().min(1),
});

const CancelBodySchema = z.object({
  sessionId: z.string().min(1),
  cancel: z.literal(true),
  token: z.string().min(1),
});

/**
 * SSE-streamed agent capture endpoint.
 *
 * Frame shape (one event per yielded {@link AgentEvent}):
 *   event: tool_call          data: { type, callId, name, args }
 *   event: tool_result        data: { type, callId, name, result }
 *   event: message_delta      data: { type, text }
 *   event: needs_confirmation data: { type, token, toolName, args, preview }
 *   event: final              data: { type, message }
 *   event: done               data: { usage }     // turn token accounting
 *   event: end                data: {}
 *
 * Vault-safety invariants are unchanged: any confirmation-gated tool
 * (`read_confirmed_file`, `run_file_task`, `soft_delete`) yields
 * `needs_confirmation` and STOPS without running. The caller must POST a
 * confirmation request with the issued token to actually run it.
 */
export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch (err) {
    return handleError("POST /api/agent/capture", err);
  }

  // Cancellation: clear the matching pending confirmation (if any) and
  // return a single `final` event. Idempotent — a stale token is treated
  // as already-cancelled, not as an error.
  if (
    payload &&
    typeof payload === "object" &&
    "cancel" in (payload as Record<string, unknown>)
  ) {
    let body: z.infer<typeof CancelBodySchema>;
    try {
      body = CancelBodySchema.parse(payload);
    } catch (err) {
      return handleError("POST /api/agent/capture (cancel)", err);
    }

    const sessions = getAgentSessionStore();
    const session = sessions.get(body.sessionId);
    const pending = session?.pendingConfirmation;
    const matched = Boolean(pending && pending.token === body.token);
    if (matched) {
      sessions.setPendingConfirmation(body.sessionId, undefined);
    }
    log.info("stream: open (cancel)", {
      sessionId: body.sessionId,
      token: body.token,
      matched,
    });

    return sseResponse(
      async function* () {
        yield {
          event: "final",
          data: {
            type: "final",
            message: matched ? "Cancelled." : "(nothing pending to cancel)",
          },
        };
        yield { event: "end", data: {} };
      },
      { scope: "POST /api/agent/capture (cancel)" }
    );
  }

  // Confirmation flow takes precedence — the body deliberately doesn't
  // carry user text, so don't try the user-turn schema first.
  if (
    payload &&
    typeof payload === "object" &&
    "confirm" in (payload as Record<string, unknown>)
  ) {
    let body: z.infer<typeof ConfirmBodySchema>;
    try {
      body = ConfirmBodySchema.parse(payload);
    } catch (err) {
      return handleError("POST /api/agent/capture (confirm)", err);
    }

    log.info("stream: open (confirm)", {
      sessionId: body.sessionId,
      token: body.token,
    });

    return sseResponse(
      async function* () {
        let assistantBuffer = "";
        for await (const ev of confirmTurn({
          sessionId: body.sessionId,
          token: body.token,
        })) {
          if (ev.type === "message_delta") assistantBuffer += ev.text;
          else if (ev.type === "final" && !assistantBuffer.trim()) {
            assistantBuffer = ev.message;
          }
          yield { event: ev.type, data: ev };
        }
        const usage = bumpTurnUsage(body.sessionId, assistantBuffer);
        yield { event: "done", data: { usage } };
        yield { event: "end", data: {} };
      },
      { scope: "POST /api/agent/capture (confirm)" }
    );
  }

  let body: z.infer<typeof UserBodySchema>;
  try {
    body = UserBodySchema.parse(payload);
  } catch (err) {
    return handleError("POST /api/agent/capture", err);
  }

  log.info("stream: open", {
    sessionId: body.sessionId,
    chars: body.text.length,
    fromVoice: Boolean(body.voice),
  });

  const capture = getCaptureService();

  // Persist the Voice Log NOW (before opening the SSE stream) so the
  // resulting vault path can be linked into the raw capture log. Same
  // best-effort policy as the legacy /api/capture/text route — the voice
  // log is an audit trail, not a hard prerequisite.
  let voiceLogPath: string | undefined;
  if (body.voice) {
    try {
      const persisted = await capture.saveVoiceLogFromTranscript(body.voice);
      voiceLogPath = persisted.path;
      log.info("stream: voice log persisted", { path: voiceLogPath });
    } catch (err) {
      log.warn(
        "stream: failed to persist voice log, continuing without link",
        {
          err: err instanceof Error ? err.message : String(err),
        }
      );
    }
  }

  // Persist the raw capture log up-front so the user's input is durable
  // regardless of whether the agent loop succeeds, fails, or times out.
  // Mirrors the invariant captureService.handleText / streamText enforce.
  try {
    await capture.saveRawCaptureLog({
      text: body.text,
      source: voiceLogPath ? "voice" : "text",
      voiceLogPath,
    });
  } catch (err) {
    log.warn("stream: failed to persist raw capture log, continuing", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return sseResponse(
    async function* () {
      let lastType: AgentEvent["type"] | undefined;
      let assistantBuffer = "";
      for await (const ev of runTurn({
        sessionId: body.sessionId,
        userText: body.text,
      })) {
        lastType = ev.type;
        if (ev.type === "message_delta") assistantBuffer += ev.text;
        else if (ev.type === "final" && !assistantBuffer.trim()) {
          assistantBuffer = ev.message;
        }
        yield { event: ev.type, data: ev };
      }
      const usage = bumpTurnUsage(body.sessionId, assistantBuffer);
      log.info("stream: done", {
        sessionId: body.sessionId,
        lastType,
        sessionTotalTokens: usage.sessionTotalTokens,
        lastTurnTotalTokens: usage.lastTurnTotalTokens,
      });
      yield { event: "done", data: { usage } };
      yield { event: "end", data: {} };
    },
    { scope: "POST /api/agent/capture" }
  );
}

/**
 * Bump the agent session's cumulative token counter for a just-finished
 * turn and return a chat-shaped {@link SessionTokenUsage} payload so the
 * Capture UI can render the same context-budget bar as long-form chats.
 *
 * Estimate (not exact) — the orchestrator may make multiple LLM calls per
 * turn (tool loops, final summary), so we approximate by:
 *   - lastTurnPromptTokens   = next-turn prompt estimate AFTER appending
 *                              this turn's messages (close to the prompt
 *                              size the FINAL LLM call in this turn used)
 *   - lastTurnCompletionTokens = estimated tokens in the assistant buffer
 *   - sessionTotalTokens      = cumulative bump
 */
function bumpTurnUsage(sessionId: string, assistantBuffer: string) {
  const sessions = getAgentSessionStore();
  const promptEstimate = estimateAgentNextPromptTokens(sessionId);
  const completionEstimate = estimateTokens(assistantBuffer);
  const turnTokens = promptEstimate + completionEstimate;
  const previous = sessions.get(sessionId)?.totalTokensUsed ?? 0;
  const sessionTotalTokens = previous + turnTokens;
  sessions.setTotalTokensUsed(sessionId, sessionTotalTokens);
  return {
    lastTurnTotalTokens: turnTokens,
    lastTurnPromptTokens: promptEstimate,
    lastTurnCompletionTokens: completionEstimate,
    sessionTotalTokens,
    nextPromptEstimateTokens: promptEstimate,
    limitTokens: AGENT_TOKEN_LIMIT,
  };
}
