import OpenAI from "openai";
import { z } from "zod";
import { createLogger } from "@/lib/utils/logger";
import type {
  ChatInput,
  ChatResponse,
  FileRankInput,
  FileRankResult,
  FileTaskInput,
  FileTaskKind,
  FileTaskOutput,
  LLMProvider,
  StreamDelta,
  SummaryInput,
  SummaryResult,
  ToolChatFrame,
  ToolDescriptor,
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
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *streamMessage(input: ChatInput): AsyncIterable<StreamDelta> {
    const model = input.model ?? this.defaultModel;
    const debug = process.env.DEBUG_STREAM === "1";
    // `include_usage` tells OpenAI to emit one extra final chunk with
    // prompt_tokens / completion_tokens populated. Without it, streamed
    // responses carry no usage at all and we'd need a separate estimator.
    const stream = await this.client.chat.completions.create({
      model,
      messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    let chunkIndex = 0;
    const startedAt = Date.now();
    let finalUsage: StreamDelta["usage"];
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (part.usage) {
        // OpenAI returns `prompt_tokens_details.cached_tokens` whenever
        // automatic prompt caching kicks in (stable prefix ≥ 1024 tokens).
        // The field isn't always present on the SDK type, hence the cast.
        const details = (
          part.usage as unknown as {
            prompt_tokens_details?: { cached_tokens?: number };
          }
        ).prompt_tokens_details;
        finalUsage = {
          promptTokens: part.usage.prompt_tokens,
          completionTokens: part.usage.completion_tokens,
          totalTokens: part.usage.total_tokens,
          cachedPromptTokens: details?.cached_tokens,
        };
      }
      if (delta) {
        if (debug) {
          const dt = Date.now() - startedAt;
          log.debug(
            `chunk #${chunkIndex} +${dt}ms ${JSON.stringify(delta)}`
          );
        }
        chunkIndex += 1;
        yield { delta };
      }
    }
    // Emit a terminal frame carrying real token usage (if the provider
    // delivered it). Deltas are empty so consumers that only append
    // `delta` to a buffer won't be disturbed.
    yield { delta: "", usage: finalUsage };
    if (debug) {
      log.debug(
        `stream done: ${chunkIndex} chunks in ${Date.now() - startedAt}ms`,
        { usage: finalUsage }
      );
    }
  }

  // ----- Tool-calling chat -----

  async *chatWithTools(
    input: ChatInput,
    tools: ToolDescriptor[]
  ): AsyncIterable<ToolChatFrame> {
    const model = input.model ?? this.defaultModel;
    const oaiTools = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model,
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: input.temperature,
      max_tokens: input.maxOutputTokens,
      tools: oaiTools.length > 0 ? oaiTools : undefined,
      // Let the model choose freely between text and tool call. The
      // orchestrator surfaces whichever path the model picks.
      tool_choice: oaiTools.length > 0 ? "auto" : undefined,
      stream: true,
      stream_options: { include_usage: true },
    });

    // Tool-call args arrive as JSON streamed across many `delta.tool_calls`
    // chunks. We accumulate per-index buffers and flush them after the
    // stream completes (single tool call expected; the orchestrator uses
    // only the first one anyway).
    const toolBuffers = new Map<
      number,
      { name: string; argsJson: string }
    >();
    let finalUsage: ToolChatFrame["usage"];

    for await (const part of stream) {
      const choice = part.choices[0];
      if (part.usage) {
        const details = (
          part.usage as unknown as {
            prompt_tokens_details?: { cached_tokens?: number };
          }
        ).prompt_tokens_details;
        finalUsage = {
          promptTokens: part.usage.prompt_tokens,
          completionTokens: part.usage.completion_tokens,
          totalTokens: part.usage.total_tokens,
          cachedPromptTokens: details?.cached_tokens,
        };
      }
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: "message_delta", delta: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolBuffers.get(idx) ?? { name: "", argsJson: "" };
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
          toolBuffers.set(idx, existing);
        }
      }
    }

    // Emit accumulated tool calls in index order. Args parse failures are
    // surfaced as `args: {}` so the orchestrator can run zod validation
    // and report a clean error back to the model.
    const indices = [...toolBuffers.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const buf = toolBuffers.get(idx)!;
      if (!buf.name) continue;
      let args: unknown = {};
      const trimmed = buf.argsJson.trim();
      if (trimmed) {
        try {
          args = JSON.parse(trimmed);
        } catch (err) {
          log.warn("chatWithTools: invalid tool args JSON", {
            name: buf.name,
            raw: buf.argsJson,
            err: String(err),
          });
        }
      }
      yield { type: "tool_call", toolCall: { name: buf.name, args } };
    }

    yield { type: "done", usage: finalUsage };
  }

  // ----- File candidate ranking -----

  async rankFileCandidates(input: FileRankInput): Promise<FileRankResult> {
    if (input.candidates.length === 0) return { bestPath: null };
    if (input.candidates.length === 1) {
      return { bestPath: input.candidates[0]!.path };
    }

    const userPayload = JSON.stringify(
      {
        query: input.query,
        task: input.task ?? null,
        candidates: input.candidates.map((c) => ({
          path: c.path,
          title: c.title,
        })),
      },
      null,
      2
    );

    const response = await this.sendMessage({
      temperature: 0,
      responseFormat: "json_object",
      messages: [
        { role: "system", content: FILE_RANK_SYSTEM_PROMPT },
        { role: "user", content: userPayload },
      ],
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.content);
    } catch (err) {
      log.warn("rankFileCandidates: invalid JSON, falling back to top score", {
        content: response.content,
        err: String(err),
      });
      return { bestPath: input.candidates[0]!.path };
    }

    const safe = FileRankSchema.safeParse(parsed);
    if (!safe.success) {
      log.warn("rankFileCandidates: schema validation failed", {
        issues: safe.error.issues,
        raw: response.content,
      });
      return { bestPath: input.candidates[0]!.path };
    }

    // Trust nothing the model returns: enforce that bestPath is one of the
    // candidates we sent, otherwise treat as "no pick" so the caller can
    // fall back to its own ordering.
    const allowed = new Set(input.candidates.map((c) => c.path));
    if (safe.data.bestPath && !allowed.has(safe.data.bestPath)) {
      log.warn("rankFileCandidates: model returned unknown path", {
        bestPath: safe.data.bestPath,
      });
      return { bestPath: null, reason: safe.data.reason };
    }

    return {
      bestPath: safe.data.bestPath,
      reason: safe.data.reason,
    };
  }

  // ----- File task execution -----

  async runFileTask(input: FileTaskInput): Promise<FileTaskOutput> {
    const instruction = input.instruction?.trim();
    if (TASK_REQUIRES_INSTRUCTION.has(input.kind) && !instruction) {
      throw new Error(`File task "${input.kind}" requires an instruction`);
    }

    const systemPrompt = FILE_TASK_SYSTEM_PROMPTS[input.kind];
    const userPrompt = buildFileTaskUserPrompt({
      title: input.title,
      content: input.content,
      truncated: !!input.truncated,
      instruction,
    });

    const response = await this.sendMessage({
      // Slightly creative for summaries / answers; deterministic for the
      // structured `generate_tasks` output so checklist parsing is stable.
      temperature: input.kind === "generate_tasks" ? 0 : 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const markdown = response.content.trim();
    const tasks =
      input.kind === "generate_tasks" ? extractActionItems(markdown) : [];
    return { markdown, tasks };
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
      usage: response.usage,
    };
  }
}

// ---- Internal: prompts and parsers ----

const FileRankSchema = z.object({
  bestPath: z.string().min(1).nullable(),
  reason: z.string().optional(),
});

const FILE_RANK_SYSTEM_PROMPT = [
  "You rank vault file candidates against a user's lookup query and an",
  "optional follow-up task. The user has NOT confirmed any read yet — you",
  "only see file paths and titles, never any file body content.",
  "",
  "Pick the SINGLE candidate whose `title` and `path` best match the user's",
  "intent. Prefer:",
  "  * exact / phrase matches in the title over scattered token matches",
  "  * files whose path/folder fits the task (e.g. a 'reading list' under",
  '    `Lists/` beats a "reading log" under `Journals/` for "add Dune")',
  "  * the SHORTEST title when multiple files match equally well",
  "",
  "If nothing is a clear, sensible fit, set `bestPath` to null instead of",
  "guessing. NEVER invent a path that isn't in the candidate list.",
  "",
  'Respond with STRICT JSON only: { "bestPath": "<path|null>", "reason": "<one short sentence>" }',
  "No prose, no markdown, no extra fields.",
].join("\n");

// ---- File task prompts ----

const TASK_REQUIRES_INSTRUCTION: ReadonlySet<FileTaskKind> = new Set([
  "extract",
  "answer",
]);

const FILE_TASK_SYSTEM_PROMPTS: Record<FileTaskKind, string> = {
  summarize: [
    "You summarize a single user-confirmed Obsidian note.",
    "Output exactly two markdown sections, in this order:",
    "  '## Summary'    — 3 to 6 concise bullet points capturing the gist.",
    "  '## Key Facts'  — bullet list of concrete facts (names, dates, links).",
    "                    May be empty; omit the section entirely in that case.",
    "Use ONLY the note. Do not invent content. No preamble, no other sections.",
  ].join("\n"),
  extract: [
    "You extract structured information from a single user-confirmed",
    "Obsidian note. The user provides an explicit instruction describing",
    "what to extract.",
    "",
    "Return ONLY the extracted data as markdown — a list, table, or fenced",
    "code block as appropriate. Do NOT add commentary, caveats, or summaries.",
    "If the requested data is not present in the note, output exactly:",
    "  (not found)",
  ].join("\n"),
  answer: [
    "You answer a question about a single user-confirmed Obsidian note.",
    "Use ONLY the note's content. If the answer isn't in the note, say so",
    "plainly with: 'The note doesn't say.' Be concise (1–3 short paragraphs",
    "or a short bullet list). No preamble, no caveats.",
  ].join("\n"),
  generate_tasks: [
    "You identify actionable items in a single user-confirmed Obsidian note.",
    "Output ONE markdown checklist of '- [ ] <task>' items, in priority order.",
    "Each task must be:",
    "  * a concrete, single action (not a category)",
    "  * derivable directly from the note (no invention)",
    "  * one line, no sub-bullets, no extra prose",
    "If the note contains no actionable items, output exactly:",
    "  (no actionable items)",
  ].join("\n"),
};

function buildFileTaskUserPrompt(args: {
  title: string;
  content: string;
  truncated: boolean;
  instruction?: string;
}): string {
  const parts = [
    `Note title: ${args.title}`,
    "Note content:",
    '"""',
    args.content,
    '"""',
  ];
  if (args.truncated) {
    parts.push("(Note: the body above was truncated for length.)");
  }
  if (args.instruction) {
    parts.push("", `Instruction: ${args.instruction}`);
  }
  return parts.join("\n");
}

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
