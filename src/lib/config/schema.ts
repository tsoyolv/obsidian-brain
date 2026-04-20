import { z } from "zod";

/**
 * Zod schemas for environment variables. Kept separate from `index.ts` so
 * the validation rules can evolve without touching the public config API.
 */

export const LLMProviderSchema = z.enum(["openai"]);
export const STTProviderSchema = z.enum(["openai"]);
export const WebSearchProviderSchema = z.enum(["tavily"]);

export type LLMProviderId = z.infer<typeof LLMProviderSchema>;
export type STTProviderId = z.infer<typeof STTProviderSchema>;
export type WebSearchProviderId = z.infer<typeof WebSearchProviderSchema>;

export const EnvSchema = z.object({
  OBSIDIAN_VAULT_PATH: z
    .string({ required_error: "OBSIDIAN_VAULT_PATH is required" })
    .min(1, "OBSIDIAN_VAULT_PATH must not be empty"),
  LLM_PROVIDER: LLMProviderSchema.default("openai"),
  STT_PROVIDER: STTProviderSchema.default("openai"),
  WEB_SEARCH_PROVIDER: WebSearchProviderSchema.default("tavily"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL_CHAT: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_CHAT_NAMING: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_STT: z.string().default("whisper-1"),
  TAVILY_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
