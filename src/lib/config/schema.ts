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
  OPENAI_MODEL_CHAT_FAST: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_CHAT_STANDARD: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_CHAT_REASONING: z.string().default("gpt-5.2"),
  OPENAI_MODEL_ROUTER: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_STT: z.string().default("whisper-1"),
  MODEL_ROUTING_ENABLED: z.coerce.boolean().default(true),
  MODEL_DYNAMIC_ESCALATION_ENABLED: z.coerce.boolean().default(true),
  MODEL_ROUTING_STICKY_TURNS: z.coerce.number().int().min(0).max(20).default(3),
  MODEL_ROUTING_HIGH_PROMPT_TOKENS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(500000)
    .default(40000),
  TAVILY_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
