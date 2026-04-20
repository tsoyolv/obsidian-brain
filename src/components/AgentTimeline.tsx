"use client";

import { useState } from "react";
import { ActionResultCard } from "./ActionResultCard";
import { Markdown } from "./Markdown";
import { Spinner, ThinkingDots } from "./Spinner";
import type { ToolResult } from "@/lib/agent/types";

/**
 * One step in an agent turn timeline. Mirrors the orchestrator's event
 * stream, with adjacent message_delta frames coalesced into a single
 * "message" step so the UI can render incremental assistant text without
 * thousands of DOM nodes.
 */
export type AgentStep =
  | {
      kind: "tool_call";
      callId: string;
      name: string;
      args: unknown;
      result?: ToolResult<unknown>;
      /**
       * True after the user explicitly confirmed this tool. Used by
       * confirmation-gated tools (read_confirmed_file, run_file_task) to
       * decide whether to show file body content verbatim.
       */
      confirmed?: boolean;
    }
  | { kind: "message"; text: string };

export interface PendingConfirmation {
  token: string;
  toolName: string;
  args: unknown;
  preview: unknown;
  candidates?: unknown[];
}

/**
 * Renders the assistant's side of an agent turn: a vertical timeline of
 * tool chips + assistant messages, an optional confirmation card, and a
 * pending "Working…" indicator.
 *
 * The component is intentionally state-light — it's a pure projection of
 * `steps` + `pending*` flags so multiple panels (capture / chat) can
 * drive it from their own SSE plumbing.
 */
export function AgentTurnTimeline({
  steps,
  finalMessage,
  pending,
  pendingConfirmation,
  onConfirm,
  onCancel,
  busy,
  error,
}: {
  steps: AgentStep[];
  finalMessage?: string;
  pending?: boolean;
  pendingConfirmation?: PendingConfirmation;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  error?: string;
}) {
  if (error) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
        <div className="mb-0.5 text-[10px] uppercase tracking-wider text-red-300/80">
          Error
        </div>
        {error}
      </div>
    );
  }

  if (
    steps.length === 0 &&
    !finalMessage &&
    !pendingConfirmation &&
    pending
  ) {
    return (
      <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated px-3 py-2 text-xs text-ink-muted">
        <ThinkingDots />
        <span>Working…</span>
      </div>
    );
  }

  return (
    <div>
      <Timeline steps={steps} finalMessage={finalMessage} />
      {pendingConfirmation ? (
        <ConfirmationCard
          pending={pendingConfirmation}
          onConfirm={onConfirm}
          onCancel={onCancel}
          busy={busy}
        />
      ) : null}
      {pending && !pendingConfirmation ? (
        <div className="mt-2 inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated px-3 py-2 text-xs text-ink-muted">
          <ThinkingDots />
          <span>Working…</span>
        </div>
      ) : null}
    </div>
  );
}

function Timeline({
  steps,
  finalMessage,
}: {
  steps: AgentStep[];
  finalMessage?: string;
}) {
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => {
        if (step.kind === "message") {
          return (
            <li key={i}>
              <MessageStep text={step.text} />
            </li>
          );
        }
        // For tool_calls, we keep the compact chip (tool name + args +
        // status) so the agent's action trail stays scannable, AND —
        // for tools whose whole point is to produce long-form content
        // (summarize / answer / file read) — we surface that content
        // as a first-class chat-bubble right underneath. This is what
        // makes "summarize that note" feel like a reply instead of a
        // debug artifact hidden behind an expand arrow.
        const inline = extractInlineContent(step);
        return (
          <li key={i} className="space-y-2">
            <ToolStepChip step={step} />
            {inline ? <MessageStep text={inline} /> : null}
          </li>
        );
      })}
      {finalMessage && !lastStepIsMatchingMessage(steps, finalMessage) ? (
        <li>
          <MessageStep text={finalMessage} />
        </li>
      ) : null}
    </ol>
  );
}

/**
 * Pull the "user-facing" markdown payload out of a finished tool call,
 * if the tool is one whose result the user explicitly asked for
 * (summaries, answers, confirmed file reads). Returns undefined when
 * there's nothing to surface inline — the chip alone is enough.
 *
 * We DON'T re-check `step.confirmed` here: confirmation is enforced on
 * the server (gated tools can't run without a valid token), so once
 * we have `result.ok === true` the content is approved by definition.
 * That matters for persisted turns too, where the client-side
 * `confirmed` flag is lost on reload but the successful result isn't.
 */
function extractInlineContent(
  step: Extract<AgentStep, { kind: "tool_call" }>
): string | undefined {
  const result = step.result;
  if (!result || !result.ok) return undefined;
  const data = (result as { ok: true; data: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;
  if (step.name === "run_file_task") {
    const md = obj.markdown;
    return typeof md === "string" && md.trim().length > 0 ? md : undefined;
  }
  if (step.name === "read_confirmed_file") {
    const content = obj.content;
    return typeof content === "string" && content.trim().length > 0
      ? content
      : undefined;
  }
  if (step.name === "answer_from_vault") {
    const ans = obj.answer;
    return typeof ans === "string" && ans.trim().length > 0 ? ans : undefined;
  }
  return undefined;
}

function lastStepIsMatchingMessage(
  steps: AgentStep[],
  finalMessage: string
): boolean {
  const last = steps[steps.length - 1];
  if (!last || last.kind !== "message") return false;
  return last.text.trim() === finalMessage.trim();
}

function MessageStep({ text }: { text: string }) {
  return (
    <div className="rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated px-3 py-2 text-sm leading-relaxed text-ink">
      <Markdown text={text} />
    </div>
  );
}

export function ToolStepChip({
  step,
}: {
  step: Extract<AgentStep, { kind: "tool_call" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const argsPreview = previewArgs(step.args);
  const finished = Boolean(step.result);
  const ok = step.result?.ok === true;

  return (
    <div className="rounded-md border border-bg-border bg-bg/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] hover:bg-bg-elevated/40"
      >
        <span
          className={`pill ${
            !finished
              ? "border-amber-500/40 text-amber-200"
              : ok
                ? "border-emerald-500/40 text-emerald-300"
                : "border-red-500/40 text-red-300"
          }`}
        >
          {step.name}
        </span>
        <span className="truncate font-mono text-ink-dim">{argsPreview}</span>
        {!finished ? (
          <span className="ml-auto inline-flex items-center gap-1 text-ink-dim">
            <Spinner size={10} />
            running
          </span>
        ) : (
          <span className="ml-auto text-ink-dim">{expanded ? "▾" : "▸"}</span>
        )}
      </button>

      {expanded && finished ? (
        <div className="border-t border-bg-border px-2 py-2">
          <ActionResultCard
            toolName={step.name}
            result={step.result!}
            confirmed={step.confirmed}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ConfirmationCard({
  pending,
  onConfirm,
  onCancel,
  busy,
}: {
  pending: PendingConfirmation;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="mt-2 rounded-md border border-sky-500/30 bg-sky-500/10 p-3">
      <div className="flex items-center gap-2">
        <span className="pill">{pending.toolName}</span>
        <span className="pill capitalize text-sky-200">
          needs confirmation
        </span>
      </div>
      <div className="mt-2 text-sm text-ink">
        The agent wants to run{" "}
        <code className="font-mono">{pending.toolName}</code>. This action
        is gated — confirm to proceed.
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-bg p-2 text-[11px] text-ink-muted">
        {safeJson(pending.preview)}
      </pre>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn-primary"
          onClick={onConfirm}
          disabled={busy}
        >
          Confirm
        </button>
        <button
          type="button"
          className="rounded-md border border-bg-border bg-bg px-3 py-1.5 text-sm text-ink hover:bg-bg-elevated"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- Stream helpers ----

/**
 * Discriminated union of orchestrator SSE event payloads. Re-declared
 * here (instead of imported) so client bundles don't pull in any
 * server-only orchestrator deps.
 */
export type AgentSseEvent =
  | { type: "tool_call"; callId: string; name: string; args: unknown }
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
      candidates?: unknown[];
    }
  | { type: "final"; message: string };

/**
 * Fold one orchestrator SSE event into the agent timeline state. Returns
 * the next snapshot so callers can drive React via `setState(prev =>
 * applyAgentEvent(prev, ev))`.
 *
 * `confirmedNext` is consumed and reset by the first `tool_call` it sees
 * so confirmation-gated tools render their body verbatim only when the
 * call is the resumption of an explicit user confirmation.
 */
export interface AgentTurnState {
  steps: AgentStep[];
  finalMessage?: string;
  pendingConfirmation?: PendingConfirmation;
  confirmedNext: boolean;
}

export function emptyAgentTurn(confirmedNext = false): AgentTurnState {
  return { steps: [], confirmedNext };
}

export function applyAgentEvent(
  prev: AgentTurnState,
  ev: AgentSseEvent
): AgentTurnState {
  if (ev.type === "tool_call") {
    const confirmed = prev.confirmedNext;
    return {
      ...prev,
      confirmedNext: false,
      steps: [
        ...prev.steps,
        {
          kind: "tool_call",
          callId: ev.callId,
          name: ev.name,
          args: ev.args,
          confirmed,
        },
      ],
    };
  }
  if (ev.type === "tool_result") {
    return {
      ...prev,
      steps: prev.steps.map((s) =>
        s.kind === "tool_call" && s.callId === ev.callId
          ? { ...s, result: ev.result }
          : s
      ),
    };
  }
  if (ev.type === "message_delta") {
    const steps = [...prev.steps];
    const lastIdx = steps.length - 1;
    if (lastIdx >= 0 && steps[lastIdx]?.kind === "message") {
      const target = steps[lastIdx] as Extract<AgentStep, { kind: "message" }>;
      steps[lastIdx] = { ...target, text: target.text + ev.text };
    } else {
      steps.push({ kind: "message", text: ev.text });
    }
    return { ...prev, steps };
  }
  if (ev.type === "needs_confirmation") {
    return {
      ...prev,
      pendingConfirmation: {
        token: ev.token,
        toolName: ev.toolName,
        args: ev.args,
        preview: ev.preview,
        candidates: ev.candidates,
      },
    };
  }
  if (ev.type === "final") {
    return { ...prev, finalMessage: ev.message };
  }
  return prev;
}

function previewArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 2);
  if (entries.length === 0) return "{}";
  return entries
    .map(([k, v]) => {
      if (typeof v === "string") {
        const trimmed = v.length > 40 ? v.slice(0, 40) + "…" : v;
        return `${k}: "${trimmed}"`;
      }
      try {
        return `${k}: ${JSON.stringify(v)}`;
      } catch {
        return `${k}: ?`;
      }
    })
    .join(", ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
