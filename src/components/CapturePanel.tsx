"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ActionResultCard } from "./ActionResultCard";
import { MicButton } from "./MicButton";
import { ErrorBanner, Spinner, ThinkingDots } from "./Spinner";
import type { ToolResult } from "@/lib/agent/types";

/**
 * Voice metadata captured by the transcribe-only endpoint. Held in component
 * state from the moment the recording is transcribed until the (possibly
 * edited) text is actually submitted — at which point it travels with the
 * request so the backend can persist a Voice Log linked to the capture.
 */
interface PendingVoice {
  transcript: string;
  provider: string;
  model: string;
}

/**
 * One step in an agent turn timeline. Mirrors the orchestrator's event
 * stream, with adjacent message_delta frames coalesced into a single
 * "message" step so the UI can render incremental assistant text without
 * thousands of DOM nodes.
 */
type AgentStep =
  | {
      kind: "tool_call";
      callId: string;
      name: string;
      args: unknown;
      /**
       * Filled in once the matching `tool_result` arrives. Until then the
       * tool is rendered as "running…".
       */
      result?: ToolResult<unknown>;
      /**
       * True after the user explicitly confirmed this tool. Used by
       * confirmation-gated tools (read_confirmed_file, run_file_task) to
       * decide whether to show file body content verbatim.
       */
      confirmed?: boolean;
    }
  | { kind: "message"; text: string };

interface PendingConfirmation {
  token: string;
  toolName: string;
  args: unknown;
  preview: unknown;
  /**
   * Ranked candidate list that produced the gated args (typically from
   * the most recent `propose_open_file`). Carried alongside the pending
   * record so an ordinal follow-up like "the second one" reads naturally
   * even if the candidates already scrolled out of view.
   */
  candidates?: unknown[];
}

/**
 * Per-turn token accounting reported by the agent capture SSE `done`
 * frame. Mirrors the long-form chat panel's shape exactly so the
 * context-budget bar is identical across surfaces. All numbers are
 * estimates — see `bumpTurnUsage` server-side for the heuristic.
 */
interface TurnUsage {
  lastTurnTotalTokens?: number;
  lastTurnPromptTokens?: number;
  lastTurnCompletionTokens?: number;
  lastTurnCachedTokens?: number;
  sessionTotalTokens: number;
  nextPromptEstimateTokens: number;
  limitTokens: number;
}

const DEFAULT_TOKEN_LIMIT = 100_000;

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

interface HistoryEntry {
  id: string;
  inputText: string;
  fromVoice?: boolean;
  pending?: boolean;
  error?: string;
  createdAt: number;
  steps: AgentStep[];
  finalMessage?: string;
  pendingConfirmation?: PendingConfirmation;
  /** Set once the user confirms (or cancels) a pendingConfirmation. */
  confirmationOutcome?: "confirmed" | "cancelled";
}

export function CapturePanel() {
  const [text, setText] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [pendingVoice, setPendingVoice] = useState<PendingVoice | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [tokenLimit, setTokenLimit] = useState<number>(DEFAULT_TOKEN_LIMIT);
  const [lastTurn, setLastTurn] = useState<TurnUsage | null>(null);
  const [sessionTokensUsed, setSessionTokensUsed] = useState<number>(0);
  const [contextNow, setContextNow] = useState<number>(0);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // One agent session per CapturePanel instance, stored in a ref so the
  // ID is generated exactly once at mount and survives every re-render
  // unchanged. Persists across submits so the orchestrator can chain
  // tools and confirmations — and now also natural-language follow-ups
  // like "yes" / "the second one" — within a logical conversation.
  // Re-mounting the panel (page reload) starts a fresh one.
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) sessionIdRef.current = newSessionId();
  const sessionId = sessionIdRef.current;

  function pushEntry(entry: HistoryEntry) {
    setHistory((prev) => [...prev, entry].slice(-50));
  }

  function updateEntry(id: string, patch: Partial<HistoryEntry>) {
    setHistory((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...patch } : e))
    );
  }

  function patchEntry(
    id: string,
    updater: (entry: HistoryEntry) => HistoryEntry
  ) {
    setHistory((prev) => prev.map((e) => (e.id === id ? updater(e) : e)));
  }

  function applyTurnUsage(usage: TurnUsage) {
    setLastTurn(usage);
    setTokenLimit(usage.limitTokens);
    setSessionTokensUsed(usage.sessionTotalTokens);
    setContextNow(usage.nextPromptEstimateTokens);
  }

  const lastEntry = history[history.length - 1];
  const lastStepCount = lastEntry?.steps.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, lastStepCount]);

  /**
   * Open an SSE stream against /api/agent/capture and pipe its events into
   * the matching history entry. Used by both the user-turn and the
   * confirmation flows.
   *
   * `confirmationContext` is set when this stream is the resumption of a
   * previously-confirmed tool call: the FIRST tool_call event that comes
   * back is the gated tool the user just approved, and we tag it so the
   * renderer can show its body verbatim.
   */
  async function streamAgentEvents(
    requestBody: Record<string, unknown>,
    entryId: string,
    options: { confirmationContext?: boolean } = {}
  ) {
    const res = await fetch("/api/agent/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${txt ? ` — ${txt}` : ""}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;
    let activeMessageStepId: number | null = null;
    // The first tool_call frame in a confirmation-resume stream is the
    // gated tool the user just approved; flag it so file-body renderers
    // know it's safe to display verbatim. Subsequent tool_calls in the
    // same stream are NOT confirmed (they're the orchestrator's follow-up).
    let nextToolIsConfirmed = options.confirmationContext === true;

    while (!done) {
      const { value: chunk, done: rdDone } = await reader.read();
      if (rdDone) break;
      buf += decoder.decode(chunk, { stream: true });

      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split("\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const ln of lines) {
          if (ln.startsWith(":")) continue;
          if (ln.startsWith("event:")) event = ln.slice(6).trim();
          else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trim());
        }
        const dataStr = dataLines.join("\n");
        if (event === "end") {
          done = true;
          break;
        }
        if (event === "error") {
          try {
            const e = JSON.parse(dataStr);
            throw new Error(e.message ?? "stream error");
          } catch {
            throw new Error(dataStr || "stream error");
          }
        }
        if (!dataStr) continue;

        let payload: unknown;
        try {
          payload = JSON.parse(dataStr);
        } catch {
          continue;
        }

        // Terminal `done` frame: carries per-turn token usage so the
        // capture chat's context-budget bar can refresh after every
        // turn (mirrors the long-form chat path).
        if (event === "done") {
          const p = payload as { usage?: TurnUsage };
          if (p.usage) applyTurnUsage(p.usage);
          continue;
        }

        const ev = payload as
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
              candidates?: unknown[];
            }
          | { type: "final"; message: string };

        if (ev.type === "tool_call") {
          // Reset the active message-step pointer so any text emitted AFTER
          // a tool call lands in a fresh step instead of being appended to
          // the previous assistant bubble.
          activeMessageStepId = null;
          const confirmed = nextToolIsConfirmed;
          nextToolIsConfirmed = false;
          patchEntry(entryId, (e) => ({
            ...e,
            steps: [
              ...e.steps,
              {
                kind: "tool_call",
                callId: ev.callId,
                name: ev.name,
                args: ev.args,
                confirmed,
              },
            ],
          }));
        } else if (ev.type === "tool_result") {
          patchEntry(entryId, (e) => ({
            ...e,
            steps: e.steps.map((s) =>
              s.kind === "tool_call" && s.callId === ev.callId
                ? { ...s, result: ev.result }
                : s
            ),
          }));
        } else if (ev.type === "message_delta") {
          // flushSync forces an immediate paint per token so the assistant
          // bubble streams visibly instead of materializing all-at-once
          // when React batches state updates.
          flushSync(() => {
            patchEntry(entryId, (e) => {
              const steps = [...e.steps];
              const lastIdx = steps.length - 1;
              if (
                activeMessageStepId !== null &&
                steps[activeMessageStepId]?.kind === "message"
              ) {
                const target = steps[activeMessageStepId] as Extract<
                  AgentStep,
                  { kind: "message" }
                >;
                steps[activeMessageStepId] = {
                  ...target,
                  text: target.text + ev.text,
                };
              } else if (lastIdx >= 0 && steps[lastIdx]?.kind === "message") {
                const target = steps[lastIdx] as Extract<
                  AgentStep,
                  { kind: "message" }
                >;
                steps[lastIdx] = {
                  ...target,
                  text: target.text + ev.text,
                };
                activeMessageStepId = lastIdx;
              } else {
                steps.push({ kind: "message", text: ev.text });
                activeMessageStepId = steps.length - 1;
              }
              return { ...e, steps };
            });
          });
        } else if (ev.type === "needs_confirmation") {
          activeMessageStepId = null;
          patchEntry(entryId, (e) => ({
            ...e,
            pendingConfirmation: {
              token: ev.token,
              toolName: ev.toolName,
              args: ev.args,
              preview: ev.preview,
              candidates: ev.candidates,
            },
          }));
        } else if (ev.type === "final") {
          activeMessageStepId = null;
          patchEntry(entryId, (e) => ({
            ...e,
            finalMessage: ev.message,
          }));
        }
      }
    }
  }

  async function submitText(overrides?: {
    text?: string;
    voice?: PendingVoice | null;
  }) {
    const value = (overrides?.text ?? text).trim();
    if (!value || textBusy) return;
    const voiceMeta = overrides?.voice ?? pendingVoice;

    setTextBusy(true);
    setGlobalError(null);
    const id = newEntryId();
    pushEntry({
      id,
      inputText: value,
      fromVoice: Boolean(voiceMeta),
      pending: true,
      createdAt: Date.now(),
      steps: [],
    });
    setText("");
    setPendingVoice(null);
    try {
      await streamAgentEvents(
        {
          sessionId,
          text: value,
          ...(voiceMeta ? { voice: voiceMeta } : {}),
        },
        id
      );
      updateEntry(id, { pending: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateEntry(id, { pending: false, error: msg });
      setGlobalError(msg);
    } finally {
      setTextBusy(false);
    }
  }

  /**
   * User clicked "Confirm" on a pending tool. POST the confirmation token
   * back to the same endpoint and stream the resumed agent loop into the
   * SAME history entry so the timeline reads continuously.
   */
  async function confirmPending(entryId: string) {
    const entry = history.find((e) => e.id === entryId);
    if (!entry?.pendingConfirmation) return;
    const token = entry.pendingConfirmation.token;
    setTextBusy(true);
    setGlobalError(null);
    patchEntry(entryId, (e) => ({
      ...e,
      pending: true,
      pendingConfirmation: undefined,
      confirmationOutcome: "confirmed",
    }));
    try {
      await streamAgentEvents(
        {
          sessionId,
          confirm: true,
          token,
        },
        entryId,
        { confirmationContext: true }
      );
      updateEntry(entryId, { pending: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateEntry(entryId, { pending: false, error: msg });
      setGlobalError(msg);
    } finally {
      setTextBusy(false);
    }
  }

  async function cancelPending(entryId: string) {
    // Server-acknowledged cancel: we POST { cancel, token } so the
    // orchestrator clears its pending record. Without this, the next
    // user turn would see the (stale) pending and inject it into the
    // LLM context — confusing the model and the user.
    const entry = history.find((e) => e.id === entryId);
    const token = entry?.pendingConfirmation?.token;
    patchEntry(entryId, (e) => ({
      ...e,
      pending: false,
      pendingConfirmation: undefined,
      confirmationOutcome: "cancelled",
      finalMessage: e.finalMessage ?? "(cancelled)",
    }));
    if (!token) return;
    try {
      // Best-effort — UI is already updated, so we deliberately don't
      // surface server errors back to the user. If the cancel POST fails
      // the next user turn's stale-discard logic will eventually clean
      // the pending up.
      await fetch("/api/agent/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, cancel: true, token }),
      });
    } catch {
      // swallow — see comment above.
    }
  }

  async function transcribeBlob(
    blob: Blob,
    mimeType: string
  ): Promise<{ text: string; voice: PendingVoice } | null> {
    setTranscribing(true);
    setGlobalError(null);
    try {
      const form = new FormData();
      form.append("audio", blob, `recording.${extFromMime(mimeType)}`);
      const res = await fetch("/api/capture/transcribe", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!json.ok) {
        const msg = json.error?.message ?? "Transcription failed";
        setGlobalError(msg);
        return null;
      }
      const data = json.data as {
        transcript: string;
        provider: string;
        model: string;
      };
      const trimmed = data.transcript.trim();
      if (!trimmed) {
        setGlobalError("Transcription returned empty text.");
        return null;
      }
      return {
        text: trimmed,
        voice: {
          transcript: data.transcript,
          provider: data.provider,
          model: data.model,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGlobalError(msg);
      return null;
    } finally {
      setTranscribing(false);
    }
  }

  async function handleRecordToText(blob: Blob, mimeType: string) {
    const out = await transcribeBlob(blob, mimeType);
    if (!out) return;
    setText((prev) =>
      prev ? `${prev.replace(/\s+$/, "")} ${out.text}` : out.text
    );
    setPendingVoice(out.voice);
    queueMicrotask(() => textRef.current?.focus());
  }

  async function handleRecordAndSend(blob: Blob, mimeType: string) {
    const out = await transcribeBlob(blob, mimeType);
    if (!out) return;
    await submitText({ text: out.text, voice: out.voice });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitText();
    }
  }

  const busy = textBusy || transcribing;

  const ctxPct =
    tokenLimit > 0 ? Math.min(100, (contextNow / tokenLimit) * 100) : 0;
  const ctxBarColor =
    ctxPct >= 95
      ? "bg-red-500"
      : ctxPct >= 75
        ? "bg-amber-500"
        : "bg-emerald-500";
  const lastCached = lastTurn?.lastTurnCachedTokens ?? 0;
  const lastPrompt = lastTurn?.lastTurnPromptTokens ?? 0;
  const cacheHitPct =
    lastPrompt > 0 ? Math.round((lastCached / lastPrompt) * 100) : 0;

  return (
    <div className="grid h-[calc(100vh-9rem)] grid-cols-1 gap-4 lg:grid-cols-[1fr,300px]">
      <div className="flex h-full min-h-0 flex-col rounded-xl border border-bg-border bg-bg-panel">
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Operational chat</div>
            <div className="truncate text-[11px] text-ink-dim">
              Iterative agent — chains tool calls (max 4 per turn) and asks
              before reading or deleting any vault file.
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div
              className="flex flex-col items-end gap-1"
              title={
                [
                  `Context window (next turn estimate): ${contextNow} tok`,
                  `Session cumulative (estimated): ${sessionTokensUsed} tok`,
                  lastTurn?.lastTurnTotalTokens !== undefined
                    ? `Last turn: ${lastTurn.lastTurnTotalTokens} tok` +
                      (lastTurn.lastTurnPromptTokens !== undefined
                        ? ` (prompt ${lastTurn.lastTurnPromptTokens}, completion ${lastTurn.lastTurnCompletionTokens})`
                        : "")
                    : null,
                  lastCached > 0
                    ? `Cached prompt: ${lastCached} tok (${cacheHitPct}% of prompt)`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n")
              }
            >
              <div className="flex items-baseline gap-1 font-mono text-[11px] text-ink-dim">
                <span className="text-ink-dim">ctx</span>
                <span className="text-ink">{formatTokens(contextNow)}</span>
                <span>/</span>
                <span>{formatTokens(tokenLimit)}</span>
                <span>tok</span>
                {lastTurn?.lastTurnTotalTokens !== undefined ? (
                  <span className="ml-1 text-emerald-400">
                    +{formatTokens(lastTurn.lastTurnTotalTokens)}
                  </span>
                ) : null}
                {lastCached > 0 ? (
                  <span
                    className="ml-1 rounded bg-sky-500/15 px-1 text-sky-300"
                    title={`${cacheHitPct}% of last prompt served from provider cache`}
                  >
                    cache {formatTokens(lastCached)}
                  </span>
                ) : null}
              </div>
              <div className="h-1 w-28 overflow-hidden rounded bg-bg-elevated">
                <div
                  className={`h-full ${ctxBarColor} transition-all`}
                  style={{ width: `${ctxPct}%` }}
                />
              </div>
              <div className="font-mono text-[10px] text-ink-dim">
                total {formatTokens(sessionTokensUsed)}
              </div>
            </div>
            {busy ? (
              <div className="flex items-center gap-2 text-[11px] text-ink-dim">
                <Spinner />
                <span>{transcribing ? "Transcribing…" : "Working…"}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {history.length === 0 ? (
            <EmptyCaptureState />
          ) : (
            history.map((entry) => (
              <CaptureTurn
                key={entry.id}
                entry={entry}
                onConfirm={() => confirmPending(entry.id)}
                onCancel={() => cancelPending(entry.id)}
                busy={textBusy}
              />
            ))
          )}
          <div ref={endRef} />
        </div>

        {globalError ? (
          <div className="border-t border-bg-border px-4 py-2">
            <ErrorBanner
              message={globalError}
              onDismiss={() => setGlobalError(null)}
            />
          </div>
        ) : null}

        <div className="border-t border-bg-border p-3">
          {pendingVoice ? (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true">🎙</span>
                <span>
                  Voice transcript ready — edit and Send, or discard.
                </span>
              </span>
              <button
                type="button"
                className="rounded px-2 py-0.5 text-ink-dim hover:bg-bg-elevated hover:text-ink"
                onClick={() => {
                  setPendingVoice(null);
                  setText("");
                }}
              >
                Discard
              </button>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <textarea
                ref={textRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder='Try "find file shopping list and add bread", "search vault for project ideas", "save a note"'
                rows={2}
                className="textarea resize-none"
                disabled={textBusy}
              />
              <div className="mt-1 flex items-center justify-between text-[11px] text-ink-dim">
                <span>⌘/Ctrl + Enter to send</span>
                {transcribing ? <span>Transcribing recording…</span> : null}
              </div>
            </div>
            <div className="flex flex-col items-stretch gap-2">
              <div className="flex gap-2">
                <MicButton
                  onRecorded={handleRecordToText}
                  disabled={busy}
                  idleLabel="To text"
                  idleTitle="Record → put transcript into the input box"
                />
                <MicButton
                  onRecorded={handleRecordAndSend}
                  disabled={busy}
                  idleLabel="Send"
                  idleTitle="Record → transcribe → send immediately"
                  variant="primary"
                />
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => submitText()}
                disabled={textBusy || text.trim().length === 0}
              >
                {textBusy ? (
                  <>
                    <Spinner />
                    Sending…
                  </>
                ) : (
                  "Send"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      <aside className="hidden h-full min-h-0 flex-col gap-4 overflow-y-auto lg:flex">
        <div className="card">
          <h3 className="text-sm font-semibold">How the agent works</h3>
          <p className="mt-2 text-xs text-ink-muted">
            The agent picks tools turn by turn. You&rsquo;ll see each call as
            a chip with a collapsible result. Reading or deleting a file
            requires you to confirm — file bodies are never loaded without
            your explicit approval.
          </p>
        </div>
        <div className="card">
          <h3 className="text-sm font-semibold">Available tools</h3>
          <ul className="mt-2 space-y-2 text-xs text-ink-muted">
            <li>
              <strong className="text-ink">save_note</strong> — drop a note
              into <code className="text-ink-dim">Inbox/</code>
            </li>
            <li>
              <strong className="text-ink">create_task</strong> /{" "}
              <strong className="text-ink">complete_task</strong> — manage
              your task list
            </li>
            <li>
              <strong className="text-ink">search_vault</strong> /{" "}
              <strong className="text-ink">find_file</strong> /{" "}
              <strong className="text-ink">propose_open_file</strong> —
              read-only lookup, no file bodies
            </li>
            <li>
              <strong className="text-ink">answer_from_vault</strong> — Q&amp;A
              over note heads (bounded read)
            </li>
            <li>
              <strong className="text-ink">read_confirmed_file</strong> /{" "}
              <strong className="text-ink">run_file_task</strong> /{" "}
              <strong className="text-ink">soft_delete</strong> — gated by
              confirmation
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function EmptyCaptureState() {
  return (
    <div className="grid h-full place-items-center text-sm text-ink-dim">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full border border-bg-border bg-bg-elevated text-base">
          ⚡
        </div>
        <div className="text-ink">Operational chat</div>
        <p className="mt-1 text-xs text-ink-dim">
          Type or record a request. The agent picks tools and runs them
          against your vault, asking before reading or deleting anything.
        </p>
      </div>
    </div>
  );
}

function CaptureTurn({
  entry,
  onConfirm,
  onCancel,
  busy,
}: {
  entry: HistoryEntry;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <article className="space-y-2">
      <UserBubble entry={entry} />
      <AssistantSlot
        entry={entry}
        onConfirm={onConfirm}
        onCancel={onCancel}
        busy={busy}
      />
    </article>
  );
}

function UserBubble({ entry }: { entry: HistoryEntry }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2 text-sm leading-relaxed text-white">
        {entry.fromVoice ? (
          <span
            className="mr-1.5 align-middle text-[11px] opacity-80"
            aria-label="from voice"
          >
            🎙
          </span>
        ) : null}
        {entry.inputText}
      </div>
    </div>
  );
}

function AssistantSlot({
  entry,
  onConfirm,
  onCancel,
  busy,
}: {
  entry: HistoryEntry;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  if (entry.error) {
    return (
      <AssistantWrap>
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-red-300/80">
            Error
          </div>
          {entry.error}
        </div>
      </AssistantWrap>
    );
  }

  if (entry.steps.length === 0 && !entry.finalMessage && !entry.pendingConfirmation) {
    return (
      <AssistantWrap>
        <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated px-3 py-2 text-xs text-ink-muted">
          <ThinkingDots />
          <span>Working…</span>
        </div>
      </AssistantWrap>
    );
  }

  return (
    <AssistantWrap>
      <Timeline entry={entry} />
      {entry.pendingConfirmation ? (
        <ConfirmationCard
          pending={entry.pendingConfirmation}
          onConfirm={onConfirm}
          onCancel={onCancel}
          busy={busy}
        />
      ) : null}
      {entry.pending && !entry.pendingConfirmation ? (
        <div className="mt-2 inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated px-3 py-2 text-xs text-ink-muted">
          <ThinkingDots />
          <span>Working…</span>
        </div>
      ) : null}
    </AssistantWrap>
  );
}

function AssistantWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%]">{children}</div>
    </div>
  );
}

function Timeline({ entry }: { entry: HistoryEntry }) {
  return (
    <ol className="space-y-2">
      {entry.steps.map((step, i) => (
        <li key={i}>
          {step.kind === "tool_call" ? (
            <ToolStep step={step} />
          ) : (
            <MessageStep text={step.text} />
          )}
        </li>
      ))}
      {entry.finalMessage && !lastStepIsMatchingMessage(entry) ? (
        <li>
          <MessageStep text={entry.finalMessage} />
        </li>
      ) : null}
    </ol>
  );
}

function lastStepIsMatchingMessage(entry: HistoryEntry): boolean {
  const last = entry.steps[entry.steps.length - 1];
  if (!last || last.kind !== "message") return false;
  return last.text.trim() === (entry.finalMessage ?? "").trim();
}

function MessageStep({ text }: { text: string }) {
  return (
    <div className="rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated px-3 py-2 text-sm leading-relaxed text-ink whitespace-pre-wrap">
      {text}
    </div>
  );
}

function ToolStep({
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

function ConfirmationCard({
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

function previewArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  // Show the first 2 string-ish fields so the chip is informative without
  // being overwhelming. Numbers / arrays are stringified compactly.
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

function newEntryId(): string {
  return `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function newSessionId(): string {
  return `panel_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function extFromMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}
