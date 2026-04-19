import OpenAI, { toFile } from "openai";
import { createLogger } from "@/lib/utils/logger";
import type {
  STTProvider,
  TranscriptionInput,
  TranscriptionResult,
} from "./types";

const log = createLogger("openai-stt");

export interface OpenAISTTProviderOptions {
  apiKey: string;
  defaultModel: string;
}

export class OpenAISTTProvider implements STTProvider {
  readonly id = "openai";
  readonly defaultModel: string;
  private readonly client: OpenAI;

  constructor(opts: OpenAISTTProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.defaultModel = opts.defaultModel;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const model = input.model ?? this.defaultModel;
    const audioBytes = input.audio.length;
    const t = log.time("transcribe");
    log.debug("transcribe: start", {
      model,
      filename: input.filename,
      mimeType: input.mimeType,
      language: input.language,
      audioBytes,
    });

    const file = await toFile(input.audio, input.filename, {
      type: input.mimeType,
    });

    let result;
    try {
      result = await this.client.audio.transcriptions.create({
        model,
        file,
        language: input.language,
        response_format: "json",
      });
    } catch (err) {
      t.fail("transcribe: provider error", {
        model,
        filename: input.filename,
        audioBytes,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const text = result.text ?? "";
    t.done("transcribe", {
      model,
      audioBytes,
      transcriptChars: text.length,
      empty: text.length === 0,
      language: input.language,
    });

    return {
      text,
      model,
      provider: this.id,
      language: input.language,
    };
  }
}
