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
    chatFastModel: string;
    chatStandardModel: string;
    chatReasoningModel: string;
    routerModel: string;
    sttModel: string;
  };
  modelRouting: {
    enabled: boolean;
    dynamicEscalationEnabled: boolean;
    stickyTurns: number;
    highPromptTokens: number;
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
    OPENAI_MODEL_CHAT_FAST: process.env.OPENAI_MODEL_CHAT_FAST,
    OPENAI_MODEL_CHAT_STANDARD: process.env.OPENAI_MODEL_CHAT_STANDARD,
    OPENAI_MODEL_CHAT_REASONING: process.env.OPENAI_MODEL_CHAT_REASONING,
    OPENAI_MODEL_ROUTER: process.env.OPENAI_MODEL_ROUTER,
    OPENAI_MODEL_STT: process.env.OPENAI_MODEL_STT,
    MODEL_ROUTING_ENABLED: process.env.MODEL_ROUTING_ENABLED,
    MODEL_DYNAMIC_ESCALATION_ENABLED:
      process.env.MODEL_DYNAMIC_ESCALATION_ENABLED,
    MODEL_ROUTING_STICKY_TURNS: process.env.MODEL_ROUTING_STICKY_TURNS,
    MODEL_ROUTING_HIGH_PROMPT_TOKENS:
      process.env.MODEL_ROUTING_HIGH_PROMPT_TOKENS,
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
      chatFastModel: env.OPENAI_MODEL_CHAT_FAST,
      chatStandardModel: env.OPENAI_MODEL_CHAT_STANDARD,
      chatReasoningModel: env.OPENAI_MODEL_CHAT_REASONING,
      routerModel: env.OPENAI_MODEL_ROUTER,
      sttModel: env.OPENAI_MODEL_STT,
    },
    modelRouting: {
      enabled: env.MODEL_ROUTING_ENABLED,
      dynamicEscalationEnabled: env.MODEL_DYNAMIC_ESCALATION_ENABLED,
      stickyTurns: env.MODEL_ROUTING_STICKY_TURNS,
      highPromptTokens: env.MODEL_ROUTING_HIGH_PROMPT_TOKENS,
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
