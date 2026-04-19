import OpenAI from "openai";
import { z } from "zod";
import { createLogger } from "@/lib/utils/logger";
import type {
  ChatInput,
  ChatResponse,
  IntentResult,
  LLMProvider,
  SummaryInput,
  SummaryResult,
} from "./types";

const log = createLogger("openai-llm");

export interface OpenAIChatProviderOptions {
  apiKey: string;
  defaultModel: string;
}

export class OpenAIChatProvider implements LLMProvider {
  readonly id = "openai";
  readonly defaultModel: string;
  private readonly client: OpenAI;

  constructor(opts: OpenAIChatProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.defaultModel = opts.defaultModel;
  }

  // ----- Generic chat -----

  async sendMessage(input: ChatInput): Promise<ChatResponse> {
    const model = input.model ?? this.defaultModel;
    const completion = await this.client.chat.completions.create({
      model,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens,
      response_format:
        input.responseFormat === "json_object"
          ? { type: "json_object" }
          : undefined,
    });

    const content = completion.choices[0]?.message?.content ?? "";
    return {
      content,
      model,
      provider: this.id,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *streamMessage(input: ChatInput): AsyncIterable<string> {
    const model = input.model ?? this.defaultModel;
    const stream = await this.client.chat.completions.create({
      model,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens,
      stream: true,
    });

    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  // ----- Intent classification -----

  async classifyIntent(input: string): Promise<IntentResult> {
    const response = await this.sendMessage({
      temperature: 0,
      responseFormat: "json_object",
      messages: [
        { role: "system", content: INTENT_SYSTEM_PROMPT },
        { role: "user", content: `User request:\n"""\n${input}\n"""` },
      ],
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch (err) {
      log.warn("classifyIntent: invalid JSON, falling back to unknown", {
        content: response.content,
        err: String(err),
      });
      return { intent: "unknown", text: input };
    }

    const safe = IntentSchema.safeParse(parsed);
    if (!safe.success) {
      log.warn("classifyIntent: schema validation failed", {
        issues: safe.error.issues,
      });
      return { intent: "unknown", text: input };
    }

    const result = safe.data;
    if (!result.text) result.text = input;
    return result;
  }

  // ----- Summarization -----

  async summarize(input: SummaryInput): Promise<SummaryResult> {
    if (input.messages.length === 0) {
      throw new Error("summarize requires at least one message");
    }

    const transcript = input.messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    const systemPrompt =
      SUMMARY_SYSTEM_PROMPT +
      (input.instructions
        ? `\n\nAdditional instructions: ${input.instructions}`
        : "");

    const response = await this.sendMessage({
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript },
      ],
    });

    const markdown = response.content.trim();
    return {
      markdown,
      actionItems: extractActionItems(markdown),
      provider: this.id,
      model: response.model,
    };
  }
}

// ---- Internal: prompts and parsers ----

const IntentSchema = z.object({
  intent: z.enum([
    "note",
    "create_task",
    "complete_task",
    "search",
    "ask_vault_question",
    "unknown",
  ]),
  text: z.string().default(""),
  title: z.string().optional(),
  taskText: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const INTENT_SYSTEM_PROMPT = [
  "You are an intent classifier for a personal Obsidian-backed assistant.",
  "Given a user's short request (typed or transcribed from voice),",
  "decide which single action best matches and extract the relevant fields.",
  "",
  "Possible intents:",
  '  - "note": user wants to save a thought, idea, or piece of content as a note.',
  '  - "create_task": user wants to add a TODO / action item.',
  '  - "complete_task": user wants to mark an existing task as done.',
  '  - "search": user wants to find existing notes or tasks by keyword.',
  '  - "ask_vault_question": user is asking a question that should be answered using vault content.',
  '  - "unknown": none of the above clearly applies.',
  "",
  "Respond with STRICT JSON only matching this schema:",
  "{",
  '  "intent": "note"|"create_task"|"complete_task"|"search"|"ask_vault_question"|"unknown",',
  '  "text": "<cleaned-up content of the user request, no command chrome>",',
  '  "title": "<short title hint, only when intent=note>",',
  '  "taskText": "<task content, only when intent=create_task or complete_task>",',
  '  "tags": ["optional","tags"]',
  "}",
].join("\n");

const SUMMARY_SYSTEM_PROMPT =
  "Summarize the following chat conversation. " +
  "Output two markdown sections: '## Summary' (3–6 concise bullet points) " +
  "and '## Action Items' (markdown checkboxes like '- [ ] do X', may be empty). " +
  "Do not add any other sections.";

/** Extracts the text of `- [ ]` / `- [x]` lines under (or after) the markdown body. */
function extractActionItems(markdown: string): string[] {
  const out: string[] = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[2]!.trim());
  }
  return out;
}
