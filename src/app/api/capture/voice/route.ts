import { getCaptureService } from "@/lib/services/capture";
import { fail, handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Max audio payload accepted; protects against accidental huge uploads. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("audio");
    const language = (form.get("language") as string | null) || undefined;

    if (!(file instanceof File)) {
      return fail("Missing 'audio' file in form-data", 400);
    }
    if (file.size === 0) return fail("Empty audio file", 400);
    if (file.size > MAX_AUDIO_BYTES) {
      return fail(`Audio too large (max ${MAX_AUDIO_BYTES} bytes)`, 413);
    }

    const result = await getCaptureService().saveVoiceLog({
      audio: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "audio.webm",
      mimeType: file.type || undefined,
      language,
    });
    return ok(result);
  } catch (err) {
    return handleError("POST /api/capture/voice", err);
  }
}
