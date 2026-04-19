"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChatSessionList, type SessionSummary } from "./ChatSessionList";
import { MessageBubble } from "./MessageBubble";
import { MicButton } from "./MicButton";
import { ErrorBanner, SkeletonLines, Spinner, ThinkingDots } from "./Spinner";
import type { ChatMessage } from "@/lib/types";

interface SessionFull {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  transcriptPath?: string;
  messages: ChatMessage[];
  totalTokensUsed?: number;
  nextPromptEstimateTokens?: number;
}

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

export function ChatPanel() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<SessionFull | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ path: string; text: string } | null>(
    null
  );
  const [summarizing, setSummarizing] = useState(false);
  const [tokenLimit, setTokenLimit] = useState<number>(DEFAULT_TOKEN_LIMIT);
  const [lastTurn, setLastTurn] = useState<TurnUsage | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [transcribing, setTranscribing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load");
      setSessions(json.data.sessions as SessionSummary[]);
      if (typeof json.data.tokenLimit === "number") {
        setTokenLimit(json.data.tokenLimit);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [current?.messages.length, streamingText]);

  async function createSession(): Promise<SessionFull | null> {
    if (creating) return null;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed");
      const session = json.data as SessionFull;
      setCurrent(session);
      setSummary(null);
      setLastTurn(null);
      if (typeof json.data.tokenLimit === "number") {
        setTokenLimit(json.data.tokenLimit);
      }
      await refreshSessions();
      return session;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setCreating(false);
    }
  }

  async function selectSession(id: string) {
    if (current?.id === id) return;
    const found = sessions.find((s) => s.id === id);
    if (!found) return;

    // Show the header immediately so the panel doesn't look frozen, then
    // hydrate the message history from the vault transcript via the API.
    setCurrent({
      id: found.id,
      title: found.title,
      createdAt: found.updatedAt,
      updatedAt: found.updatedAt,
      messages: [],
      totalTokensUsed: found.totalTokensUsed,
      nextPromptEstimateTokens: found.nextPromptEstimateTokens,
    });
    setSummary(null);
    setLastTurn(null);
    setError(null);
    setLoadingSession(true);

    try {
      const res = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load session");
      const full = json.data as SessionFull & { tokenLimit?: number };
      // Guard against the user clicking another session while this one was
      // still loading — only commit if it's still the active selection.
      setCurrent((prev) => (prev?.id === id ? full : prev));
      if (typeof json.data.tokenLimit === "number") {
        setTokenLimit(json.data.tokenLimit);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSession(false);
    }
  }

  async function sendMessage(overrideText?: string) {
    const value = (overrideText ?? draft).trim();
    if (!value || streaming) return;
    let session = current;
    if (!session) {
      session = await createSession();
      if (!session) return;
    }

    setStreaming(true);
    setError(null);
    setStreamingText("");
    setDraft("");

    const userMsg: ChatMessage = {
      id: `local_${Date.now()}`,
      role: "user",
      content: value,
      createdAt: new Date().toISOString(),
    };
    setCurrent((prev) =>
      prev ? { ...prev, messages: [...prev.messages, userMsg] } : prev
    );

    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, content: value }),
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Stream failed: ${res.status} ${txt}`);
      }

      let assistantMessageId = "assistant_pending";
      let assistantText = "";

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;

      while (!done) {
        const { value: chunk, done: rdDone } = await reader.read();
        if (rdDone) break;
        buf += decoder.decode(chunk, { stream: true });

        // Parse SSE frames separated by blank lines.
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = frame.split("\n");
          let event = "message";
          const dataLines: string[] = [];
          for (const ln of lines) {
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
            const payload = JSON.parse(dataStr) as {
              delta: string;
              done: boolean;
              messageId: string;
              usage?: TurnUsage;
            };
            if (payload.messageId) assistantMessageId = payload.messageId;
            if (payload.delta) {
              assistantText += payload.delta;
              // flushSync bypasses React 18 automatic batching so every
              // token chunk forces an immediate paint — otherwise deltas
              // that arrive in the same microtask get coalesced into one
              // render and the UI looks like it writes word-by-word.
              flushSync(() => setStreamingText(assistantText));
            }
            if (payload.usage) {
              const u = payload.usage;
              setLastTurn(u);
              setTokenLimit(u.limitTokens);
              setCurrent((prev) =>
                prev
                  ? {
                      ...prev,
                      totalTokensUsed: u.sessionTotalTokens,
                      nextPromptEstimateTokens: u.nextPromptEstimateTokens,
                    }
                  : prev
              );
            }
            if (payload.done) {
              done = true;
              break;
            }
          } catch {
            // Ignore malformed frames; the next ones may still be valid.
          }
        }
      }

      const finalAssistant: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: assistantText,
        createdAt: new Date().toISOString(),
      };
      setCurrent((prev) =>
        prev ? { ...prev, messages: [...prev.messages, finalAssistant] } : prev
      );
      setStreamingText("");
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStreaming(false);
    }
  }

  /**
   * Transcribe a recorded audio blob via the transcribe-only endpoint and
   * return the recognized text (or null on failure, after surfacing the error).
   * Unlike CapturePanel, the chat flow does NOT persist a Voice Log — the
   * transcript just becomes a regular user turn in the conversation.
   */
  async function transcribeBlob(
    blob: Blob,
    mimeType: string
  ): Promise<string | null> {
    setTranscribing(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("audio", blob, `recording.${extFromMime(mimeType)}`);
      const res = await fetch("/api/capture/transcribe", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? "Transcription failed");
        return null;
      }
      const transcript = String(json.data?.transcript ?? "").trim();
      if (!transcript) {
        setError("Transcription returned empty text.");
        return null;
      }
      return transcript;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setTranscribing(false);
    }
  }

  async function handleRecordToText(blob: Blob, mimeType: string) {
    const text = await transcribeBlob(blob, mimeType);
    if (!text) return;
    // Append to whatever the user already typed so partial drafts survive
    // a follow-up dictation.
    setDraft((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${text}` : text));
    queueMicrotask(() => draftRef.current?.focus());
  }

  async function handleRecordAndSend(blob: Blob, mimeType: string) {
    const text = await transcribeBlob(blob, mimeType);
    if (!text) return;
    await sendMessage(text);
  }

  async function summarize() {
    if (!current || summarizing) return;
    setSummarizing(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: current.id }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed");
      setSummary({ path: json.data.summaryPath, text: json.data.summary });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSummarizing(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  }

  const messageList = useMemo(() => current?.messages ?? [], [current]);

  const sessionTokensUsed = current?.totalTokensUsed ?? 0;
  // Context window in use right now = what we'd send on the NEXT turn.
  // This is the number that matters for hitting the 100k hard cap, since
  // the cumulative session total also includes completion tokens that
  // never travel back as input.
  const contextNow = current?.nextPromptEstimateTokens ?? 0;
  const ctxPct = tokenLimit > 0 ? Math.min(100, (contextNow / tokenLimit) * 100) : 0;
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
    <div className="grid h-[calc(100vh-9rem)] grid-cols-1 gap-4 md:grid-cols-[260px,1fr]">
      <ChatSessionList
        sessions={sessions}
        currentId={current?.id ?? null}
        onSelect={selectSession}
        onCreate={() => void createSession()}
        creating={creating}
        loading={loadingSessions}
      />

      <div className="flex h-full min-h-0 flex-col rounded-xl border border-bg-border bg-bg-panel">
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {current?.title ?? "Discussion"}
            </div>
            {current?.transcriptPath ? (
              <div className="truncate font-mono text-[11px] text-ink-dim">
                {current.transcriptPath}
              </div>
            ) : (
              <div className="truncate text-[11px] text-ink-dim">
                Long-form conversations, streamed and saved to your vault.
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {current ? (
              <div
                className="flex flex-col items-end gap-1"
                title={
                  [
                    `Context window (next turn estimate): ${contextNow} tok`,
                    `Session cumulative (prompt + completion): ${sessionTokensUsed} tok`,
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
                      title={`${cacheHitPct}% of last prompt served from OpenAI cache`}
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
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={summarize}
              disabled={!current || streaming || messageList.length === 0 || summarizing}
            >
              {summarizing ? (
                <>
                  <Spinner />
                  Summarizing…
                </>
              ) : (
                "Summarize"
              )}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {!current ? (
            <div className="grid h-full place-items-center text-sm text-ink-dim">
              <div className="text-center">
                <div>No chat selected.</div>
                <button
                  className="btn-primary mt-3"
                  onClick={() => void createSession()}
                >
                  + New chat
                </button>
              </div>
            </div>
          ) : loadingSession && messageList.length === 0 ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-ink-dim">
                <Spinner />
                <span>Loading transcript…</span>
              </div>
              <div className="flex justify-end">
                <div className="w-2/3 max-w-md rounded-2xl rounded-br-md bg-bg-elevated p-3">
                  <SkeletonLines lines={2} />
                </div>
              </div>
              <div className="flex justify-start">
                <div className="w-3/4 max-w-md rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated p-3">
                  <SkeletonLines lines={4} />
                </div>
              </div>
            </div>
          ) : messageList.length === 0 && !streamingText ? (
            <div className="text-sm text-ink-dim">
              Send the first message to begin. Responses are streamed and the
              transcript is saved into your vault.
            </div>
          ) : (
            <>
              {messageList.map((m) => (
                <MessageBubble key={m.id} role={m.role} content={m.content} />
              ))}
              {streaming && streamingText ? (
                <MessageBubble role="assistant" content={streamingText} pending />
              ) : streaming ? (
                <div className="flex justify-start">
                  <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-panel px-3 py-2 text-xs text-ink-muted">
                    <ThinkingDots />
                    <span>Thinking…</span>
                  </div>
                </div>
              ) : null}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {summary ? (
          <div className="border-t border-bg-border bg-bg p-4">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-wider text-ink-dim">
                Summary saved
              </div>
              <div className="font-mono text-[11px] text-ink-dim">
                {summary.path}
              </div>
            </div>
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-bg-border bg-bg-elevated p-3 text-xs text-ink">
              {summary.text}
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="border-t border-bg-border px-4 py-2">
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        ) : null}

        <div className="border-t border-bg-border p-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <textarea
                ref={draftRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask anything… (⌘/Ctrl + Enter to send)"
                rows={2}
                className="textarea resize-none"
                disabled={streaming}
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
                  disabled={streaming || transcribing}
                  idleLabel="To text"
                  idleTitle="Record → put transcript into the input box"
                />
                <MicButton
                  onRecorded={handleRecordAndSend}
                  disabled={streaming || transcribing}
                  idleLabel="Send"
                  idleTitle="Record → transcribe → send immediately"
                  variant="primary"
                />
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={streaming || draft.trim().length === 0}
                onClick={() => sendMessage()}
              >
                {streaming ? (
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
    </div>
  );
}

function extFromMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

