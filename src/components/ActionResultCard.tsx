"use client";

import type { CaptureActionResult } from "@/lib/types";

interface Props {
  result: CaptureActionResult;
  voiceLogPath?: string;
  transcript?: string;
}

const STATUS_STYLES: Record<CaptureActionResult["status"], string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  ambiguous: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  not_found: "border-bg-border bg-bg-elevated text-ink-muted",
  needs_confirmation: "border-sky-500/30 bg-sky-500/10 text-sky-200",
  error: "border-red-500/30 bg-red-500/10 text-red-300",
};

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

interface FileMatchDetail {
  path: string;
  title: string;
  score?: number;
}

interface TaskMatchDetail {
  text: string;
  path: string;
  line: number;
}

interface SearchHitDetail {
  path: string;
  title: string;
  snippet: string;
}

export function ActionResultCard({ result, voiceLogPath, transcript }: Props) {
  const intentLabel = INTENT_LABEL[result.intent] ?? result.intent;
  const details = (result.details ?? {}) as {
    hits?: SearchHitDetail[];
    matches?: TaskMatchDetail[] | FileMatchDetail[];
    path?: string;
    sources?: { path: string; title: string }[];
    candidate?: FileMatchDetail;
  };
  const detailHits = details.hits;
  const detailMatches = details.matches;
  const detailPath = details.path;
  const detailSources = details.sources;
  const detailCandidate = details.candidate;
  const isFileMatches =
    (result.intent === "find_file" || result.intent === "open_file_for_task") &&
    Array.isArray(detailMatches);

  return (
    <div className="space-y-3">
      {transcript ? (
        <div className="card border-bg-border">
          <div className="flex items-center justify-between text-xs text-ink-dim">
            <span>Transcribed</span>
            {voiceLogPath ? (
              <span className="font-mono text-[11px]">{voiceLogPath}</span>
            ) : null}
          </div>
          <div className="mt-2 whitespace-pre-wrap text-sm">{transcript}</div>
        </div>
      ) : null}

      <div className={`card border ${STATUS_STYLES[result.status]}`}>
        <div className="flex items-center gap-2">
          <span className="pill">{intentLabel}</span>
          <span className="pill capitalize">{result.status.replace("_", " ")}</span>
        </div>
        <div className="mt-2 text-sm text-ink">{result.message}</div>

        {detailPath ? (
          <div className="mt-2 font-mono text-[11px] text-ink-dim">
            {detailPath}
          </div>
        ) : null}

        {detailHits && detailHits.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {detailHits.map((h) => (
              <li key={h.path} className="rounded-md border border-bg-border bg-bg p-2">
                <div className="text-sm font-medium">{h.title}</div>
                <div className="font-mono text-[11px] text-ink-dim">{h.path}</div>
                <div className="mt-1 text-xs text-ink-muted">{h.snippet}</div>
              </li>
            ))}
          </ul>
        ) : null}

        {detailMatches && detailMatches.length > 0 && !isFileMatches ? (
          <ul className="mt-3 space-y-1 text-sm">
            {(detailMatches as TaskMatchDetail[]).map((m, i) => (
              <li key={`${m.path}:${m.line}:${i}`} className="text-ink-muted">
                <span className="text-ink">{m.text}</span>{" "}
                <span className="font-mono text-[11px] text-ink-dim">
                  ({m.path}:{m.line})
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {isFileMatches && (detailMatches as FileMatchDetail[]).length > 0 ? (
          <ul className="mt-3 space-y-2">
            {(detailMatches as FileMatchDetail[]).map((m) => (
              <li
                key={m.path}
                className="rounded-md border border-bg-border bg-bg p-2"
              >
                <div className="text-sm font-medium">{m.title}</div>
                <div className="font-mono text-[11px] text-ink-dim">{m.path}</div>
              </li>
            ))}
          </ul>
        ) : null}

        {detailCandidate ? (
          <div className="mt-3 rounded-md border border-sky-500/30 bg-bg p-2">
            <div className="text-sm font-medium">{detailCandidate.title}</div>
            <div className="font-mono text-[11px] text-ink-dim">
              {detailCandidate.path}
            </div>
            <div className="mt-1 text-[11px] text-ink-dim">
              File contents have NOT been read. Confirm explicitly to open.
            </div>
          </div>
        ) : null}

        {detailSources && detailSources.length > 0 ? (
          <div className="mt-3 text-xs text-ink-dim">
            Sources:{" "}
            {detailSources.map((s, i) => (
              <span key={s.path}>
                <span className="font-mono">{s.path}</span>
                {i < detailSources.length - 1 ? ", " : ""}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
