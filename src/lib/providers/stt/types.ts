export interface TranscriptionInput {
  /** Raw audio bytes. */
  audio: Buffer;
  /** Original filename, used by some providers for format hints. */
  filename: string;
  /** MIME type if known. */
  mimeType?: string;
  /** BCP-47 language hint (e.g. "en", "ru"). Optional. */
  language?: string;
  /** Override the provider's default model. */
  model?: string;
}

export interface TranscriptionResult {
  text: string;
  model: string;
  provider: string;
  /** Detected/used language if available. */
  language?: string;
  /** Approximate duration in seconds, if known. */
  durationSec?: number;
}

export interface STTProvider {
  readonly id: string;
  readonly defaultModel: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}
