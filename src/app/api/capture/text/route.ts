import { z } from "zod";
import { getCaptureService } from "@/lib/services/capture";
import { handleError } from "@/lib/api/responses";
import { sseResponse } from "@/lib/api/sse";
import { createLogger } from "@/lib/utils/logger";

export const runtime = "nodejs";

const log = createLogger("api.capture.text");

const BodySchema = z.object({
  text: z.string().min(1),
  /**
   * Optional voice context: when present the caller produced this text via
   * the transcribe-only endpoint and may have edited it before sending.
   * The original transcript is what gets persisted as the Voice Log; the
   * (possibly edited) `text` is what the capture pipeline classifies.
   */
  voice: z
    .object({
      transcript: z.string(),
      provider: z.string().min(1),
      model: z.string().min(1),
    })
    .optional(),
});

/**
 * Streams the capture pipeline as SSE frames:
 *
 *   event: classified      data: { type: "classified", intent: "..." }
 *   event: delta           data: { type: "delta", text: "..." }      (ask_vault_question only)
 *   event: result          data: { type: "result", result: CaptureActionResult }
 *   event: end             data: {}
 *
 * Every intent produces a single `result` frame; only `ask_vault_question`
 * produces per-token `delta` frames in between.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    log.warn("invalid body", {
      err: err instanceof Error ? err.message : String(err),
    });
    return handleError("POST /api/capture/text", err);
  }

  log.info("stream: open", {
    chars: body.text.length,
    fromVoice: Boolean(body.voice),
  });

  const capture = getCaptureService();

  // Persist the Voice Log NOW (before opening the SSE stream) so the
  // resulting vault path can be linked into the capture pipeline. If this
  // fails we still want the capture to proceed — the voice log is a nice
  // audit trail, not a hard prerequisite.
  let voiceLogPath: string | undefined;
  if (body.voice) {
    try {
      const persisted = await capture.saveVoiceLogFromTranscript(body.voice);
      voiceLogPath = persisted.path;
      log.info("stream: voice log persisted", { path: voiceLogPath });
    } catch (err) {
      log.warn("stream: failed to persist voice log, continuing without link", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return sseResponse(
    async function* () {
      let intent: string | undefined;
      let resultStatus: string | undefined;
      for await (const ev of capture.streamText({
        text: body.text,
        voiceLogPath,
      })) {
        if (ev.type === "classified") intent = ev.intent;
        if (ev.type === "result") resultStatus = ev.result.status;
        yield { event: ev.type, data: ev };
      }
      log.info("stream: done", { intent, status: resultStatus });
      yield { event: "end", data: {} };
    },
    { scope: "POST /api/capture/text" }
  );
}
