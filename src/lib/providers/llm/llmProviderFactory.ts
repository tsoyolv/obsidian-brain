import { getConfig } from "@/lib/config";
import { OpenAIChatProvider } from "./openai";
import type { LLMProvider } from "./types";

/**
 * Constructs the configured LLM provider exactly once and caches the instance.
 * Adding a new provider only requires extending the switch — services that
 * depend on `LLMProvider` need no changes.
 */

let cached: LLMProvider | null = null;

function build(): LLMProvider {
  const cfg = getConfig();

  switch (cfg.llmProvider) {
    case "openai": {
      if (!cfg.openai.apiKey) {
        throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
      }
      return new OpenAIChatProvider({
        apiKey: cfg.openai.apiKey,
        defaultModel: cfg.openai.chatModel,
      });
    }
    default: {
      const _exhaustive: never = cfg.llmProvider;
      throw new Error(`Unsupported LLM provider: ${_exhaustive as string}`);
    }
  }
}

export const llmProviderFactory = Object.freeze({
  /** Returns the configured singleton LLM provider. */
  get(): LLMProvider {
    if (!cached) cached = build();
    return cached;
  },
  /** Drops the cached instance (tests / hot reload). */
  reset(): void {
    cached = null;
  },
});

/** Convenience accessor — equivalent to `llmProviderFactory.get()`. */
export function getLLMProvider(): LLMProvider {
  return llmProviderFactory.get();
}
