import OpenAI, { toFile } from "openai";
import type {
  STTProvider,
  TranscriptionInput,
  TranscriptionResult,
} from "./types";

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
    const file = await toFile(input.audio, input.filename, {
      type: input.mimeType,
    });

    const result = await this.client.audio.transcriptions.create({
      model,
      file,
      language: input.language,
      response_format: "json",
    });

    return {
      text: result.text ?? "",
      model,
      provider: this.id,
      language: input.language,
    };
  }
}
