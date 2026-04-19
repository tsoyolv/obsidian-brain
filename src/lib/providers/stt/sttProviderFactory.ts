import { getConfig } from "@/lib/config";
import { OpenAISTTProvider } from "./openai";
import type { STTProvider } from "./types";

let cached: STTProvider | null = null;

function build(): STTProvider {
  const cfg = getConfig();

  switch (cfg.sttProvider) {
    case "openai": {
      if (!cfg.openai.apiKey) {
        throw new Error("OPENAI_API_KEY is required when STT_PROVIDER=openai");
      }
      return new OpenAISTTProvider({
        apiKey: cfg.openai.apiKey,
        defaultModel: cfg.openai.sttModel,
      });
    }
    default: {
      const _exhaustive: never = cfg.sttProvider;
      throw new Error(`Unsupported STT provider: ${_exhaustive as string}`);
    }
  }
}

export const sttProviderFactory = Object.freeze({
  /** Returns the configured singleton STT provider. */
  get(): STTProvider {
    if (!cached) cached = build();
    return cached;
  },
  /** Drops the cached instance (tests / hot reload). */
  reset(): void {
    cached = null;
  },
});

/** Convenience accessor — equivalent to `sttProviderFactory.get()`. */
export function getSTTProvider(): STTProvider {
  return sttProviderFactory.get();
}
