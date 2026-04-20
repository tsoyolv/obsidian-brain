"use client";

import { useEffect, useState } from "react";
import { ChatPanel } from "./ChatPanel";

interface RuntimeConfig {
  llmProvider: string;
  sttProvider: string;
  chatModel: string;
  sttModel: string;
  vaultConfigured: boolean;
  apiKeyConfigured: boolean;
}

export function AppShell() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [archivingTasks, setArchivingTasks] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/runtime")
      .then(async (r) => {
        const json = await r.json();
        if (cancelled) return;
        if (!json.ok) {
          setConfigError(json.error?.message ?? "Failed to load config");
          return;
        }
        setConfig(json.data);
      })
      .catch((e) => !cancelled && setConfigError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  async function archiveTasksNow() {
    if (archivingTasks) return;
    const confirmed = window.confirm(
      "Archive completed tasks now from Tasks/tasks.md?"
    );
    if (!confirmed) return;
    setArchivingTasks(true);
    setArchiveError(null);
    setArchiveNotice(null);
    try {
      const res = await fetch("/api/tasks/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to archive tasks");
      const archivedCount =
        typeof json.data?.archivedCount === "number" ? json.data.archivedCount : 0;
      setArchiveNotice(
        archivedCount > 0
          ? `Archived ${archivedCount} completed task${archivedCount === 1 ? "" : "s"}.`
          : "No completed tasks to archive."
      );
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchivingTasks(false);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-bg-border bg-bg-elevated/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-accent/20 ring-1 ring-accent/40 grid place-items-center text-accent font-semibold">
              ◎
            </div>
            <div>
              <div className="text-sm font-semibold tracking-wide">
                Obsidian Brain
              </div>
              <div className="text-xs text-ink-dim">
                Local-first AI assistant
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn"
              onClick={() => void archiveTasksNow()}
              disabled={archivingTasks}
              title="Archive completed tasks from Tasks/tasks.md"
            >
              {archivingTasks ? "Archiving…" : "Archive tasks"}
            </button>
            <div className="text-right text-[11px] leading-tight text-ink-dim">
              {configError ? (
                <span className="text-red-400">{configError}</span>
              ) : config ? (
                <>
                  <div>
                    LLM: <span className="text-ink-muted">{config.llmProvider}</span>{" "}
                    / <span className="text-ink-muted">{config.chatModel}</span>
                  </div>
                  <div>
                    STT: <span className="text-ink-muted">{config.sttProvider}</span>{" "}
                    / <span className="text-ink-muted">{config.sttModel}</span>
                  </div>
                  {!config.apiKeyConfigured ? (
                    <div className="text-amber-300">⚠ API key missing</div>
                  ) : null}
                </>
              ) : (
                <span>loading…</span>
              )}
            </div>
          </div>
        </div>
        {archiveError ? (
          <div className="mx-auto mt-2 max-w-6xl px-6 pb-3 text-xs text-red-300">
            {archiveError}
          </div>
        ) : null}
        {archiveNotice ? (
          <div className="mx-auto mt-2 max-w-6xl px-6 pb-3 text-xs text-emerald-300">
            {archiveNotice}
          </div>
        ) : null}
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 min-h-0 overflow-y-auto px-6 py-6">
        <ChatPanel />
      </main>

      <footer className="border-t border-bg-border bg-bg-elevated/40">
        <div className="pointer-events-none mx-auto max-w-6xl px-6 py-2 text-[11px] text-ink-dim">
          Notes are written directly to your Obsidian vault. The LLM never
          touches the filesystem.
        </div>
      </footer>
    </div>
  );
}
