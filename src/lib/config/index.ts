import {
  EnvSchema,
  type LLMProviderId,
  type STTProviderId,
  type WebSearchProviderId,
} from "./schema";

/**
 * Typed runtime configuration loaded from environment variables.
 *
 * This module is the ONLY place in the codebase that reads `process.env`.
 * Adding future providers (anthropic, deepseek, local-whisper, ...) requires
 * extending `schema.ts` and the relevant provider factory — never the
 * services that consume this config.
 */

export type { LLMProviderId, STTProviderId, WebSearchProviderId };

export interface AppConfig {
  vaultPath: string;
  llmProvider: LLMProviderId;
  sttProvider: STTProviderId;
  webSearchProvider: WebSearchProviderId;
  openai: {
    apiKey: string | undefined;
    chatModel: string;
    chatNamingModel: string;
    sttModel: string;
  };
  tavily: {
    apiKey: string | undefined;
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse({
    OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    STT_PROVIDER: process.env.STT_PROVIDER,
    WEB_SEARCH_PROVIDER: process.env.WEB_SEARCH_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL_CHAT: process.env.OPENAI_MODEL_CHAT,
    OPENAI_MODEL_CHAT_NAMING: process.env.OPENAI_MODEL_CHAT_NAMING,
    OPENAI_MODEL_STT: process.env.OPENAI_MODEL_STT,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }

  const env = parsed.data;
  cached = {
    vaultPath: env.OBSIDIAN_VAULT_PATH,
    llmProvider: env.LLM_PROVIDER,
    sttProvider: env.STT_PROVIDER,
    webSearchProvider: env.WEB_SEARCH_PROVIDER,
    openai: {
      apiKey: env.OPENAI_API_KEY,
      chatModel: env.OPENAI_MODEL_CHAT,
      chatNamingModel: env.OPENAI_MODEL_CHAT_NAMING,
      sttModel: env.OPENAI_MODEL_STT,
    },
    tavily: {
      apiKey: env.TAVILY_API_KEY,
    },
  };
  return cached;
}

export interface RuntimeConfigSnapshot {
  llmProvider: LLMProviderId;
  sttProvider: STTProviderId;
  chatModel: string;
  sttModel: string;
  vaultConfigured: boolean;
  /** True if the provider's required API key is set (does not validate it). */
  apiKeyConfigured: boolean;
}

/**
 * Sanitized snapshot safe to expose to the UI. Never returns secrets and
 * never instantiates providers (so the endpoint stays healthy even when
 * keys are missing — the caller can decide how to surface that).
 */
export function getRuntimeConfig(): RuntimeConfigSnapshot {
  const c = getConfig();
  return {
    llmProvider: c.llmProvider,
    sttProvider: c.sttProvider,
    chatModel: c.openai.chatModel,
    sttModel: c.openai.sttModel,
    vaultConfigured: Boolean(c.vaultPath),
    apiKeyConfigured: Boolean(c.openai.apiKey),
  };
}

/** For tests / hot-reload safety. */
export function _resetConfigCache(): void {
  cached = null;
}
