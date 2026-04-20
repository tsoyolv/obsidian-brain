import { getConfig } from "@/lib/config";
import type { LLMProvider } from "@/lib/providers/llm";
import type { LLMMessage } from "@/lib/providers/llm";
import type { ChatMessage, ChatSession } from "@/lib/types";
import { estimateTokensForMessages } from "@/lib/utils/tokens";

type RouteTier = "fast" | "standard" | "reasoning";

export interface TitleAndRouteResult {
  title: string;
  tier: RouteTier;
}

export interface RouteDecision {
  model: string;
  tier: RouteTier;
}

const TITLE_ROUTE_PROMPT = [
  "You are a routing assistant for a chat application.",
  "Given the first user message, return strict JSON with:",
  '  - "title": short title in the same language (3-8 words, no quotes)',
  '  - "complexity": one of "low" | "medium" | "high"',
  "",
  "Classify as high when the request likely needs deep reasoning, architecture",
  "decisions, complex debugging, migration planning, or security-critical changes.",
  "Classify as low for quick factual, formatting, or simple CRUD requests.",
  "No markdown and no extra keys.",
].join("\n");

const TITLE_SCHEMA_EXAMPLE =
  '{"title":"...", "complexity":"low|medium|high"}';

export async function resolveTitleAndInitialTier(
  llm: LLMProvider,
  userText: string
): Promise<TitleAndRouteResult | null> {
  const cfg = getConfig();
  if (!cfg.modelRouting.enabled) return null;
  const source = userText.trim();
  if (!source) return null;

  try {
    const resp = await llm.sendMessage({
      model: cfg.openai.routerModel,
      temperature: 0,
      responseFormat: "json_object",
      maxOutputTokens: 80,
      messages: [
        { role: "system", content: TITLE_ROUTE_PROMPT },
        {
          role: "user",
          content: `Input:\n${source}\n\nRespond as JSON: ${TITLE_SCHEMA_EXAMPLE}`,
        },
      ],
    });
    const parsed = JSON.parse(resp.content) as {
      title?: unknown;
      complexity?: unknown;
    };
    const title = sanitizeTitle(typeof parsed.title === "string" ? parsed.title : "");
    const tier = complexityToTier(parsed.complexity);
    if (!title) return { title: "", tier };
    return { title, tier };
  } catch {
    return null;
  }
}

export function chooseModelForTurn(args: {
  session: ChatSession;
  userText: string;
  systemPrompt: string;
  defaultModel: string;
  preferredTier?: RouteTier;
}): RouteDecision {
  const cfg = getConfig();
  const routedOff = !cfg.modelRouting.enabled;
  if (routedOff) return { model: args.defaultModel, tier: "standard" };

  const nextPromptEstimate = estimateNextPromptTokens(args.session, args.systemPrompt);
  let tier = args.preferredTier ?? classifyTier(args.userText, nextPromptEstimate);

  if (cfg.modelRouting.dynamicEscalationEnabled) {
    const escalationSignals = countEscalationSignals(args.session.messages);
    if (escalationSignals >= 2 && tier !== "reasoning") {
      tier = tier === "fast" ? "standard" : "reasoning";
    }
  }

  const state = args.session.modelRoutingState;
  if (state && state.stickyTurnsLeft > 0 && state.model && tier === state.tier) {
    state.stickyTurnsLeft -= 1;
    return { model: state.model, tier: state.tier };
  }

  const model = modelForTier(tier);
  args.session.modelRoutingState = {
    model,
    tier,
    stickyTurnsLeft: Math.max(0, cfg.modelRouting.stickyTurns - 1),
  };
  return { model, tier };
}

function classifyTier(userText: string, nextPromptEstimate: number): RouteTier {
  const cfg = getConfig();
  const text = userText.toLowerCase();
  if (nextPromptEstimate >= cfg.modelRouting.highPromptTokens) {
    return "reasoning";
  }

  const highSignal =
    /\b(architecture|refactor|migration|security|incident|root cause|why|trade-off|design)\b/i.test(
      text
    ) || text.length > 700;
  if (highSignal) return "reasoning";

  const lowSignal =
    text.length < 120 &&
    /\b(translate|rename|fix typo|title|summarize quickly|briefly|yes|no)\b/i.test(
      text
    );
  if (lowSignal) return "fast";

  return "standard";
}

function countEscalationSignals(messages: ChatMessage[]): number {
  let signals = 0;
  for (let i = messages.length - 1; i >= 0 && i > messages.length - 8; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      const t = m.content.toLowerCase();
      if (t.includes("i don't know") || t.includes("not enough context")) signals += 1;
    }
    if (m.role === "tool_result" && m.result && typeof m.result === "object") {
      const r = m.result as { ok?: unknown };
      if (r.ok === false) signals += 1;
    }
  }
  return signals;
}

function modelForTier(tier: RouteTier): string {
  const cfg = getConfig();
  if (tier === "fast") return cfg.openai.chatFastModel;
  if (tier === "reasoning") return cfg.openai.chatReasoningModel;
  return cfg.openai.chatStandardModel;
}

function complexityToTier(value: unknown): RouteTier {
  if (value === "low") return "fast";
  if (value === "high") return "reasoning";
  return "standard";
}

function estimateNextPromptTokens(session: ChatSession, systemPrompt: string): number {
  const msgs: LLMMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of session.messages) {
    if (m.role === "user" || m.role === "assistant") {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  return estimateTokensForMessages(msgs);
}

function sanitizeTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  return firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;,:\-\s]+$/g, "")
    .slice(0, 80)
    .trim();
}
