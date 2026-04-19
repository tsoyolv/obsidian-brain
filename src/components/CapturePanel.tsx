"use client";

import { useState } from "react";
import { ActionResultCard } from "./ActionResultCard";
import { MicButton } from "./MicButton";
import { TranscriptionCard } from "./TranscriptionCard";
import type { CaptureActionResult, VoiceLogResult } from "@/lib/types";

type Kind = "text" | "voice";

interface BaseEntry {
  id: string;
  kind: Kind;
  pending?: boolean;
  error?: string;
}

interface TextEntry extends BaseEntry {
  kind: "text";
  inputText: string;
  result?: CaptureActionResult;
}

interface VoiceEntry extends BaseEntry {
  kind: "voice";
  voiceLog?: VoiceLogResult;
}

type HistoryEntry = TextEntry | VoiceEntry;

export function CapturePanel() {
  const [text, setText] = useState("");
  const [textBusy, setTextBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  function pushEntry(entry: HistoryEntry) {
    setHistory((prev) => [entry, ...prev].slice(0, 30));
  }

  function updateEntry(id: string, patch: Partial<HistoryEntry>) {
    setHistory((prev) =>
      prev.map((e) => (e.id === id ? ({ ...e, ...patch } as HistoryEntry) : e))
    );
  }

  async function submitText() {
    const value = text.trim();
    if (!value || textBusy) return;
    setTextBusy(true);
    const id = newEntryId();
    pushEntry({ id, kind: "text", inputText: value, pending: true });
    setText("");
    try {
      const res = await fetch("/api/capture/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      const json = await res.json();
      if (!json.ok) {
        updateEntry(id, { pending: false, error: json.error?.message ?? "Failed" });
      } else {
        updateEntry(id, { pending: false, result: json.data });
      }
    } catch (e) {
      updateEntry(id, {
        pending: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTextBusy(false);
    }
  }

  async function submitVoice(blob: Blob, mimeType: string) {
    if (voiceBusy) return;
    setVoiceBusy(true);
    const id = newEntryId();
    pushEntry({ id, kind: "voice", pending: true });
    try {
      const form = new FormData();
      form.append("audio", blob, `recording.${extFromMime(mimeType)}`);
      const res = await fetch("/api/capture/voice", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!json.ok) {
        updateEntry(id, {
          pending: false,
          error: json.error?.message ?? "Transcription failed",
        });
      } else {
        updateEntry(id, {
          pending: false,
          voiceLog: json.data as VoiceLogResult,
        });
      }
    } catch (e) {
      updateEntry(id, {
        pending: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setVoiceBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitText();
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr,360px]">
      <div className="space-y-4">
        <section className="card">
          <label className="mb-2 block text-xs uppercase tracking-wider text-ink-dim">
            Quick capture
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder='Try: "save a note about the meeting", "create task buy milk", "complete task buy milk", "search project alpha"'
            rows={4}
            className="textarea resize-y"
            disabled={textBusy}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <MicButton onRecorded={submitVoice} disabled={voiceBusy} />
              {voiceBusy ? (
                <span className="text-xs text-ink-dim">Transcribing…</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-dim">
              <span>⌘/Ctrl + Enter to send</span>
              <button
                type="button"
                className="btn-primary"
                onClick={submitText}
                disabled={textBusy || text.trim().length === 0}
              >
                Send
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          {history.length === 0 ? (
            <div className="card text-sm text-ink-dim">
              Nothing captured yet. Type a request or record your voice above.
            </div>
          ) : (
            history.map((entry) => (
              <article key={entry.id} className="space-y-2">
                {entry.kind === "text" && entry.inputText ? (
                  <div className="rounded-lg border border-bg-border bg-bg-elevated px-3 py-2 text-sm text-ink-muted">
                    <span className="mr-2 text-[11px] uppercase tracking-wider text-ink-dim">
                      You
                    </span>
                    {entry.inputText}
                  </div>
                ) : null}

                {entry.pending ? (
                  <div className="card text-sm text-ink-dim">
                    {entry.kind === "voice" ? "Transcribing…" : "Working…"}
                  </div>
                ) : entry.error ? (
                  <div className="card border-red-500/30 bg-red-500/10 text-sm text-red-300">
                    {entry.error}
                  </div>
                ) : entry.kind === "text" && entry.result ? (
                  <ActionResultCard result={entry.result} />
                ) : entry.kind === "voice" && entry.voiceLog ? (
                  <TranscriptionCard
                    path={entry.voiceLog.path}
                    transcript={entry.voiceLog.transcript}
                    provider={entry.voiceLog.provider}
                    model={entry.voiceLog.model}
                  />
                ) : null}
              </article>
            ))
          )}
        </section>
      </div>

      <aside className="space-y-4">
        <div className="card">
          <h3 className="text-sm font-semibold">How voice works</h3>
          <p className="mt-2 text-xs text-ink-muted">
            Recording uses your browser's <code className="text-ink-dim">MediaRecorder</code> API.
            On stop, the audio is uploaded to the configured STT provider and the
            transcript is saved as a raw markdown file under{" "}
            <code className="text-ink-dim">Voice Logs/</code>.
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
              <strong className="text-ink">create_task</strong> — append to today's
              task file in <code className="text-ink-dim">Tasks/</code>
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
          </ul>
        </div>
      </aside>
    </div>
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
