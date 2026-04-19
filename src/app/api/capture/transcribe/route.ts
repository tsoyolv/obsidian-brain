import { sttProviderFactory } from "@/lib/providers/stt";
import { fail, handleError, ok } from "@/lib/api/responses";
import { createLogger } from "@/lib/utils/logger";

export const runtime = "nodejs";

const log = createLogger("api.transcribe");

/** Max audio payload accepted; protects against accidental huge uploads. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Transcribe-only endpoint: takes an audio blob, returns the recognized text.
 * Does NOT persist anything to the vault — used by the UI to populate the
 * draft input so the user can edit before sending. The Voice Log file is
 * written later, only when the (possibly edited) text is actually submitted
 * via POST /api/capture/text.
 */
export async function POST(req: Request) {
  const t = log.time("POST /api/capture/transcribe");
  try {
    const form = await req.formData();
    const file = form.get("audio");
    const language = (form.get("language") as string | null) || undefined;

    if (!(file instanceof File)) {
      log.warn("transcribe: missing audio file in form-data");
      return fail("Missing 'audio' file in form-data", 400);
    }
    if (file.size === 0) {
      log.warn("transcribe: empty audio file", { filename: file.name });
      return fail("Empty audio file", 400);
    }
    if (file.size > MAX_AUDIO_BYTES) {
      log.warn("transcribe: audio too large", {
        bytes: file.size,
        limit: MAX_AUDIO_BYTES,
      });
      return fail(`Audio too large (max ${MAX_AUDIO_BYTES} bytes)`, 413);
    }

    log.info("transcribe: received", {
      filename: file.name,
      mimeType: file.type || undefined,
      bytes: file.size,
      language,
    });

    const stt = sttProviderFactory.get();
    const result = await stt.transcribe({
      audio: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "audio.webm",
      mimeType: file.type || undefined,
      language,
    });

    t.done("transcribe: done", {
      bytes: file.size,
      transcriptChars: result.text.length,
      provider: result.provider,
      model: result.model,
    });
    return ok({
      transcript: result.text,
      provider: result.provider,
      model: result.model,
    });
  } catch (err) {
    t.fail("transcribe: failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return handleError("POST /api/capture/transcribe", err);
  }
}
