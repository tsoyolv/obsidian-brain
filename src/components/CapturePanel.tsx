"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ActionResultCard } from "./ActionResultCard";
import { MicButton } from "./MicButton";
import { ErrorBanner, Spinner, ThinkingDots } from "./Spinner";
import type { CaptureActionResult, CaptureIntent } from "@/lib/types";

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

interface HistoryEntry {
  id: string;
  inputText: string;
  /** True when this entry originated from a voice recording. */
  fromVoice?: boolean;
  pending?: boolean;
  error?: string;
  createdAt: number;
  result?: CaptureActionResult;
  /** Intent returned by the classifier, set before `result` arrives. */
  classifiedIntent?: CaptureIntent;
  /** Accumulated assistant answer for `ask_vault_question`, while streaming. */
  streamingText?: string;
}

const INTENT_LABEL: Record<string, string> = {
  note: "Saved note",
  create_task: "Created task",
  complete_task: "Completed task",
  search: "Search",
  ask_vault_question: "Vault Q&A",
  find_file: "Find file",
  open_file_for_task: "Open file",
  unknown: "Unknown",
};

export function CapturePanel() {
  const [text, setText] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [pendingVoice, setPendingVoice] = useState<PendingVoice | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  function pushEntry(entry: HistoryEntry) {
    // Operational chat reads top-down (oldest first), bounded to the last 50
    // turns so the DOM stays cheap on long sessions.
    setHistory((prev) => [...prev, entry].slice(-50));
  }

  function updateEntry(id: string, patch: Partial<HistoryEntry>) {
    setHistory((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  const lastEntry = history[history.length - 1];
  const lastStreamingText = lastEntry?.streamingText;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, lastStreamingText]);

  /**
   * Submit the current draft. When `overrides` are passed, they take precedence
   * over component state — used by the "transcribe-and-send" flow which has
   * the freshly transcribed text/voice metadata before React has re-rendered.
   */
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
    });
    setText("");
    setPendingVoice(null);
    try {
      const res = await fetch("/api/capture/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: value,
          ...(voiceMeta ? { voice: voiceMeta } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${txt ? ` — ${txt}` : ""}`);
      }

      let streamingText = "";
      let finalResult: CaptureActionResult | undefined;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;

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
            if (ln.startsWith(":")) continue; // SSE comment; keep-alive preamble
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

          try {
            const payload = JSON.parse(dataStr) as
              | { type: "classified"; intent: CaptureIntent }
              | { type: "delta"; text: string }
              | { type: "result"; result: CaptureActionResult };

            if (payload.type === "classified") {
              flushSync(() =>
                updateEntry(id, { classifiedIntent: payload.intent })
              );
            } else if (payload.type === "delta") {
              streamingText += payload.text;
              // flushSync bypasses React 18 automatic batching so each token
              // delta forces an immediate paint — otherwise the UI looks like
              // it writes word-by-word instead of streaming smoothly.
              flushSync(() => updateEntry(id, { streamingText }));
            } else if (payload.type === "result") {
              finalResult = payload.result;
            }
          } catch {
            // Ignore malformed frames; next ones may still be valid.
          }
        }
      }

      if (finalResult) {
        updateEntry(id, {
          pending: false,
          result: finalResult,
          streamingText: undefined,
        });
      } else {
        updateEntry(id, { pending: false, error: "Stream ended without result" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateEntry(id, { pending: false, error: msg });
      setGlobalError(msg);
    } finally {
      setTextBusy(false);
    }
  }

  /**
   * Send recorded audio to the transcribe-only endpoint. Returns the voice
   * metadata + text on success, or null on failure (after surfacing the error).
   */
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

  /**
   * "Mic → text" flow: transcribe and drop the result into the textarea so the
   * user can review/edit it before pressing Send themselves.
   */
  async function handleRecordToText(blob: Blob, mimeType: string) {
    const out = await transcribeBlob(blob, mimeType);
    if (!out) return;
    // Append to whatever the user already typed so they don't lose context;
    // when the textarea is empty (the common case) this is just the transcript.
    setText((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${out.text}` : out.text));
    setPendingVoice(out.voice);
    // Move focus to the textarea so editing feels natural.
    queueMicrotask(() => textRef.current?.focus());
  }

  /**
   * "Mic → send" flow: transcribe and immediately submit. We pass the fresh
   * values via overrides so the network request doesn't race React's
   * setState batching.
   */
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

  return (
    <div className="grid h-[calc(100vh-9rem)] grid-cols-1 gap-4 lg:grid-cols-[1fr,300px]">
      <div className="flex h-full min-h-0 flex-col rounded-xl border border-bg-border bg-bg-panel">
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Operational chat</div>
            <div className="truncate text-[11px] text-ink-dim">
              Quick captures, tasks, search and vault Q&amp;A. Each turn is
              persisted to your vault.
            </div>
          </div>
          {busy ? (
            <div className="flex items-center gap-2 text-[11px] text-ink-dim">
              <Spinner />
              <span>{transcribing ? "Transcribing…" : "Working…"}</span>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {history.length === 0 ? (
            <EmptyCaptureState />
          ) : (
            history.map((entry) => (
              <CaptureTurn key={entry.id} entry={entry} />
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
                placeholder='Try "save a note about the meeting", "create task buy milk", "find file shopping list"'
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
          <h3 className="text-sm font-semibold">How voice works</h3>
          <p className="mt-2 text-xs text-ink-muted">
            Two mic buttons:{" "}
            <strong className="text-ink">🎙 To text</strong> records and drops
            the transcript into the input box so you can edit it first.{" "}
            <strong className="text-ink">🎙 Send</strong> records and submits
            immediately. In both cases a Voice Log is saved to{" "}
            <code className="text-ink-dim">Voice Logs/</code> only when the
            message is actually sent.
          </p>
        </div>
        <div className="card">
          <h3 className="text-sm font-semibold">Capture intents</h3>
          <ul className="mt-2 space-y-2 text-xs text-ink-muted">
            <li>
              <strong className="text-ink">note</strong> — save a thought into{" "}
              <code className="text-ink-dim">Inbox/</code>
            </li>
            <li>
              <strong className="text-ink">create_task</strong> — append to
              today's task file in <code className="text-ink-dim">Tasks/</code>
            </li>
            <li>
              <strong className="text-ink">complete_task</strong> — fuzzy-match
              an open task and check it off
            </li>
            <li>
              <strong className="text-ink">search</strong> — keyword search over
              the vault
            </li>
            <li>
              <strong className="text-ink">ask_vault_question</strong> —
              question-answer over note content
            </li>
            <li>
              <strong className="text-ink">find_file</strong> — locate files by
              name only (no contents read)
            </li>
            <li>
              <strong className="text-ink">open_file_for_task</strong> — surface
              a single matching file and ask for confirmation before reading it
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
          Type a request or record your voice. The classifier picks an action
          (save note, create task, search, …) and runs it against your vault.
        </p>
      </div>
    </div>
  );
}

function CaptureTurn({ entry }: { entry: HistoryEntry }) {
  return (
    <article className="space-y-2">
      <UserBubble entry={entry} />
      <AssistantSlot entry={entry} />
    </article>
  );
}

function UserBubble({ entry }: { entry: HistoryEntry }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2 text-sm leading-relaxed text-white">
        {entry.fromVoice ? (
          <span className="mr-1.5 align-middle text-[11px] opacity-80" aria-label="from voice">
            🎙
          </span>
        ) : null}
        {entry.inputText}
      </div>
    </div>
  );
}

function AssistantSlot({ entry }: { entry: HistoryEntry }) {
  if (entry.pending) {
    return <PendingBubble entry={entry} />;
  }
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
  if (entry.result) {
    return (
      <AssistantWrap>
        <ActionResultCard result={entry.result} />
      </AssistantWrap>
    );
  }
  return null;
}

function AssistantWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%]">{children}</div>
    </div>
  );
}

function PendingBubble({ entry }: { entry: HistoryEntry }) {
  if (
    entry.classifiedIntent === "ask_vault_question" &&
    entry.streamingText
  ) {
    return (
      <AssistantWrap>
        <div className="card">
          <div className="flex items-center gap-2">
            <span className="pill">Vault Q&amp;A</span>
            <span className="pill capitalize">streaming…</span>
          </div>
          <div className="mt-2 whitespace-pre-wrap text-sm text-ink">
            {entry.streamingText}
            <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-current align-middle" />
          </div>
        </div>
      </AssistantWrap>
    );
  }

  const label = entry.classifiedIntent
    ? `Working — ${INTENT_LABEL[entry.classifiedIntent] ?? entry.classifiedIntent}`
    : "Working";

  return (
    <AssistantWrap>
      <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated px-3 py-2 text-xs text-ink-muted">
        <ThinkingDots />
        <span>{label}…</span>
      </div>
    </AssistantWrap>
  );
}

function newEntryId(): string {
  return `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function extFromMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}
