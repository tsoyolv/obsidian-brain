"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ChatSessionList,
  type SessionSortMode,
  type SessionSummary,
} from "./ChatSessionList";
import { MessageBubble } from "./MessageBubble";
import { MicButton } from "./MicButton";
import { ErrorBanner, SkeletonLines, Spinner, ThinkingDots } from "./Spinner";
import {
  AgentTurnTimeline,
  applyAgentEvent,
  emptyAgentTurn,
  type AgentSseEvent,
  type AgentStep,
  type AgentTurnState,
  type PendingConfirmation,
} from "./AgentTimeline";
import { Markdown } from "./Markdown";
import type { ChatMessage, ChatSummary } from "@/lib/types";
import type { ToolResult } from "@/lib/agent/types";

interface SessionFull {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  transcriptPath?: string;
  messages: ChatMessage[];
  agentEnabled?: boolean;
  webSearchEnabled?: boolean;
  totalTokensUsed?: number;
  nextPromptEstimateTokens?: number;
  model?: string;
  tier?: "fast" | "standard" | "reasoning";
  chatSummary?: ChatSummary;
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

const DEFAULT_TOKEN_LIMIT = 180_000;

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Per-turn live state for the active agent run. Held outside `current` so
 * we can surgically update it on every SSE frame without churning the
 * whole session object (which would force the message list to re-render).
 *
 * Once the turn finishes, the timeline is left in place inside the
 * trailing assistant `MessageBubble` so the user can still inspect tool
 * chips after the stream closes.
 */
interface ActiveAgentTurn {
  userMessageId: string;
  assistantMessageId?: string;
  state: AgentTurnState;
  pending: boolean;
  error?: string;
}

export function ChatPanel() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sortMode, setSortMode] = useState<SessionSortMode>("updated_desc");
  const [current, setCurrent] = useState<SessionFull | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activeAgent, setActiveAgent] = useState<ActiveAgentTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [tokenLimit, setTokenLimit] = useState<number>(DEFAULT_TOKEN_LIMIT);
  const [lastTurn, setLastTurn] = useState<TurnUsage | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [transcribing, setTranscribing] = useState(false);
  const [togglingAgent, setTogglingAgent] = useState(false);
  const [togglingWebSearch, setTogglingWebSearch] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Points at the ChatSummaryCard when one is rendered. We scroll here
  // after a fresh Summarize so the user actually sees the card appear
  // at the top of a long chat (otherwise they just sit at the bottom
  // next to the button and it looks like "nothing happened").
  const summaryCardRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  // Guard so the auto-open-most-recent effect runs at most once per mount.
  // Without this, switching to a different chat would race with the
  // effect and snap us back to the freshest session on every refresh.
  const autoOpenedRef = useRef(false);
  // Guard against accidental double-finalization of the same agent turn.
  const lastAgentFinalizeKeyRef = useRef<string | null>(null);

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
    if (!current) return;
    const fresh = sessions.find((s) => s.id === current.id);
    if (!fresh) return;
    if (
      fresh.title === current.title &&
      fresh.updatedAt === current.updatedAt &&
      fresh.totalTokensUsed === current.totalTokensUsed &&
      fresh.nextPromptEstimateTokens === current.nextPromptEstimateTokens &&
      fresh.model === current.model &&
      fresh.tier === current.tier &&
      Boolean(fresh.agentEnabled) === Boolean(current.agentEnabled) &&
      Boolean(fresh.webSearchEnabled) === Boolean(current.webSearchEnabled)
    ) {
      return;
    }
    setCurrent((prev) =>
      prev && prev.id === fresh.id
        ? {
            ...prev,
            title: fresh.title,
            updatedAt: fresh.updatedAt,
            agentEnabled: fresh.agentEnabled,
            webSearchEnabled: fresh.webSearchEnabled,
            totalTokensUsed: fresh.totalTokensUsed,
            nextPromptEstimateTokens: fresh.nextPromptEstimateTokens,
            model: fresh.model,
            tier: fresh.tier,
          }
        : prev
    );
  }, [sessions, current]);

  // Auto-open the most recent chat once the session list first arrives.
  // Sessions come pre-sorted by `updatedAt DESC` from the server, so
  // `sessions[0]` is the freshest one. Runs at most once (`autoOpenedRef`)
  // so navigating between chats afterwards is sticky.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (loadingSessions) return;
    if (current) return;
    if (sessions.length === 0) return;
    const freshest = [...sessions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )[0];
    if (!freshest) return;
    autoOpenedRef.current = true;
    void selectSession(freshest.id);
    // selectSession is stable enough for our purposes; we deliberately
    // don't include it to avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingSessions, sessions, current]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    current?.messages.length,
    streamingText,
    activeAgent?.state.steps.length,
    activeAgent?.state.finalMessage,
  ]);

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
      setLastTurn(null);
      setActiveAgent(null);
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

    setCurrent({
      id: found.id,
      title: found.title,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
      messages: [],
      agentEnabled: found.agentEnabled,
      webSearchEnabled: found.webSearchEnabled,
      totalTokensUsed: found.totalTokensUsed,
      nextPromptEstimateTokens: found.nextPromptEstimateTokens,
      model: found.model,
      tier: found.tier,
    });
    setLastTurn(null);
    setActiveAgent(null);
    setError(null);
    setLoadingSession(true);

    try {
      const res = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load session");
      const full = json.data as SessionFull & { tokenLimit?: number };
      setCurrent((prev) => (prev?.id === id ? full : prev));
      if (typeof json.data.tokenLimit === "number") {
        setTokenLimit(json.data.tokenLimit);
      }
      // If this chat already has a saved summary, jump straight to the
      // summary card instead of dumping the user into the middle of a
      // long transcript. Two rAFs so we wait for the messages list to
      // render first (the card lives above it and needs layout).
      if (full.chatSummary) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            summaryCardRef.current?.scrollIntoView({
              behavior: "auto",
              block: "start",
            });
          });
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSession(false);
    }
  }

  /**
   * PATCH the session's `agentEnabled` flag. Optimistically updates local
   * state so the toggle feels instantaneous; rolls back on error.
   */
  async function toggleAgent(next: boolean) {
    if (!current || togglingAgent || streaming) return;
    setTogglingAgent(true);
    setError(null);
    const previous = current.agentEnabled ?? false;
    setCurrent((prev) => (prev ? { ...prev, agentEnabled: next } : prev));
    setSessions((prev) =>
      prev.map((s) => (s.id === current.id ? { ...s, agentEnabled: next } : s))
    );
    try {
      const res = await fetch(
        `/api/chat/sessions/${encodeURIComponent(current.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentEnabled: next }),
        }
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed");
    } catch (e) {
      setCurrent((prev) =>
        prev ? { ...prev, agentEnabled: previous } : prev
      );
      setSessions((prev) =>
        prev.map((s) =>
          s.id === current.id ? { ...s, agentEnabled: previous } : s
        )
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingAgent(false);
    }
  }

  /**
   * PATCH the session's `webSearchEnabled` flag. Independent from `agent`:
   * users can keep vault tools on while disabling external web lookups.
   */
  async function toggleWebSearch(next: boolean) {
    if (!current || togglingWebSearch || streaming) return;
    setTogglingWebSearch(true);
    setError(null);
    const previous = current.webSearchEnabled ?? true;
    setCurrent((prev) => (prev ? { ...prev, webSearchEnabled: next } : prev));
    setSessions((prev) =>
      prev.map((s) => (s.id === current.id ? { ...s, webSearchEnabled: next } : s))
    );
    try {
      const res = await fetch(
        `/api/chat/sessions/${encodeURIComponent(current.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ webSearchEnabled: next }),
        }
      );
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed");
    } catch (e) {
      setCurrent((prev) =>
        prev ? { ...prev, webSearchEnabled: previous } : prev
      );
      setSessions((prev) =>
        prev.map((s) =>
          s.id === current.id ? { ...s, webSearchEnabled: previous } : s
        )
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingWebSearch(false);
    }
  }

  /**
   * Stream a chat SSE response and dispatch frames into either the legacy
   * plain-chat handler (`delta`/`done`) or the agent timeline handler
   * (`tool_call` / `tool_result` / `message_delta` / `needs_confirmation`
   * / `final` / `done`). Both shapes share a single `end` terminator so
   * the loop is the same.
   *
   * `agentMode` is the SERVER's authoritative answer about which shape to
   * expect — set by inspecting the session before opening the stream so
   * the UI doesn't have to peek inside the first frame.
   */
  async function streamChatResponse(
    res: Response,
    agentMode: boolean,
    handlers: {
      onChatDelta: (delta: string) => void;
      onChatDone: (messageId: string, usage?: TurnUsage) => void;
      onAgentEvent: (ev: AgentSseEvent) => void;
      onAgentDone: (messageId: string, usage: TurnUsage) => void;
    }
  ): Promise<void> {
    if (!res.body) throw new Error("Stream missing body");
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
            const e = JSON.parse(dataStr) as { message?: string };
            throw new Error(e.message ?? "stream error");
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== "stream error") {
              throw parseErr;
            }
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

        if (!agentMode) {
          const p = payload as {
            delta?: string;
            done?: boolean;
            messageId?: string;
            usage?: TurnUsage;
          };
          if (p.delta) handlers.onChatDelta(p.delta);
          if (p.done) {
            handlers.onChatDone(p.messageId ?? "assistant_pending", p.usage);
            done = true;
            break;
          }
          continue;
        }

        // Agent path. The terminal `done` event carries usage; everything
        // else is a forwarded AgentEvent matching the capture-route shape.
        if (event === "done") {
          const p = payload as { messageId?: string; usage?: TurnUsage };
          if (p.usage) {
            handlers.onAgentDone(p.messageId ?? "assistant_pending", p.usage);
          }
          continue;
        }
        handlers.onAgentEvent(payload as AgentSseEvent);
      }
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
    const agentMode = Boolean(session.agentEnabled);

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

    if (agentMode) {
      setActiveAgent({
        userMessageId: userMsg.id,
        state: emptyAgentTurn(false),
        pending: true,
      });
    }

    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, content: value }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Stream failed: ${res.status} ${txt}`);
      }

      let assistantMessageId = "assistant_pending";
      let assistantText = "";

      await streamChatResponse(res, agentMode, {
        onChatDelta: (delta) => {
          assistantText += delta;
          flushSync(() => setStreamingText(assistantText));
        },
        onChatDone: (id, usage) => {
          assistantMessageId = id;
          if (usage) {
            applyTurnUsage(usage);
          }
        },
        onAgentEvent: (ev) => {
          flushSync(() => {
            setActiveAgent((prev) =>
              prev ? { ...prev, state: applyAgentEvent(prev.state, ev) } : prev
            );
          });
        },
        onAgentDone: (id, usage) => {
          assistantMessageId = id;
          applyTurnUsage(usage);
        },
      });

      if (agentMode) {
        finalizeAgentTurn(assistantMessageId);
      } else {
        const finalAssistant: ChatMessage = {
          id: assistantMessageId,
          role: "assistant",
          content: assistantText,
          createdAt: new Date().toISOString(),
        };
        setCurrent((prev) =>
          prev
            ? { ...prev, messages: [...prev.messages, finalAssistant] }
            : prev
        );
        setStreamingText("");
      }
      await refreshSessions();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (agentMode) {
        setActiveAgent((prev) =>
          prev ? { ...prev, pending: false, error: msg } : prev
        );
      }
      setError(msg);
    } finally {
      setStreaming(false);
      if (agentMode) {
        setActiveAgent((prev) =>
          prev ? { ...prev, pending: false } : prev
        );
      }
    }
  }

  function applyTurnUsage(usage: TurnUsage) {
    setLastTurn(usage);
    setTokenLimit(usage.limitTokens);
    setCurrent((prev) =>
      prev
        ? {
            ...prev,
            totalTokensUsed: usage.sessionTotalTokens,
            nextPromptEstimateTokens: usage.nextPromptEstimateTokens,
          }
        : prev
    );
  }

  /**
   * After an agent stream closes, fold the live timeline state into the
   * persistent message list. Tool calls/results land as their own
   * tool_call/tool_result `ChatMessage` rows (matching what the server
   * persisted to the transcript) and the assistant's final text becomes
   * a regular assistant message. The `activeAgent` slot is then cleared.
   */
  function finalizeAgentTurn(assistantMessageId: string) {
    setActiveAgent((prev) => {
      if (!prev) return prev;
      // If the stream ended with an outstanding confirmation request,
      // DO NOT collapse the timeline yet — that would unmount the
      // ActiveAgentBubble and the Confirm / Cancel buttons along with
      // it, leaving the user with no way to answer the agent.
      // `confirmActiveAgentTool` / `cancelActiveAgentTool` clear
      // `pendingConfirmation` before they call us again, so on that
      // second pass we'll fall through to the fold below.
      if (prev.state.pendingConfirmation) {
        return { ...prev, pending: false };
      }
      const now = new Date().toISOString();
      const newMsgs: ChatMessage[] = [];
      for (const step of prev.state.steps) {
        if (step.kind === "tool_call") {
          newMsgs.push({
            id: step.callId,
            role: "tool_call",
            content: `[tool_call:${step.name}]`,
            createdAt: now,
            toolName: step.name,
            args: step.args,
          });
          if (step.result) {
            newMsgs.push({
              id: `${step.callId}:result`,
              role: "tool_result",
              content: `[tool_result:${step.name}]`,
              createdAt: now,
              toolName: step.name,
              result: step.result,
            });
          }
        }
      }
      const finalText =
        prev.state.finalMessage ??
        prev.state.steps
          .filter((s): s is Extract<AgentStep, { kind: "message" }> => s.kind === "message")
          .map((s) => s.text)
          .join("\n\n");
      if (finalText.trim().length > 0) {
        newMsgs.push({
          id: assistantMessageId,
          role: "assistant",
          content: finalText,
          createdAt: now,
        });
      }
      const finalizeKey = buildAgentFinalizeKey(
        prev.userMessageId,
        prev.state.steps,
        finalText
      );
      if (lastAgentFinalizeKeyRef.current === finalizeKey) {
        return null;
      }
      lastAgentFinalizeKeyRef.current = finalizeKey;
      setCurrent((s) =>
        s
          ? isSameMessageBatchAtTail(s.messages, newMsgs)
            ? s
            : { ...s, messages: [...s.messages, ...newMsgs] }
          : s
      );
      return null;
    });
  }

  /**
   * Confirm a pending tool call inside the active agent turn. Streams the
   * resumed orchestrator events into the SAME timeline so the assistant
   * bubble keeps growing instead of starting a new one.
   */
  async function confirmActiveAgentTool() {
    if (!current || !activeAgent?.state.pendingConfirmation) return;
    const token = activeAgent.state.pendingConfirmation.token;
    setStreaming(true);
    setError(null);
    setActiveAgent((prev) =>
      prev
        ? {
            ...prev,
            pending: true,
            state: { ...prev.state, pendingConfirmation: undefined, confirmedNext: true },
          }
        : prev
    );
    try {
      const res = await fetch("/api/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: current.id, token }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Confirm failed: ${res.status} ${txt}`);
      }
      let assistantMessageId = "assistant_pending";
      await streamChatResponse(res, true, {
        onChatDelta: () => {},
        onChatDone: () => {},
        onAgentEvent: (ev) => {
          flushSync(() => {
            setActiveAgent((prev) =>
              prev ? { ...prev, state: applyAgentEvent(prev.state, ev) } : prev
            );
          });
        },
        onAgentDone: (id, usage) => {
          assistantMessageId = id;
          applyTurnUsage(usage);
        },
      });
      finalizeAgentTurn(assistantMessageId);
      await refreshSessions();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActiveAgent((prev) =>
        prev ? { ...prev, pending: false, error: msg } : prev
      );
      setError(msg);
    } finally {
      setStreaming(false);
      setActiveAgent((prev) => (prev ? { ...prev, pending: false } : prev));
    }
  }

  async function cancelActiveAgentTool() {
    if (!current || !activeAgent?.state.pendingConfirmation) return;
    const token = activeAgent.state.pendingConfirmation.token;
    setActiveAgent((prev) =>
      prev
        ? {
            ...prev,
            state: {
              ...prev.state,
              pendingConfirmation: undefined,
              finalMessage: prev.state.finalMessage ?? "(cancelled)",
            },
            pending: false,
          }
        : prev
    );
    try {
      // Best-effort cancel — fire-and-forget so a stale token doesn't
      // surface as an error toast.
      await fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: current.id, token }),
      });
    } catch {
      // see comment above
    }
    finalizeAgentTurn(`assistant_${Date.now()}`);
  }

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
      const chatSummary = json.data.chatSummary as ChatSummary | undefined;
      const turnTokens =
        typeof json.data.turnTokens === "number" ? json.data.turnTokens : undefined;
      const totalTokensUsed =
        typeof json.data.totalTokensUsed === "number"
          ? json.data.totalTokensUsed
          : undefined;
      if (chatSummary) {
        setCurrent((prev) =>
          prev && prev.id === current.id
            ? {
                ...prev,
                chatSummary,
                ...(totalTokensUsed !== undefined ? { totalTokensUsed } : {}),
              }
            : prev
        );
        // Mirror the total into the sidebar entry so the list and the
        // header agree immediately (sidebar otherwise only refreshes on
        // the next /api/chat/sessions poll).
        if (totalTokensUsed !== undefined) {
          setSessions((prev) =>
            prev.map((s) =>
              s.id === current.id ? { ...s, totalTokensUsed } : s
            )
          );
        }
        // Surface the summarize spend in the same "last turn" pill the
        // chat already uses for regular turns, so Summarize isn't an
        // invisible cost.
        if (turnTokens !== undefined) {
          setLastTurn({
            lastTurnTotalTokens: turnTokens,
            sessionTotalTokens: totalTokensUsed ?? turnTokens,
            nextPromptEstimateTokens:
              lastTurn?.nextPromptEstimateTokens ??
              current.nextPromptEstimateTokens ??
              0,
            limitTokens: lastTurn?.limitTokens ?? tokenLimit,
          });
        }
        // Give React one frame to mount the card, then scroll it into
        // view. Without this the summary lands at the top of a long
        // scrollback and the user (who is down by the input) doesn't
        // notice anything changed.
        requestAnimationFrame(() => {
          summaryCardRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      }
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
  const sortedSessions = useMemo(
    () => sortSessions(sessions, sortMode),
    [sessions, sortMode]
  );

  const sessionTokensUsed = current?.totalTokensUsed ?? 0;
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

  const agentEnabled = Boolean(current?.agentEnabled);
  const webSearchEnabled = current?.webSearchEnabled !== false;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(160px,32vh)_minmax(0,1fr)] gap-4 md:grid-cols-[260px,1fr] md:grid-rows-1">
      <div className="min-h-0">
        <ChatSessionList
          sessions={sortedSessions}
          currentId={current?.id ?? null}
          onSelect={selectSession}
          onCreate={() => void createSession()}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
          creating={creating}
          loading={loadingSessions}
        />
      </div>

      <div className="flex h-full min-h-0 flex-col rounded-xl border border-bg-border bg-bg-panel">
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold">
                {current?.title ?? "Discussion"}
              </div>
              {current?.model ? (
                <span
                  className="rounded border border-bg-border bg-bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
                  title={
                    current.tier
                      ? `Current chat model (${current.tier})`
                      : "Current chat model"
                  }
                >
                  {current.model}
                  {current.tier ? ` · ${current.tier}` : ""}
                </span>
              ) : null}
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
              <label
                className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-dim"
                title="When on, the assistant can call Obsidian Vault tools in this chat"
              >
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-sky-500"
                  checked={agentEnabled}
                  disabled={togglingAgent || streaming}
                  onChange={(e) => void toggleAgent(e.target.checked)}
                />
                <span>Obsidian Vault</span>
              </label>
            ) : null}
            {current ? (
              <label
                className="flex cursor-pointer items-center gap-1 text-[11px] text-ink-dim"
                title="When on, the assistant may use external web search"
              >
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-violet-500"
                  checked={webSearchEnabled}
                  disabled={togglingWebSearch || streaming}
                  onChange={(e) => void toggleWebSearch(e.target.checked)}
                />
                <span>Web search</span>
              </label>
            ) : null}
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
          ) : messageList.length === 0 && !streamingText && !activeAgent ? (
            <>
              {current?.chatSummary ? (
                <ChatSummaryCard
                  summary={current.chatSummary}
                  cardRef={summaryCardRef}
                />
              ) : null}
              <div className="text-sm text-ink-dim">
                {agentEnabled
                  ? "Send the first message — this chat is agent-enabled, so the assistant can run vault tools (it will ask before reading or deleting files)."
                  : "Send the first message to begin. Responses are streamed and the transcript is saved into your vault."}
              </div>
            </>
          ) : (
            <>
              {current?.chatSummary ? (
                <ChatSummaryCard
                  summary={current.chatSummary}
                  cardRef={summaryCardRef}
                />
              ) : null}
              {renderMessageList(messageList)}
              {streaming && streamingText ? (
                <MessageBubble role="assistant" content={streamingText} pending />
              ) : null}
              {activeAgent ? (
                <ActiveAgentBubble
                  state={activeAgent.state}
                  pending={activeAgent.pending}
                  pendingConfirmation={activeAgent.state.pendingConfirmation}
                  error={activeAgent.error}
                  onConfirm={() => void confirmActiveAgentTool()}
                  onCancel={() => void cancelActiveAgentTool()}
                  busy={streaming}
                />
              ) : streaming && !streamingText && !agentEnabled ? (
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
                placeholder={
                  agentEnabled
                    ? "Ask anything… the assistant may run vault tools (⌘/Ctrl + Enter to send)"
                    : "Ask anything… (⌘/Ctrl + Enter to send)"
                }
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

function sortSessions(
  sessions: SessionSummary[],
  mode: SessionSortMode
): SessionSummary[] {
  const out = [...sessions];
  out.sort((a, b) => {
    if (mode === "updated_desc") return b.updatedAt.localeCompare(a.updatedAt);
    if (mode === "updated_asc") return a.updatedAt.localeCompare(b.updatedAt);
    if (mode === "created_desc") return b.createdAt.localeCompare(a.createdAt);
    if (mode === "created_asc") return a.createdAt.localeCompare(b.createdAt);
    if (mode === "title_asc") return a.title.localeCompare(b.title);
    return b.title.localeCompare(a.title);
  });
  return out;
}

/**
 * Render the persisted message list. Tool entries (only present in
 * agent-enabled chats once the turn has been folded into history) are
 * coalesced into per-call inline chips so the assistant message bubble
 * carries its tool footprint right next to the surrounding text.
 *
 * The grouping rule is intentionally simple: consecutive tool_call /
 * tool_result messages immediately preceding an assistant message are
 * treated as that message's tool steps. Any orphan tool entry (no
 * trailing assistant) renders inside its own assistant-style wrap.
 */
function renderMessageList(messages: ChatMessage[]): React.ReactNode {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "user") {
      out.push(<MessageBubble key={m.id} role="user" content={m.content} />);
      i += 1;
      continue;
    }
    if (m.role === "assistant" || m.role === "system") {
      out.push(
        <MessageBubble key={m.id} role={m.role} content={m.content} />
      );
      i += 1;
      continue;
    }
    if (m.role === "tool_call" || m.role === "tool_result") {
      // Collect a contiguous run of tool entries, then the trailing
      // assistant message (if any) gets attached as the message text of
      // the same bubble.
      const startIdx = i;
      const toolMsgs: ChatMessage[] = [];
      while (
        i < messages.length &&
        (messages[i]!.role === "tool_call" ||
          messages[i]!.role === "tool_result")
      ) {
        toolMsgs.push(messages[i]!);
        i += 1;
      }
      let trailingAssistant: ChatMessage | undefined;
      if (i < messages.length && messages[i]!.role === "assistant") {
        trailingAssistant = messages[i]!;
        i += 1;
      }
      const steps = toolEntriesToSteps(toolMsgs);
      out.push(
        <PersistedAgentBubble
          key={`agent_${startIdx}`}
          steps={steps}
          finalMessage={trailingAssistant?.content}
        />
      );
      continue;
    }
    i += 1;
  }
  return out;
}

function toolEntriesToSteps(messages: ChatMessage[]): AgentStep[] {
  // Pair tool_call → tool_result by ORDER (a result attaches to the
  // closest preceding, same-toolName, still-unresolved call), not by
  // `m.id`. We can't rely on id equality because:
  //   * `finalizeAgentTurn` in this panel writes the result with id
  //     `${callId}:result`, which intentionally differs from the call id;
  //   * `chatService.sessionFromNote` assigns fresh `newId("msg")` to
  //     every parsed transcript row on reload, so the original callIds
  //     don't survive a round-trip through disk either.
  // Order-based pairing is stable for both cases and also tolerates
  // hand-edits that shuffle ids but preserve the call/result sequence.
  const out: AgentStep[] = [];
  const pending: (AgentStep & { kind: "tool_call" })[] = [];
  for (const m of messages) {
    if (m.role === "tool_call") {
      const step: AgentStep & { kind: "tool_call" } = {
        kind: "tool_call",
        callId: m.id,
        name: m.toolName ?? "?",
        args: m.args,
      };
      pending.push(step);
      out.push(step);
    } else if (m.role === "tool_result") {
      const name = m.toolName ?? "?";
      // Prefer the most recent unresolved call with the same toolName,
      // falling back to the most recent unresolved call of any name.
      let idx = -1;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.name === name) {
          idx = i;
          break;
        }
      }
      if (idx === -1 && pending.length > 0) {
        idx = pending.length - 1;
      }
      if (idx >= 0) {
        const target = pending[idx]!;
        target.result = m.result as ToolResult<unknown>;
        pending.splice(idx, 1);
      } else {
        // Truly orphan result (no preceding call at all) — surface it
        // so the data isn't lost from the timeline.
        out.push({
          kind: "tool_call",
          callId: m.id,
          name,
          args: undefined,
          result: m.result as ToolResult<unknown>,
        });
      }
    }
  }
  return out;
}

/**
 * Sticky summary block pinned to the top of the chat transcript. The
 * summary itself lives in the transcript's frontmatter (written by
 * `chatService.summarize`) so it round-trips cleanly with the chat on
 * disk and stays visible after a page reload. Collapsible so long
 * summaries don't push the live conversation off-screen.
 */
function ChatSummaryCard({
  summary,
  cardRef,
}: {
  summary: ChatSummary;
  cardRef?: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div
      ref={cardRef}
      className="rounded-xl border border-accent/50 bg-bg-panel p-3 ring-1 ring-accent/20"
    >
      <div className="mb-2 text-[10px] uppercase tracking-wider text-ink-dim">
        Saved with this chat — visible after reload
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="pill border-accent/40 text-accent">Chat summary</span>
        {summary.generatedAt ? (
          <span className="text-[11px] text-ink-dim">
            {formatSummaryTimestamp(summary.generatedAt)}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-ink-dim">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="mt-2 space-y-2 text-sm text-ink">
          <Markdown text={summary.text} />
          {summary.actionItems.length > 0 ? (
            <div className="rounded-md border border-bg-border bg-bg/40 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-dim">
                Action items
              </div>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {summary.actionItems.map((item, i) => (
                  <li key={i} className="text-ink">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatSummaryTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function PersistedAgentBubble({
  steps,
  finalMessage,
}: {
  steps: AgentStep[];
  finalMessage?: string;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%] space-y-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated p-3">
        <AgentTurnTimeline
          steps={steps}
          finalMessage={finalMessage}
          pending={false}
          onConfirm={() => {}}
          onCancel={() => {}}
          busy={false}
        />
      </div>
    </div>
  );
}

function ActiveAgentBubble({
  state,
  pending,
  pendingConfirmation,
  error,
  onConfirm,
  onCancel,
  busy,
}: {
  state: AgentTurnState;
  pending: boolean;
  pendingConfirmation?: PendingConfirmation;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%] space-y-2 rounded-2xl rounded-bl-md border border-bg-border bg-bg-elevated p-3">
        <AgentTurnTimeline
          steps={state.steps}
          finalMessage={state.finalMessage}
          pending={pending}
          pendingConfirmation={pendingConfirmation}
          onConfirm={onConfirm}
          onCancel={onCancel}
          busy={busy}
          error={error}
        />
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

function buildAgentFinalizeKey(
  userMessageId: string,
  steps: AgentStep[],
  finalText: string
): string {
  return JSON.stringify({
    userMessageId,
    steps: steps.map((s) =>
      s.kind === "tool_call"
        ? {
            kind: s.kind,
            callId: s.callId,
            name: s.name,
            args: stableJson(s.args),
            result: stableJson(s.result),
          }
        : {
            kind: s.kind,
            text: s.text,
          }
    ),
    finalText,
  });
}

function isSameMessageBatchAtTail(existing: ChatMessage[], batch: ChatMessage[]): boolean {
  if (batch.length === 0) return true;
  if (existing.length < batch.length) return false;
  const start = existing.length - batch.length;
  for (let i = 0; i < batch.length; i++) {
    const a = existing[start + i]!;
    const b = batch[i]!;
    if (a.role !== b.role) return false;
    if ((a.toolName ?? "") !== (b.toolName ?? "")) return false;
    if (a.content !== b.content) return false;
    if (stableJson(a.args) !== stableJson(b.args)) return false;
    if (stableJson(a.result) !== stableJson(b.result)) return false;
  }
  return true;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
