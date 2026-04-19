"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatSessionList, type SessionSummary } from "./ChatSessionList";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "@/lib/types";

interface SessionFull {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  transcriptPath?: string;
  messages: ChatMessage[];
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
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load");
      setSessions(json.data.sessions as SessionSummary[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      await refreshSessions();
      return session;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setCreating(false);
    }
  }

  function selectSession(id: string) {
    if (current?.id === id) return;
    // Sessions are kept server-side (in memory). For MVP we don't refetch
    // full message history per session; the user sees their live session.
    // If reloading the page, the user starts a new chat (vault transcript persists).
    if (current?.id !== id) {
      const found = sessions.find((s) => s.id === id);
      if (found) {
        setCurrent({
          id: found.id,
          title: found.title,
          createdAt: found.updatedAt,
          updatedAt: found.updatedAt,
          messages: current?.id === id ? current.messages : [],
        });
        setSummary(null);
      }
    }
  }

  async function sendMessage() {
    const value = draft.trim();
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
            };
            if (payload.messageId) assistantMessageId = payload.messageId;
            if (payload.delta) {
              assistantText += payload.delta;
              setStreamingText(assistantText);
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

  return (
    <div className="grid h-[calc(100vh-9rem)] grid-cols-1 gap-4 md:grid-cols-[260px,1fr]">
      <ChatSessionList
        sessions={sessions}
        currentId={current?.id ?? null}
        onSelect={selectSession}
        onCreate={() => void createSession()}
        creating={creating}
      />

      <div className="flex h-full min-h-0 flex-col rounded-xl border border-bg-border bg-bg-panel">
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div>
            <div className="text-sm font-semibold">
              {current?.title ?? "Start a new chat"}
            </div>
            {current?.transcriptPath ? (
              <div className="font-mono text-[11px] text-ink-dim">
                {current.transcriptPath}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn"
              onClick={summarize}
              disabled={!current || streaming || messageList.length === 0 || summarizing}
            >
              {summarizing ? "Summarizing…" : "Summarize"}
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
          <div className="border-t border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        ) : null}

        <div className="border-t border-bg-border p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything… (⌘/Ctrl + Enter to send)"
              rows={2}
              className="textarea resize-none"
              disabled={streaming}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={streaming || draft.trim().length === 0}
              onClick={sendMessage}
            >
              {streaming ? "…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
