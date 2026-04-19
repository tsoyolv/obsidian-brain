import { sttProviderFactory } from "@/lib/providers/stt";
import { getVaultService, VAULT_FOLDERS } from "@/lib/services/vault";
import type { VoiceLogResult } from "@/lib/types";
import { compactLocalStamp, nowIso } from "@/lib/utils/id";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("captureService");

export interface CaptureVoiceInput {
  audio: Buffer;
  filename: string;
  mimeType?: string;
  language?: string;
}

/**
 * Persist a Voice Log using a transcript that has already been produced by
 * the STT provider (e.g. by the transcribe-only endpoint). This avoids
 * running transcription a second time when the UI already received the text
 * and showed it to the user for editing.
 */
export interface SaveVoiceLogFromTranscriptInput {
  transcript: string;
  provider: string;
  model: string;
}

/**
 * Capture-side helpers retained after the legacy intent-classification
 * pipeline was retired in favor of the agent orchestrator
 * (`/api/agent/capture`). The remaining surface is intentionally narrow:
 *
 *   - voice transcription → Voice Log persistence
 *   - durable raw capture log (one file per user input, written BEFORE
 *     any downstream processing so user input is never lost)
 *
 * The agent route consumes these directly; nothing else in the codebase
 * needs the old `handleText` / `streamText` / `execute` / intent-
 * classification surface, which lived here purely to bridge the now-
 * removed `/api/capture/text` endpoint.
 */
export interface CaptureService {
  ensureReady(): Promise<void>;
  /**
   * Transcribe audio and persist a raw voice log under `Voice Logs/`.
   * Classification / action execution is intentionally NOT performed here —
   * that belongs to a higher-level pipeline that consumes voice logs.
   */
  saveVoiceLog(input: CaptureVoiceInput): Promise<VoiceLogResult>;
  /**
   * Persist a Voice Log entry using an already-produced transcript.
   * Used by the two-step UI flow (transcribe → edit → send) so we don't
   * re-run the STT provider with the same audio.
   */
  saveVoiceLogFromTranscript(
    input: SaveVoiceLogFromTranscriptInput
  ): Promise<VoiceLogResult>;
  /**
   * Persist a raw capture log entry under `Capture Logs/`. This is the
   * durable record we save BEFORE any agent dispatch so the user's input
   * is never lost even if downstream processing fails.
   *
   * Returns the vault-relative path of the created log file.
   */
  saveRawCaptureLog(input: {
    text: string;
    source: "text" | "voice";
    voiceLogPath?: string;
  }): Promise<string>;
}

class CaptureServiceImpl implements CaptureService {
  private readonly vault = getVaultService();

  async ensureReady(): Promise<void> {
    await this.vault.ensureFolders();
  }

  async saveVoiceLog(input: CaptureVoiceInput): Promise<VoiceLogResult> {
    const stt = sttProviderFactory.get();
    const t = log.time("saveVoiceLog");
    log.debug("saveVoiceLog: start", {
      filename: input.filename,
      mimeType: input.mimeType,
      audioBytes: input.audio.length,
      language: input.language,
    });

    let result;
    try {
      result = await stt.transcribe({
        audio: input.audio,
        filename: input.filename,
        mimeType: input.mimeType,
        language: input.language,
      });
    } catch (err) {
      t.fail("saveVoiceLog: transcribe failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const persisted = await this.persistVoiceLog({
      transcript: result.text,
      provider: result.provider,
      model: result.model,
    });

    t.done("saveVoiceLog", {
      path: persisted.path,
      transcriptChars: result.text.length,
      empty: result.text.length === 0,
      provider: result.provider,
      model: result.model,
    });
    return persisted;
  }

  async saveVoiceLogFromTranscript(
    input: SaveVoiceLogFromTranscriptInput
  ): Promise<VoiceLogResult> {
    const t = log.time("saveVoiceLogFromTranscript");
    log.debug("saveVoiceLogFromTranscript: start", {
      transcriptChars: input.transcript.length,
      provider: input.provider,
      model: input.model,
    });
    const persisted = await this.persistVoiceLog(input);
    t.done("saveVoiceLogFromTranscript", {
      path: persisted.path,
      transcriptChars: input.transcript.length,
    });
    return persisted;
  }

  private async persistVoiceLog(args: {
    transcript: string;
    provider: string;
    model: string;
  }): Promise<VoiceLogResult> {
    await this.ensureReady();
    const stamp = compactLocalStamp();
    const created = await this.vault.createNote({
      folder: VAULT_FOLDERS.voiceLogs,
      title: `voice ${stamp}`,
      content: args.transcript || "_(empty transcription)_",
      metadata: {
        type: "voice-log",
        created: nowIso(),
        provider: args.provider,
        model: args.model,
        status: "raw",
      },
      uniqueOnConflict: true,
    });
    return {
      path: created.path,
      transcript: args.transcript,
      provider: args.provider,
      model: args.model,
    };
  }

  async saveRawCaptureLog(args: {
    text: string;
    source: "text" | "voice";
    voiceLogPath?: string;
  }): Promise<string> {
    const stamp = compactLocalStamp();
    const created = await this.vault.createNote({
      folder: VAULT_FOLDERS.captureLogs,
      title: `capture ${stamp}`,
      content: args.text,
      metadata: {
        type: "capture-log",
        created: nowIso(),
        source: args.source,
        status: "raw",
        ...(args.voiceLogPath ? { voice_log: args.voiceLogPath } : {}),
      },
      uniqueOnConflict: true,
    });
    log.debug("saveRawCaptureLog", { path: created.path });
    return created.path;
  }
}

let cached: CaptureService | null = null;

export function getCaptureService(): CaptureService {
  if (cached) return cached;
  cached = new CaptureServiceImpl();
  return cached;
}

export function _resetCaptureServiceCache(): void {
  cached = null;
}
