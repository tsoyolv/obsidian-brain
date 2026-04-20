import { llmProviderFactory } from "@/lib/providers/llm";
import { getConfig } from "@/lib/config";
import { getVaultService } from "@/lib/services/vault";
import type {
  ChatInput,
  LLMMessage,
  ToolDescriptor,
} from "@/lib/providers/llm";
import { createLogger } from "@/lib/utils/logger";
import { newId } from "@/lib/utils/id";
import { estimateTokensForMessages } from "@/lib/utils/tokens";
import {
  getAgentSessionStore,
  PENDING_CONFIRMATION_TTL_MS,
} from "./session";
import { listTools, getTool } from "./tools";
import type {
  AgentMessage,
  AgentTool,
  AnyAgentTool,
  PendingConfirmation,
  ToolCtx,
  ToolResult,
} from "./types";
import { zodToJsonSchema } from "./zodToJsonSchema";
import { detectIntent } from "./intentRouter";

const log = createLogger("agentOrchestrator");

/**
 * Maximum number of tool calls (successful, errored, or invalid-args) the
 * orchestrator will let the model make in a single turn before forcing a
 * final summary. Keeps runaway loops bounded; the design doc caps this at
 * 4.
 */
const MAX_TOOL_CALLS_PER_TURN = 4;
const TOOL_RESULT_TEXT_MAX_CHARS = 1500;
const MAX_COMPLETE_TASK_AMBIGUITY_RETRIES = 3;
const TASK_INTENT_CONFIDENCE_THRESHOLD = 0.75;

/**
 * On invalid LLM-supplied tool arguments we feed the validation error back
 * to the model so it can self-correct. We allow exactly one such retry per
 * turn to avoid pingpong; after that, the orchestrator gives up and
 * surfaces a final apology message.
 */
const MAX_INVALID_ARGS_RETRIES = 1;

/**
 * Hard cap on the prompt-input tokens we report against, used by the
 * capture chat's context-budget bar. Mirrors the long-form chat limit so
 * both surfaces share one mental model. Pure UI / accounting concept —
 * the orchestrator itself doesn't enforce a token ceiling at this layer
 * (the rolling history cap is the structural bound).
 */
export const AGENT_TOKEN_LIMIT = 180_000;

const SYSTEM_PROMPT = [
  "You are an agent for the user's personal Obsidian-backed brain.",
  "",
  "Hard safety rules — NEVER violate these:",
  "  * You MUST go through the provided tools for any vault interaction.",
  "  * You NEVER read the full body of a vault file without explicit user",
  "    confirmation. Use `propose_open_file` to surface candidates first;",
  "    `read_confirmed_file` and `run_file_task` will be gated for confirmation.",
  "  * You NEVER hard-delete files. `soft_delete` only.",
  "  * You NEVER set the `confirmationToken` parameter on any tool — the",
  "    orchestrator injects it after the user explicitly approves.",
  "  * NEVER ask for confirmation in plain text. If an action is confirmation-",
  "    gated, call the tool directly so the UI can show Confirm/Cancel buttons.",
  "",
  "You may chain MULTIPLE tool calls in one turn (e.g. find_file →",
  "propose_open_file). When you have everything you need, stop calling tools",
  "and reply to the user in plain text with a short, helpful summary.",
  "",
  "When the user asks about current events, external services, or public web",
  "content, use `web_search` first. Cite source URLs in your final answer.",
  "",
  "When a tool returns an ambiguous list (for example `complete_task`), and the",
  "user explicitly asked you to pick ANY option autonomously, pick one candidate",
  "and retry instead of asking a follow-up question immediately.",
].join("\n");

// ---- Public event shape ----

/**
 * One event emitted by {@link runTurn} as the agent loop progresses.
 *
 *   - `tool_call`           — model dispatched a tool; args are validated
 *   - `tool_result`         — tool finished (or failed); `result.ok` tells
 *                             which. Pairs with the previous `tool_call`
 *                             via `callId`.
 *   - `message_delta`       — incremental assistant text from the model
 *   - `needs_confirmation`  — model called a confirmation-gated tool; the
 *                             action did NOT run. The caller surfaces a
 *                             confirm/cancel UI and resumes via {@link
 *                             confirmTurn} OR via a natural-language
 *                             follow-up that the orchestrator's pre-loop
 *                             matches against `pendingConfirmation`.
 *   - `final`               — terminal frame; the loop is done. `message`
 *                             is the assistant's final text reply (may be
 *                             empty if the loop exhausted its budget).
 */
export type AgentEvent =
  | {
      type: "tool_call";
      callId: string;
      name: string;
      args: unknown;
    }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      result: ToolResult<unknown>;
    }
  | { type: "message_delta"; text: string }
  | {
      type: "needs_confirmation";
      token: string;
      toolName: string;
      args: unknown;
      preview: unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candidates?: any[];
    }
  | { type: "final"; message: string };

// ---- runTurn ----

export interface PriorContext {
  /**
   * Pre-built rolling-history snapshot to seed the agent session with
   * before this turn runs. When supplied, completely replaces the
   * session's existing `messages` (the chat layer owns its own
   * compaction window and is the authoritative source). When omitted,
   * the session's existing rolling history is used as-is.
   */
  history?: AgentMessage[];
  /**
   * Free-form text appended to the orchestrator's system prompt for this
   * turn only. Chat sessions inject their rolling summary here so the
   * model has gist-of-everything context without the chat layer needing
   * to teach the orchestrator about ChatSession internals.
   */
  systemSuffix?: string;
  /**
   * Optional allowlist of tool names for this run. When provided, the model
   * only sees these tools and any out-of-allowlist tool call is treated as
   * unavailable.
   */
  allowedTools?: string[];
  /** Optional model override for this turn. */
  modelOverride?: string;
}

export interface RunTurnInput {
  sessionId: string;
  userText: string;
  /**
   * Optional injected context from a higher layer (chat). When set, the
   * agent session's rolling history is replaced before this turn runs
   * and `priorContext.systemSuffix` is folded into the system prompt.
   * Capture flows leave this undefined and rely on the agent session's
   * own ROLLING_HISTORY_LIMIT-bounded history.
   */
  priorContext?: PriorContext;
}

/**
 * Drive ONE conversational turn against the agent for a given session, as
 * an async generator of {@link AgentEvent} frames.
 *
 * Pipeline:
 *   1. discard any expired/stale pending confirmation
 *   2. if a pending confirmation is alive AND the user input matches a
 *      yes/no/ordinal cue → resolve WITHOUT calling the LLM
 *   3. otherwise: append the user message and enter the iterative loop:
 *      - send transcript + tool registry to the LLM
 *        (with a system note about any still-pending confirmation)
 *      - if the LLM emits text only, finalize and return
 *      - if the LLM emits a tool call:
 *          * validate args (one retry on validation failure)
 *          * if `needsConfirmation` fires → stash pending confirmation,
 *            yield `needs_confirmation` (with candidates if any), and stop
 *          * otherwise execute the tool, append `tool_call` + `tool_result`
 *            to the session, and loop
 *      - cap at {@link MAX_TOOL_CALLS_PER_TURN} tool calls per turn; on
 *        overflow, ask the model for a final no-tool summary and yield it
 *   4. mark any still-unresolved pending as having seen its grace turn
 */
export async function* runTurn(
  input: RunTurnInput
): AsyncGenerator<AgentEvent, void, void> {
  const sessions = getAgentSessionStore();
  const session = sessions.ensure(input.sessionId);

  const userText = input.userText.trim();
  if (!userText) {
    yield { type: "final", message: "Empty user input." };
    return;
  }

  // (0) Chat-layer hand-off: when priorContext.history is supplied, the
  // chat service is the authoritative owner of conversational history
  // (it has its own rolling-summary compactor). Replace the agent
  // session's rolling history with the chat's tail so the LLM prompt
  // matches what the chat would have built on its own. Pending
  // confirmation is preserved across the swap so the gated-tool flow
  // still works inside chats.
  if (input.priorContext?.history !== undefined) {
    sessions.replaceMessages(session.id, input.priorContext.history);
  }
  const systemSuffix = input.priorContext?.systemSuffix;
  const allowedTools = input.priorContext?.allowedTools;
  const modelOverride = input.priorContext?.modelOverride;

  // (1) Drop pending if it has expired or already had its grace turn. We
  // do this BEFORE matching so a stale yes/no can't accidentally trigger
  // an old action.
  discardStalePending(session.id);
  const pendingAtStart = sessions.get(session.id)?.pendingConfirmation;

  // (2) Button-only confirmation UX:
  // if there's a live pending action, we do NOT parse natural-language
  // "yes/no" replies. The user must use explicit Confirm/Cancel buttons.
  if (pendingAtStart) {
    sessions.appendMessage(session.id, { role: "user", content: userText });
    yield {
      type: "final",
      message:
        "Для этого действия используй кнопки Confirm/Cancel в карточке подтверждения.",
    };
    return;
  }

  sessions.appendMessage(session.id, { role: "user", content: userText });

  const scriptedHandled = yield* maybeHandleStructuredTaskIntent(
    session.id,
    userText,
    allowedTools
  );
  if (scriptedHandled) return;

  const t = log.time("runTurn");
  log.debug("runTurn: start", {
    sessionId: session.id,
    historyLen: session.messages.length,
    hasPending: Boolean(pendingAtStart),
  });

  yield* iterativeLoop(
    session.id,
    undefined,
    systemSuffix,
    allowedTools,
    modelOverride
  );

  t.done("runTurn", {
    sessionId: session.id,
    historyLen: sessions.get(session.id)?.messages.length ?? 0,
  });
}

async function* maybeHandleStructuredTaskIntent(
  sessionId: string,
  userText: string,
  allowedTools?: string[]
): AsyncGenerator<AgentEvent, boolean, void> {
  const intent = detectIntent(userText);
  log.debug("structured-intent: detected", {
    sessionId,
    intent: intent.intent,
    confidence: intent.confidence,
    autonomousAllowed: intent.autonomousAllowed,
    hasExtractedTaskText: Boolean(intent.extractedTaskText?.trim()),
  });
  if (intent.confidence < TASK_INTENT_CONFIDENCE_THRESHOLD) {
    return false;
  }

  const sessions = getAgentSessionStore();
  const finalMessage = yield* runStructuredIntent(
    sessionId,
    intent,
    userText,
    allowedTools
  );
  if (!finalMessage) return false;

  sessions.appendMessage(sessionId, {
    role: "assistant",
    content: finalMessage,
  });
  yield { type: "final", message: finalMessage };
  return true;
}

async function* runStructuredIntent(
  sessionId: string,
  intent: ReturnType<typeof detectIntent>,
  userText: string,
  allowedTools?: string[]
): AsyncGenerator<AgentEvent, string | undefined, void> {
  log.info("structured-intent: handling", {
    sessionId,
    intent: intent.intent,
    confidence: intent.confidence,
  });
  if (intent.intent === "task_complete") {
    return yield* runStructuredTaskComplete(
      sessionId,
      intent,
      userText,
      allowedTools
    );
  }
  if (intent.intent === "task_create") {
    return yield* runStructuredTaskCreate(sessionId, intent, userText, allowedTools);
  }
  if (intent.intent === "task_list_open") {
    return yield* runStructuredTaskListOpen(sessionId, allowedTools);
  }
  if (intent.intent === "task_find") {
    return yield* runStructuredTaskFind(sessionId, intent, userText, allowedTools);
  }
  return undefined;
}

async function* runStructuredTaskComplete(
  sessionId: string,
  intent: ReturnType<typeof detectIntent>,
  userText: string,
  allowedTools?: string[]
): AsyncGenerator<AgentEvent, string | undefined, void> {
  const tool = getAllowedTool("complete_task", allowedTools);
  if (!tool) return undefined;
  const triedTaskTexts = new Set<string>();
  let toolCallsUsed = 0;
  const firstNeedle =
    intent.extractedTaskText && intent.extractedTaskText.trim().length > 0
      ? intent.extractedTaskText
      : userText;
  triedTaskTexts.add(normalizeTaskText(firstNeedle));
  let result = yield* runToolAndYield(sessionId, tool, { taskText: firstNeedle });
  toolCallsUsed += 1;

  while (
    result.ok &&
    isAmbiguousCompleteTaskResult(result.data) &&
    intent.autonomousAllowed &&
    toolCallsUsed < MAX_TOOL_CALLS_PER_TURN &&
    triedTaskTexts.size <= MAX_COMPLETE_TASK_AMBIGUITY_RETRIES + 1
  ) {
    const nextTaskText = pickNextAmbiguousTaskText(result, triedTaskTexts);
    if (!nextTaskText) break;
    triedTaskTexts.add(normalizeTaskText(nextTaskText));
    result = yield* runToolAndYield(sessionId, tool, { taskText: nextTaskText });
    toolCallsUsed += 1;
  }
  return buildStructuredTaskCompletionMessage(result, intent.autonomousAllowed);
}

async function* runStructuredTaskCreate(
  sessionId: string,
  intent: ReturnType<typeof detectIntent>,
  userText: string,
  allowedTools?: string[]
): AsyncGenerator<AgentEvent, string | undefined, void> {
  const tool = getAllowedTool("create_task", allowedTools);
  if (!tool) return undefined;
  const taskText =
    intent.extractedTaskText && intent.extractedTaskText.trim().length > 0
      ? intent.extractedTaskText
      : userText;
  const result = yield* runToolAndYield(sessionId, tool, { taskText });
  if (!result.ok || !result.data || typeof result.data !== "object") return undefined;
  const data = result.data as Record<string, unknown>;
  const text = typeof data.text === "string" ? data.text : taskText;
  const path = typeof data.path === "string" ? data.path : "Tasks/tasks.md";
  return `Добавил задачу: "${text}". Файл: ${path}.`;
}

async function* runStructuredTaskListOpen(
  sessionId: string,
  allowedTools?: string[]
): AsyncGenerator<AgentEvent, string | undefined, void> {
  const tool = getAllowedTool("list_open_tasks", allowedTools);
  if (!tool) return undefined;
  const result = yield* runToolAndYield(sessionId, tool, { limit: 15 });
  if (!result.ok || !result.data || typeof result.data !== "object") return undefined;
  const data = result.data as Record<string, unknown>;
  const totalOpen =
    typeof data.totalOpen === "number" ? data.totalOpen : undefined;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (tasks.length === 0) {
    return "Открытых задач сейчас нет.";
  }
  const lines = tasks.slice(0, 10).flatMap((t, idx) => {
    if (!t || typeof t !== "object") return [];
    const text = (t as Record<string, unknown>).text;
    if (typeof text !== "string") return [];
    return [`${idx + 1}. ${text}`];
  });
  const suffix =
    typeof totalOpen === "number" && totalOpen > lines.length
      ? `\nИ еще ${totalOpen - lines.length} задач.`
      : "";
  return `Нашел открытые задачи:\n${lines.join("\n")}${suffix}`;
}

async function* runStructuredTaskFind(
  sessionId: string,
  intent: ReturnType<typeof detectIntent>,
  userText: string,
  allowedTools?: string[]
): AsyncGenerator<AgentEvent, string | undefined, void> {
  const tool = getAllowedTool("find_tasks", allowedTools);
  if (!tool) return undefined;
  const query =
    intent.extractedTaskText && intent.extractedTaskText.trim().length > 0
      ? intent.extractedTaskText
      : userText;
  const result = yield* runToolAndYield(sessionId, tool, { query, limit: 10 });
  if (!result.ok || !result.data || typeof result.data !== "object") return undefined;
  const data = result.data as Record<string, unknown>;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  if (matches.length === 0) {
    return `По запросу "${query}" задач не нашел.`;
  }
  const lines = matches.slice(0, 5).flatMap((m, idx) => {
    if (!m || typeof m !== "object") return [];
    const obj = m as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text : undefined;
    const done = obj.done === true ? " [выполнено]" : "";
    if (!text) return [];
    return [`${idx + 1}. ${text}${done}`];
  });
  return `Вот что нашел по запросу "${query}":\n${lines.join("\n")}`;
}

// ---- confirmTurn ----

export interface ConfirmTurnInput {
  sessionId: string;
  /** Token previously surfaced via a `needs_confirmation` event. */
  token: string;
}

/**
 * Resume an interrupted turn after the user explicitly confirms the
 * pending tool call (button-driven path; the natural-language path is
 * handled inline by {@link runTurn}'s pre-loop).
 *
 * Behaviour:
 *   - looks up the session's `pendingConfirmation` and matches the token
 *   - runs the gated tool with the orchestrator-injected token; the tool
 *     atomically verifies + consumes the pending record from the store
 *     (so a concurrent attempt can't re-use it)
 *   - appends `tool_call` + `tool_result` to the session
 *   - re-enters the iterative loop so the model can react to the result
 *
 * If the token doesn't match (or no pending confirmation exists), yields a
 * single `final` event explaining the mismatch and returns.
 */
export async function* confirmTurn(
  input: ConfirmTurnInput & { priorContext?: PriorContext }
): AsyncGenerator<AgentEvent, void, void> {
  const sessions = getAgentSessionStore();
  const session = sessions.ensure(input.sessionId);
  // Same chat-layer hand-off as runTurn: the chat service may be re-
  // seeding the session with its compacted tail before the confirm.
  if (input.priorContext?.history !== undefined) {
    sessions.replaceMessages(session.id, input.priorContext.history);
  }
  const systemSuffix = input.priorContext?.systemSuffix;
  const allowedTools = input.priorContext?.allowedTools;
  const modelOverride = input.priorContext?.modelOverride;
  const pending = session.pendingConfirmation;

  if (!pending || pending.token !== input.token) {
    log.warn("confirmTurn: no matching pending confirmation", {
      sessionId: session.id,
      hasPending: Boolean(pending),
    });
    yield {
      type: "final",
      message:
        "No matching pending confirmation — it may have expired or already been handled.",
    };
    return;
  }

  const tool = getAllowedTool(pending.toolName, allowedTools);
  if (!tool) {
    sessions.setPendingConfirmation(session.id, undefined);
    log.warn("confirmTurn: pending tool unknown", { name: pending.toolName });
    yield {
      type: "final",
      message: `Pending tool "${pending.toolName}" is no longer available.`,
    };
    return;
  }

  const t = log.time("confirmTurn");
  log.debug("confirmTurn: start", {
    sessionId: session.id,
    tool: tool.name,
  });

  // The gated tool's `run` consumes the pending record atomically via the
  // session store; we don't pre-clear here so a failure before `run` can
  // be retried.
  const argsWithToken = injectConfirmationToken(pending.args, pending.token);
  yield* runToolAndYield(session.id, tool, argsWithToken);
  yield* iterativeLoop(
    session.id,
    undefined,
    systemSuffix,
    allowedTools,
    modelOverride
  );

  t.done("confirmTurn", {
    sessionId: session.id,
    tool: tool.name,
  });
}

// ---- token accounting ----

/**
 * Estimate the prompt size (in tokens) that the NEXT turn against this
 * session would send to the LLM. Uses the same {@link buildPromptMessages}
 * pipeline the iterative loop uses, so the number tracks the actual
 * payload to within the estimator's ~15% accuracy band.
 *
 * Cheap pure function — safe to call from request handlers / SSE finalizers
 * to drive the capture chat's context-budget bar.
 *
 * Returns 0 for unknown session ids so callers don't have to defensively
 * branch.
 */
export function estimateAgentNextPromptTokens(
  sessionId: string,
  systemSuffix?: string
): number {
  const sessions = getAgentSessionStore();
  const session = sessions.get(sessionId);
  if (!session) return 0;
  const messages = buildPromptMessages(
    session.messages,
    session.pendingConfirmation,
    systemSuffix
  );
  return estimateTokensForMessages(messages);
}

// ---- iterative loop ----

async function* iterativeLoop(
  sessionId: string,
  pendingContext?: PendingConfirmation,
  systemSuffix?: string,
  allowedTools?: string[],
  modelOverride?: string
): AsyncGenerator<AgentEvent, void, void> {
  const sessions = getAgentSessionStore();
  const llm = llmProviderFactory.get();
  const tools = listTools().filter(
    (t) => !allowedTools || allowedTools.includes(t.name)
  );
  const descriptors: ToolDescriptor[] = tools.map((t) => toDescriptor(t));

  let toolCallsUsed = countToolCallsInSession(
    sessions.get(sessionId)?.messages ?? []
  );
  let invalidArgsRetries = 0;

  while (true) {
    if (toolCallsUsed >= MAX_TOOL_CALLS_PER_TURN) {
      // Budget exhausted — ask the model for a no-tools summary and stop.
      const summary = await finalSummary(sessionId, pendingContext, systemSuffix);
      yield { type: "final", message: summary };
      return;
    }

    const session = sessions.get(sessionId)!;
    // Re-read pending each iteration: it may have been consumed by a tool
    // we just ran, or replaced by a new gated call.
    const livePending = session.pendingConfirmation ?? pendingContext;
    const chatInput: ChatInput = {
      model: modelOverride,
      temperature: 0.2,
      messages: buildPromptMessages(session.messages, livePending, systemSuffix),
    };

    let assistantText = "";
    let toolCall: { name: string; args: unknown } | undefined;
    for await (const frame of llm.chatWithTools(chatInput, descriptors)) {
      if (frame.type === "message_delta" && frame.delta) {
        assistantText += frame.delta;
        yield { type: "message_delta", text: frame.delta };
      } else if (frame.type === "tool_call" && frame.toolCall && !toolCall) {
        toolCall = frame.toolCall;
      }
    }

    // Path A — pure text reply. End the loop.
    if (!toolCall) {
      const text = assistantText.trim();
      if (text) {
        sessions.appendMessage(sessionId, {
          role: "assistant",
          content: text,
        });
      }
      yield { type: "final", message: text || "(no response)" };
      return;
    }

    // Path B — tool dispatch.
    toolCallsUsed += 1;

    const tool = getAllowedTool(toolCall.name, allowedTools);
    if (!tool) {
      const callId = newId("call");
      sessions.appendMessage(sessionId, {
        role: "tool_call",
        id: callId,
        toolName: toolCall.name,
        args: toolCall.args,
      });
      const errResult: ToolResult<unknown> = {
        ok: false,
        error: `Unknown tool "${toolCall.name}".`,
      };
      sessions.appendMessage(sessionId, {
        role: "tool_result",
        id: callId,
        toolName: toolCall.name,
        result: errResult,
      });
      yield {
        type: "tool_call",
        callId,
        name: toolCall.name,
        args: toolCall.args,
      };
      yield {
        type: "tool_result",
        callId,
        name: toolCall.name,
        result: errResult,
      };
      // Let the model react to the error on the next loop iteration.
      continue;
    }

    // Strip any model-supplied `confirmationToken` BEFORE validation so a
    // hallucinated value can never bypass the confirmation flow. Real
    // tokens are only ever orchestrator-injected.
    const sanitizedArgs = stripConfirmationToken(toolCall.args);

    // Validate args BEFORE checking `needsConfirmation` so confirmation
    // previews always reflect parsed (not raw-JSON) input.
    const parsed = tool.parameters.safeParse(sanitizedArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      const callId = newId("call");
      sessions.appendMessage(sessionId, {
        role: "tool_call",
        id: callId,
        toolName: tool.name,
        args: sanitizedArgs,
      });
      const errResult: ToolResult<unknown> = {
        ok: false,
        error: `Invalid arguments for ${tool.name}: ${issues}`,
      };
      sessions.appendMessage(sessionId, {
        role: "tool_result",
        id: callId,
        toolName: tool.name,
        result: errResult,
      });
      yield {
        type: "tool_call",
        callId,
        name: tool.name,
        args: sanitizedArgs,
      };
      yield {
        type: "tool_result",
        callId,
        name: tool.name,
        result: errResult,
      };

      log.warn("iterativeLoop: tool args validation failed", {
        tool: tool.name,
        issues,
        retry: invalidArgsRetries,
      });

      invalidArgsRetries += 1;
      if (invalidArgsRetries > MAX_INVALID_ARGS_RETRIES) {
        const summary = await finalSummary(
          sessionId,
          livePending,
          systemSuffix,
          modelOverride
        );
        yield {
          type: "final",
          message:
            summary ||
            `Couldn't construct valid arguments for ${tool.name} — giving up this turn.`,
        };
        return;
      }
      continue;
    }
    const validatedArgs = parsed.data;

    const needs = tool.needsConfirmation?.(validatedArgs);
    if (needs === true || needs === "always") {
      const token = newId("conf");
      const candidates = findLatestCandidates(
        sessions.get(sessionId)?.messages ?? []
      );
      const preview = await buildConfirmationPreview(tool.name, validatedArgs);
      const now = new Date();
      const pending: PendingConfirmation = {
        token,
        toolName: tool.name,
        args: validatedArgs,
        candidates,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + PENDING_CONFIRMATION_TTL_MS
        ).toISOString(),
      };
      sessions.setPendingConfirmation(sessionId, pending);
      log.info("iterativeLoop: needs confirmation", {
        sessionId,
        tool: tool.name,
        token,
        candidates: candidates?.length ?? 0,
      });
      yield {
        type: "needs_confirmation",
        token,
        toolName: tool.name,
        args: validatedArgs,
        preview,
        candidates,
      };
      // Stop the loop; resumption happens via confirmTurn OR via a
      // natural-language follow-up handled by runTurn's pre-loop.
      return;
    }

    const firstResult = yield* runToolAndYield(sessionId, tool, validatedArgs);
    if (
      tool.name === "complete_task" &&
      shouldAutopickAnyTask(sessions.get(sessionId)?.messages ?? [])
    ) {
      let retries = 0;
      const triedTaskTexts = new Set<string>();
      const initialTaskText = getCompleteTaskText(validatedArgs);
      if (initialTaskText) {
        triedTaskTexts.add(normalizeTaskText(initialTaskText));
      }
      let latestResult = firstResult;
      while (
        retries < MAX_COMPLETE_TASK_AMBIGUITY_RETRIES &&
        toolCallsUsed < MAX_TOOL_CALLS_PER_TURN
      ) {
        const nextTaskText = pickNextAmbiguousTaskText(latestResult, triedTaskTexts);
        if (!nextTaskText) break;
        triedTaskTexts.add(normalizeTaskText(nextTaskText));
        toolCallsUsed += 1;
        retries += 1;
        latestResult = yield* runToolAndYield(sessionId, tool, { taskText: nextTaskText });
      }
    }
    // Loop again so the model can react to the tool result.
  }
}

// ---- pending-confirmation resolution ----

type UserIntent =
  | { kind: "affirmative"; index?: number }
  | { kind: "negative" }
  | { kind: "none" };

/**
 * Run a tool against an existing pending confirmation, after the user has
 * implicitly approved via a natural-language follow-up ("yes" / "the
 * second one" / etc). Mirrors {@link confirmTurn}'s body but skips token
 * generation since the pending already has one.
 */
async function* resolveFromPending(
  sessionId: string,
  pending: PendingConfirmation,
  intent: UserIntent,
  allowedTools?: string[],
  modelOverride?: string
): AsyncGenerator<AgentEvent, void, void> {
  const sessions = getAgentSessionStore();

  if (intent.kind === "negative") {
    sessions.setPendingConfirmation(sessionId, undefined);
    log.info("resolveFromPending: cancelled", {
      sessionId,
      tool: pending.toolName,
    });
    const message = `Cancelled — ${pending.toolName} will not run.`;
    sessions.appendMessage(sessionId, { role: "assistant", content: message });
    yield { type: "final", message };
    return;
  }

  // Defensive — runTurn only routes here for affirmative / negative.
  if (intent.kind !== "affirmative") return;

  // Affirmative — possibly with an ordinal selector.
  const tool = getAllowedTool(pending.toolName, allowedTools);
  if (!tool) {
    sessions.setPendingConfirmation(sessionId, undefined);
    log.warn("resolveFromPending: tool gone", { name: pending.toolName });
    yield {
      type: "final",
      message: `Pending tool "${pending.toolName}" is no longer available.`,
    };
    return;
  }

  let args = pending.args;
  if (intent.index !== undefined) {
    const candidates = pending.candidates ?? [];
    const picked = candidates[intent.index - 1];
    if (!picked) {
      sessions.setPendingConfirmation(sessionId, undefined);
      const msg = `No candidate at position ${intent.index} — there were only ${candidates.length}.`;
      sessions.appendMessage(sessionId, { role: "assistant", content: msg });
      yield { type: "final", message: msg };
      return;
    }
    const path = typeof picked === "object" && picked && "path" in picked
      ? (picked as { path: string }).path
      : undefined;
    if (!path) {
      sessions.setPendingConfirmation(sessionId, undefined);
      const msg = `Candidate ${intent.index} is missing a usable path; please retry.`;
      sessions.appendMessage(sessionId, { role: "assistant", content: msg });
      yield { type: "final", message: msg };
      return;
    }
    args = rebindArgsToPath(args, path);
    log.info("resolveFromPending: ordinal rebind", {
      sessionId,
      tool: tool.name,
      index: intent.index,
      path,
    });
  } else {
    log.info("resolveFromPending: affirmative", {
      sessionId,
      tool: tool.name,
    });
  }

  const argsWithToken = injectConfirmationToken(args, pending.token);
  yield* runToolAndYield(sessionId, tool, argsWithToken);
  yield* iterativeLoop(
    sessionId,
    undefined,
    undefined,
    allowedTools,
    modelOverride
  );
}

/**
 * Tokenise the user input and decide whether it represents a confirmation
 * decision against the current pending. Returns `{kind: "none"}` for
 * anything we don't recognise — the caller falls back to the LLM.
 *
 * Recognised patterns:
 *   - affirmative: "yes" / "yeah" / "yep" / "sure" / "ok" / "okay" /
 *                  "open it" / "do it" / "go" / "go ahead" / "confirm" /
 *                  "proceed"
 *   - negative:    "no" / "nope" / "cancel" / "skip" / "stop" / "abort" /
 *                  "don't" / "do not"
 *   - ordinal (only when `candidates` is a non-empty array):
 *       "#N" / "the Nth" / "Nth one" / "first / second / third / …"
 *       Extracted from anywhere in the input; treated as affirmative+index.
 */
function parseUserIntent(
  input: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  candidates: any[] | undefined
): UserIntent {
  const text = input.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!text) return { kind: "none" };

  // Ordinal extraction first — a phrase like "yes, the second one" should
  // resolve to affirmative+index, not bare affirmative.
  if (Array.isArray(candidates) && candidates.length > 0) {
    const idx = extractOrdinal(text);
    if (idx !== undefined) {
      return { kind: "affirmative", index: idx };
    }
  }

  if (NEGATIVE_PHRASES.has(text) || NEGATIVE_PREFIXES.some((p) => text.startsWith(p))) {
    return { kind: "negative" };
  }
  if (AFFIRMATIVE_PHRASES.has(text) || AFFIRMATIVE_PREFIXES.some((p) => text.startsWith(p))) {
    return { kind: "affirmative" };
  }

  return { kind: "none" };
}

const AFFIRMATIVE_PHRASES = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "ok",
  "okay",
  "go",
  "go ahead",
  "confirm",
  "confirmed",
  "proceed",
  "do it",
  "open it",
  "open",
  "y",
]);
const AFFIRMATIVE_PREFIXES = ["yes ", "ok ", "okay ", "sure ", "go ahead ", "confirm "];

const NEGATIVE_PHRASES = new Set([
  "no",
  "nope",
  "nah",
  "cancel",
  "skip",
  "stop",
  "abort",
  "don't",
  "dont",
  "do not",
  "n",
]);
const NEGATIVE_PREFIXES = ["no ", "cancel ", "skip ", "stop ", "abort "];

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

function extractOrdinal(text: string): number | undefined {
  // "#N" anywhere
  const hash = text.match(/#\s*(\d{1,2})\b/);
  if (hash) return parseIntSafe(hash[1]!);
  // "the Nth" / "Nth" / "N-th" — match digit forms 1st / 2nd / 3rd / 4th…
  const digitOrdinal = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (digitOrdinal) return parseIntSafe(digitOrdinal[1]!);
  // "number N" / "option N"
  const labelled = text.match(/\b(?:number|option|item|candidate)\s+(\d{1,2})\b/);
  if (labelled) return parseIntSafe(labelled[1]!);
  // Word ordinals — only when paired with an affirmative cue OR "one" /
  // "the X" so a stray "second" in unrelated prose doesn't trigger.
  for (const [word, value] of Object.entries(ORDINAL_WORDS)) {
    const re = new RegExp(`\\b(?:the\\s+)?${word}(?:\\s+one)?\\b`);
    if (re.test(text)) return value;
  }
  return undefined;
}

function parseIntSafe(s: string): number | undefined {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Walk the session backwards looking for the most recent successful
 * `propose_open_file` (or `find_file`) result and return its candidate
 * list. Used to attach `candidates` to a fresh `pendingConfirmation` so
 * "the second one" works on the next turn.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findLatestCandidates(messages: AgentMessage[]): any[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool_result") continue;
    if (m.toolName !== "propose_open_file" && m.toolName !== "find_file") {
      continue;
    }
    const result = m.result as ToolResult<unknown> | undefined;
    if (!result || !result.ok) continue;
    const data = (result as { ok: true; data: unknown }).data;
    if (data && typeof data === "object") {
      // propose_open_file → { candidates: FileCandidate[] }
      // find_file        → { matches:    FileMatch[] }
      const obj = data as Record<string, unknown>;
      const arr = (obj.candidates ?? obj.matches) as unknown;
      if (Array.isArray(arr) && arr.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return arr as any[];
      }
    }
  }
  return undefined;
}

function rebindArgsToPath(args: unknown, path: string): unknown {
  if (!args || typeof args !== "object") return { path };
  return { ...(args as Record<string, unknown>), path };
}

function injectConfirmationToken(args: unknown, token: string): unknown {
  if (!args || typeof args !== "object") {
    return { confirmationToken: token };
  }
  return { ...(args as Record<string, unknown>), confirmationToken: token };
}

function stripConfirmationToken(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const obj = args as Record<string, unknown>;
  if (!("confirmationToken" in obj)) return args;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { confirmationToken: _drop, ...rest } = obj;
  return rest;
}

function discardStalePending(sessionId: string): void {
  const sessions = getAgentSessionStore();
  const session = sessions.get(sessionId);
  const pending = session?.pendingConfirmation;
  if (!pending) return;
  const expired = Date.parse(pending.expiresAt) < Date.now();
  if (expired || pending.staleAfterTurn) {
    log.info("runTurn: discarding stale pending", {
      sessionId,
      tool: pending.toolName,
      reason: expired ? "expired" : "graceTurnElapsed",
    });
    sessions.setPendingConfirmation(sessionId, undefined);
  }
}

// ---- helpers ----

/**
 * Run a tool, append `tool_call` + `tool_result` to the session, and yield
 * the matching events to the caller.
 *
 * Tool failures are surfaced as `{ ok: false, error }` (not thrown) so the
 * loop stays responsive and the model gets a chance to recover.
 */
async function* runToolAndYield(
  sessionId: string,
  tool: AnyAgentTool,
  args: unknown
): AsyncGenerator<AgentEvent, ToolResult<unknown>, void> {
  const sessions = getAgentSessionStore();
  const callId = newId("call");
  sessions.appendMessage(sessionId, {
    role: "tool_call",
    id: callId,
    toolName: tool.name,
    args,
  });
  yield { type: "tool_call", callId, name: tool.name, args };

  const ctx: ToolCtx = {
    sessionId,
    logger: createLogger(`agent.tool.${tool.name}`),
  };

  let result: ToolResult<unknown>;
  try {
    const data = await runToolUnknown(tool, args, ctx);
    result = { ok: true, data };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn("runToolAndYield: tool execution failed", {
      tool: tool.name,
      err: errMsg,
    });
    result = { ok: false, error: errMsg };
  }

  const historyResult = sanitizeToolResultForHistory(tool.name, result);
  sessions.appendMessage(sessionId, {
    role: "tool_result",
    id: callId,
    toolName: tool.name,
    result: historyResult,
  });
  // Stream the same compacted payload so chat transcripts and UI tool cards
  // don't store/render full raw file bodies.
  yield { type: "tool_result", callId, name: tool.name, result: historyResult };
  return historyResult;
}

/**
 * Ask the model for a no-tools summary based on the current transcript.
 * Used when we hit the per-turn tool-call cap, or when we've burned the
 * invalid-args retry budget — the goal is to never leave the user without
 * SOME assistant message at the end of a turn.
 */
async function finalSummary(
  sessionId: string,
  pendingContext?: PendingConfirmation,
  systemSuffix?: string,
  modelOverride?: string
): Promise<string> {
  const sessions = getAgentSessionStore();
  const llm = llmProviderFactory.get();
  const session = sessions.get(sessionId);
  if (!session) return "(no session)";
  try {
    const resp = await llm.sendMessage({
      model: modelOverride,
      temperature: 0.2,
      messages: buildPromptMessages(session.messages, pendingContext, systemSuffix),
    });
    const text = resp.content.trim() || "(done)";
    sessions.appendMessage(sessionId, {
      role: "assistant",
      content: text,
    });
    return text;
  } catch (err) {
    log.warn("finalSummary: failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return "(done — summary failed)";
  }
}

function countToolCallsInSession(messages: AgentMessage[]): number {
  // We bound tool calls to the CURRENT user turn, which is everything since
  // the last `user` message. Anything before that came from a previous turn
  // and shouldn't count against this turn's budget.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return 0;
  let count = 0;
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i]!.role === "tool_call") count += 1;
  }
  return count;
}

function toDescriptor(tool: AnyAgentTool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parameters),
  };
}

function getAllowedTool(
  name: string,
  allowedTools?: string[]
): AnyAgentTool | undefined {
  if (allowedTools && !allowedTools.includes(name)) return undefined;
  return getTool(name);
}

/**
 * Tool dispatch via the registry erases the per-tool I/O types, so the
 * orchestrator goes through this thin `unknown`-typed shim. Concrete tools
 * remain strictly typed at their own definition sites.
 */
async function runToolUnknown(
  tool: AnyAgentTool,
  args: unknown,
  ctx: ToolCtx
): Promise<unknown> {
  // We have already validated `args` against `tool.parameters`, so this
  // cast is sound at runtime even though the type system can't see it.
  const concrete = tool as AgentTool<unknown, unknown>;
  return concrete.run(args, ctx);
}

/**
 * Flatten the session's `AgentMessage[]` into the provider's chat-message
 * shape. Tool calls / results are folded into adjacent assistant / system
 * messages so providers without first-class tool-message support still
 * see the conversational context.
 *
 * If a `pendingContext` is supplied, an additional system note is
 * appended so the model knows there's an outstanding confirmation it
 * should EITHER re-surface (e.g. with clearer phrasing) or steer around.
 * The model NEVER receives the actual confirmation token.
 */
function buildPromptMessages(
  messages: AgentMessage[],
  pendingContext?: PendingConfirmation,
  systemSuffix?: string
): LLMMessage[] {
  const systemContent = systemSuffix
    ? `${SYSTEM_PROMPT}\n\n${systemSuffix.trim()}`
    : SYSTEM_PROMPT;
  const out: LLMMessage[] = [{ role: "system", content: systemContent }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content });
    } else if (m.role === "tool_call") {
      // Surfaced as an assistant turn so the next prompt knows the tool
      // was invoked and with what arguments.
      out.push({
        role: "assistant",
        content: `[tool_call:${m.toolName}] ${stringifyArgs(m.args)}`,
      });
    } else if (m.role === "tool_result") {
      out.push({
        role: "system",
        content:
          `[tool_result:${m.toolName}] ` + stringifyArgs(m.result),
      });
    }
  }
  if (pendingContext) {
    // Strip the token from any args echoed back so the model can't claim
    // it. Candidates are summarised by path/title only.
    const safeArgs = stringifyArgs(stripConfirmationToken(pendingContext.args));
    const candidateSummary = summariseCandidates(pendingContext.candidates);
    out.push({
      role: "system",
      content:
        `There is a pending confirmation: tool=${pendingContext.toolName} args=${safeArgs}. ` +
        `The user must accept or decline it before it can run; you do NOT have its token. ` +
        (candidateSummary
          ? `Candidates available for ordinal selection: ${candidateSummary}.`
          : "") +
        " You may re-surface the candidates or change topic; do not silently re-issue the same tool call.",
    });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summariseCandidates(candidates: any[] | undefined): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  return candidates
    .slice(0, 5)
    .map((c, i) => {
      if (c && typeof c === "object") {
        const obj = c as Record<string, unknown>;
        const path = typeof obj.path === "string" ? obj.path : undefined;
        const title = typeof obj.title === "string" ? obj.title : undefined;
        return `${i + 1}=${title ?? path ?? "?"}`;
      }
      return `${i + 1}=${String(c)}`;
    })
    .join("; ");
}

function stringifyArgs(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function buildConfirmationPreview(
  toolName: string,
  args: unknown
): Promise<unknown> {
  if (toolName !== "read_confirmed_file") return args;
  if (!args || typeof args !== "object") return args;
  const obj = args as Record<string, unknown>;
  const path = typeof obj.path === "string" ? obj.path : undefined;
  if (!path) return args;
  try {
    const cfg = getConfig();
    const vault = getVaultService();
    const safePath = vault.safePathResolve(path);
    const stat = await vault.statFile(safePath);
    return {
      ...obj,
      needsConfirmationReason:
        "full file read requested (confirmation-gated operation)",
      fileSizeBytes: stat.size,
      autoReadLimitChars: cfg.fileRead.autoReadMaxChars,
      note:
        "If a tiny single-hit file is opened via propose_open_file and is <= autoReadLimitChars, it may be auto-read without confirmation.",
    };
  } catch {
    return {
      ...obj,
      needsConfirmationReason:
        "full file read requested (could not stat file size before confirmation)",
      autoReadLimitChars: getConfig().fileRead.autoReadMaxChars,
    };
  }
}

function sanitizeToolResultForHistory(
  toolName: string,
  result: ToolResult<unknown>
): ToolResult<unknown> {
  if (!result.ok) return result;
  if (!result.data || typeof result.data !== "object") return result;
  const data = result.data as Record<string, unknown>;

  if (toolName === "read_confirmed_file") {
    // Full confirmed file reads are allowed to flow into history/context.
    // Confirmation is the gate; once approved, we keep the full body.
    return result;
  }

  if (toolName === "propose_open_file") {
    const autoRead =
      data.autoRead && typeof data.autoRead === "object"
        ? (data.autoRead as Record<string, unknown>)
        : null;
    if (!autoRead) return result;
    return {
      ok: true,
      data: {
        ...data,
        autoRead: {
          ...autoRead,
          content: truncateTextField(autoRead.content, TOOL_RESULT_TEXT_MAX_CHARS),
        },
      },
    };
  }

  if (toolName === "run_file_task") {
    return {
      ok: true,
      data: {
        ...data,
        markdown: truncateTextField(data.markdown, TOOL_RESULT_TEXT_MAX_CHARS),
      },
    };
  }

  return result;
}

function truncateTextField(value: unknown, maxChars: number): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + "\n\n[truncated for token safety]";
}

function shouldAutopickAnyTask(messages: AgentMessage[]): boolean {
  const latestUser = getLatestUserMessage(messages);
  if (!latestUser) return false;
  const text = latestUser.toLowerCase();
  const markers = [
    "любую",
    "любой",
    "без меня",
    "не спрашивая",
    "самостоятельно",
    "choose any",
    "pick any",
    "without asking",
    "autonomously",
  ];
  return markers.some((marker) => text.includes(marker));
}

function getLatestUserMessage(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user") return msg.content;
  }
  return undefined;
}

function getCompleteTaskText(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).taskText;
  return typeof value === "string" ? value : undefined;
}

function normalizeTaskText(text: string): string {
  return text.trim().toLowerCase();
}

function pickNextAmbiguousTaskText(
  result: ToolResult<unknown>,
  triedTaskTexts: Set<string>
): string | undefined {
  if (!result.ok || !result.data || typeof result.data !== "object") return undefined;
  const data = result.data as Record<string, unknown>;
  if (data.status !== "ambiguous") return undefined;
  const rawMatches = data.matches;
  if (!Array.isArray(rawMatches)) return undefined;
  for (const match of rawMatches) {
    if (!match || typeof match !== "object") continue;
    const text = (match as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    if (triedTaskTexts.has(normalizeTaskText(text))) continue;
    return text;
  }
  return undefined;
}

function isAmbiguousCompleteTaskResult(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return (data as Record<string, unknown>).status === "ambiguous";
}

function buildStructuredTaskCompletionMessage(
  result: ToolResult<unknown>,
  autonomousAllowed: boolean
): string | undefined {
  if (!result.ok || !result.data || typeof result.data !== "object") {
    return undefined;
  }
  const data = result.data as Record<string, unknown>;
  const status = data.status;
  if (status === "ok") {
    const text = typeof data.text === "string" ? data.text : "задача";
    const path = typeof data.path === "string" ? data.path : "неизвестный файл";
    return `Закрыл задачу: "${text}". Файл: ${path}.`;
  }
  if (status === "not_found") {
    return "Не нашел подходящую открытую задачу для закрытия.";
  }
  if (status === "ambiguous") {
    if (autonomousAllowed) {
      return "Нашел несколько похожих задач, но в пределах лимита попыток не смог надежно закрыть одну.";
    }
    return "Нашел несколько похожих задач для закрытия. Уточни, какую именно закрыть.";
  }
  return undefined;
}
