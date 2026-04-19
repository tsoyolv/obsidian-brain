"use client";

import { useEffect, useState } from "react";
import { CapturePanel } from "./CapturePanel";
import { ChatPanel } from "./ChatPanel";
import { TabSwitcher, type TabId } from "./TabSwitcher";

interface RuntimeConfig {
  llmProvider: string;
  sttProvider: string;
  chatModel: string;
  sttModel: string;
  vaultConfigured: boolean;
  apiKeyConfigured: boolean;
}

export function AppShell() {
  const [tab, setTab] = useState<TabId>("capture");
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

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

  return (
    <div className="flex min-h-screen flex-col">
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
          <TabSwitcher current={tab} onChange={setTab} />
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
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        {tab === "capture" ? <CapturePanel /> : <ChatPanel />}
      </main>

      <footer className="border-t border-bg-border bg-bg-elevated/40">
        <div className="mx-auto max-w-6xl px-6 py-2 text-[11px] text-ink-dim">
          Notes are written directly to your Obsidian vault. The LLM never
          touches the filesystem.
        </div>
      </footer>
    </div>
  );
}
