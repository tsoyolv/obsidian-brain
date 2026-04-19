import type { z } from "zod";
import type { createLogger } from "@/lib/utils/logger";

/**
 * Per-invocation context handed to every tool.
 *
 * The orchestrator owns the session — tools must NOT mutate it directly. Use
 * `ctx.logger` for any logging so the agent's call chain is greppable.
 */
export interface ToolCtx {
  sessionId: string;
  logger: ReturnType<typeof createLogger>;
}

/**
 * Result envelope returned by the orchestrator (never by the tool's `run`
 * itself — see {@link AgentTool.run}).
 *
 *   - `{ ok: true; data }`              — happy path
 *   - `{ ok: false; error }`            — validation / execution failure
 *   - `{ ok: false; needsConfirmation }`— tool gated by `needsConfirmation`;
 *     the user must approve via `token` before the action runs. The `token`
 *     is a placeholder until batch 3 wires real confirmation tokens.
 */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }
  | {
      ok: false;
      needsConfirmation: true;
      token: string;
      preview: unknown;
    };

/**
 * Contract every tool exported under `src/lib/agent/tools/*` must implement.
 *
 * The `parameters` zod schema is the SINGLE source of truth for tool input:
 *   - the orchestrator validates LLM-supplied args against it before calling
 *     `run`
 *   - it is converted to JSON Schema and sent to the LLM as the tool's
 *     argument descriptor
 *
 * `needsConfirmation` is consulted BEFORE `run` ever fires. Returning
 *   `"always"` or `true` causes the orchestrator to short-circuit with a
 *   `needsConfirmation` ToolResult; the tool's side-effecting work is never
 *   invoked until a confirmation token is presented (wired in batch 3).
 *
 * `run` is the only side-effecting surface; it should delegate to existing
 * `src/lib/services/*` and MUST NOT touch the filesystem directly.
 */
export interface AgentTool<I, O> {
  name: string;
  description: string;
  parameters: z.ZodType<I>;
  needsConfirmation?: (input: I) => boolean | "always";
  run(input: I, ctx: ToolCtx): Promise<O>;
}

/**
 * Heterogeneous tool used by the registry. Each concrete tool is still typed
 * via `AgentTool<I, O>` at its definition site; only callers that fan out
 * over the registry need this.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, any>;

// ---- Session ----

/**
 * Conversation history record. The agent loop appends one of these per turn
 * step: a user message, an assistant message, a tool call, or a tool result.
 *
 * Keeping `tool_call` and `tool_result` as siblings of `assistant` (instead
 * of a separate stream) lets the orchestrator replay the whole transcript
 * to the LLM with provider-specific formatting handled centrally.
 */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool_call"; id: string; toolName: string; args: unknown }
  | { role: "tool_result"; id: string; toolName: string; result: unknown };

/**
 * One pending confirmation per session.
 *
 * The orchestrator stashes the validated tool args here when a tool's
 * `needsConfirmation` predicate fires. It is consumed either by:
 *   - the explicit `confirmTurn` flow (button click → token), or
 *   - a natural-language follow-up handled by the orchestrator's pre-loop
 *     ("yes", "the second one", "cancel", …).
 *
 * `candidates` is the ranked list that produced the gated args (typically
 * the most recent `propose_open_file` result). Carrying it on the pending
 * record lets ordinal follow-ups ("the second one") re-bind args without
 * a fresh tool call.
 *
 * Lifetime is bounded by both `expiresAt` (wall-clock TTL) and a single
 * grace user turn after surfacing — see {@link AgentSession.pendingConfirmation}.
 */
export interface PendingConfirmation {
  token: string;
  toolName: string;
  args: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  candidates?: any[];
  createdAt: string;
  expiresAt: string;
  /**
   * True once a user turn has elapsed since this confirmation was surfaced
   * without it being consumed. Used by the orchestrator to discard pending
   * records that the user has effectively walked away from.
   *
   * Set internally by the session store; consumers should treat this as
   * read-only metadata.
   */
  staleAfterTurn?: boolean;
}
