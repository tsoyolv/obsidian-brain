"use client";

import type { ReactNode } from "react";
import { Markdown } from "./Markdown";
import type { ToolResult } from "@/lib/agent/types";
import type {
  FileCandidate,
  FileCandidateResult,
  FileReadResult,
  FileTaskExecution,
  SearchHit,
} from "@/lib/types";

/**
 * Renders ONE tool result. Dispatches via a small registry keyed by tool
 * name; tools without a registered renderer fall back to {@link DefaultRenderer},
 * which prints the result's `message` field (if any) or a stringified
 * preview.
 *
 * Keeping the registry keyed by string tool name (rather than a discriminated
 * union) means new tools can ship without touching this component — only
 * "want a custom renderer" tools need to register one here.
 */
export function ActionResultCard({
  toolName,
  result,
  /**
   * Set by the orchestrator-side flow once a confirmation token has been
   * exchanged. The renderer registry uses this to gate verbatim file-body
   * rendering for `read_confirmed_file` / `run_file_task` results.
   */
  confirmed,
}: {
  toolName: string;
  result: ToolResult<unknown>;
  confirmed?: boolean;
}) {
  const ok = result.ok === true;
  const error = !result.ok && "error" in result ? result.error : undefined;

  return (
    <div
      className={`card border ${
        ok
          ? "border-emerald-500/30 bg-emerald-500/10"
          : "border-red-500/30 bg-red-500/10"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="pill">{toolName}</span>
        <span className="pill capitalize">{ok ? "ok" : "error"}</span>
      </div>

      <div className="mt-2">
        {ok ? (
          renderOk(toolName, (result as { ok: true; data: unknown }).data, {
            confirmed: Boolean(confirmed),
          })
        ) : (
          <div className="text-sm text-red-200">{error ?? "Tool failed."}</div>
        )}
      </div>
    </div>
  );
}

// ---- Renderer registry ----

interface RendererCtx {
  confirmed: boolean;
}

type Renderer = (data: unknown, ctx: RendererCtx) => ReactNode;

const RENDERERS: Record<string, Renderer> = {
  search_vault: renderSearchVault,
  find_file: renderFindFile,
  save_note: renderSaveNote,
  create_task: renderCreateTask,
  complete_task: renderCompleteTask,
  propose_open_file: renderProposeOpenFile,
  answer_from_vault: renderAnswerFromVault,
  read_confirmed_file: renderReadConfirmedFile,
  run_file_task: renderRunFileTask,
  soft_delete: renderSoftDelete,
};

function renderOk(toolName: string, data: unknown, ctx: RendererCtx): ReactNode {
  const renderer = RENDERERS[toolName] ?? defaultRenderer;
  return renderer(data, ctx);
}

function defaultRenderer(data: unknown): ReactNode {
  // Most tools either return `{ message: string, ... }` or a small JSON
  // shape. The default renderer just surfaces `message`; everything else
  // falls back to a fenced JSON dump so unfamiliar tools are at least
  // legible while waiting for a custom renderer.
  if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof (data as { message: unknown }).message === "string"
  ) {
    return (
      <div className="text-sm text-ink">
        {(data as { message: string }).message}
      </div>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-md bg-bg p-2 text-[11px] text-ink-muted">
      {safeJson(data)}
    </pre>
  );
}

// ---- Per-tool renderers ----

function renderSearchVault(data: unknown): ReactNode {
  const d = data as { query?: string; hits?: SearchHit[] };
  const hits = d.hits ?? [];
  if (hits.length === 0) {
    return (
      <div className="text-sm text-ink-muted">
        No matches for &ldquo;{d.query}&rdquo;.
      </div>
    );
  }
  return (
    <>
      <div className="text-sm text-ink">
        Found {hits.length} match{hits.length === 1 ? "" : "es"} for{" "}
        <span className="font-mono text-ink-muted">{d.query}</span>.
      </div>
      <ul className="mt-2 space-y-2">
        {hits.map((h) => (
          <li
            key={h.path}
            className="rounded-md border border-bg-border bg-bg p-2"
          >
            <div className="text-sm font-medium">{h.title}</div>
            <div className="font-mono text-[11px] text-ink-dim">{h.path}</div>
            <div className="mt-1 text-xs text-ink-muted">{h.snippet}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

interface FileMatchLite {
  path: string;
  title: string;
  score?: number;
}

function renderFindFile(data: unknown): ReactNode {
  const d = data as { query?: string; matches?: FileMatchLite[] };
  const matches = d.matches ?? [];
  if (matches.length === 0) {
    return (
      <div className="text-sm text-ink-muted">
        No files match &ldquo;{d.query}&rdquo;.
      </div>
    );
  }
  return (
    <>
      <div className="text-sm text-ink">
        Found {matches.length} file{matches.length === 1 ? "" : "s"} matching{" "}
        <span className="font-mono text-ink-muted">{d.query}</span>. File
        contents were NOT read.
      </div>
      <ul className="mt-2 space-y-1">
        {matches.map((m) => (
          <li
            key={m.path}
            className="rounded-md border border-bg-border bg-bg p-2"
          >
            <div className="text-sm font-medium">{m.title}</div>
            <div className="font-mono text-[11px] text-ink-dim">{m.path}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

function renderSaveNote(data: unknown): ReactNode {
  const d = data as { path?: string; title?: string };
  return (
    <div className="text-sm">
      Saved note <span className="font-medium">&ldquo;{d.title}&rdquo;</span>.
      <div className="mt-1 font-mono text-[11px] text-ink-dim">{d.path}</div>
    </div>
  );
}

function renderCreateTask(data: unknown): ReactNode {
  const d = data as { path?: string; text?: string };
  return (
    <div className="text-sm">
      Created task: <span className="font-medium">&ldquo;{d.text}&rdquo;</span>.
      <div className="mt-1 font-mono text-[11px] text-ink-dim">{d.path}</div>
    </div>
  );
}

interface TaskMatchLite {
  text: string;
  path: string;
  line: number;
}

function renderCompleteTask(data: unknown): ReactNode {
  const d = data as
    | {
        status: "ok";
        path: string;
        line: number;
        text: string;
      }
    | {
        status: "ambiguous";
        matches: TaskMatchLite[];
      }
    | { status: "not_found" };
  if (d.status === "ok") {
    return (
      <div className="text-sm">
        Completed task:{" "}
        <span className="font-medium">&ldquo;{d.text}&rdquo;</span>.
        <div className="mt-1 font-mono text-[11px] text-ink-dim">
          {d.path}:{d.line}
        </div>
      </div>
    );
  }
  if (d.status === "ambiguous") {
    return (
      <>
        <div className="text-sm text-ink">
          Multiple open tasks match — please be more specific.
        </div>
        <ul className="mt-2 space-y-1 text-sm">
          {d.matches.map((m, i) => (
            <li key={`${m.path}:${m.line}:${i}`} className="text-ink-muted">
              <span className="text-ink">{m.text}</span>{" "}
              <span className="font-mono text-[11px] text-ink-dim">
                ({m.path}:{m.line})
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return <div className="text-sm text-ink-muted">No matching open task.</div>;
}

function renderProposeOpenFile(data: unknown): ReactNode {
  const d = data as FileCandidateResult;
  if (d.autoRead) {
    return (
      <div className="text-sm text-ink">
        Прочитан файл{" "}
        <span className="font-medium">&ldquo;{d.autoRead.title}&rdquo;</span>.
        <div className="mt-1 font-mono text-[11px] text-ink-dim">
          {d.autoRead.path}
        </div>
      </div>
    );
  }
  if (!d.candidates || d.candidates.length === 0) {
    return (
      <div className="text-sm text-ink-muted">
        No candidates for &ldquo;{d.query}&rdquo;.
      </div>
    );
  }
  return (
    <>
      <div className="text-sm text-ink">
        {d.candidates.length} candidate
        {d.candidates.length === 1 ? "" : "s"} for{" "}
        <span className="font-mono text-ink-muted">{d.query}</span>. File
        contents were NOT read.
      </div>
      {d.previews && d.previews.length > 0 ? (
        <div className="mt-1 text-[11px] text-ink-dim">
          Автопредпросмотр: {d.previews.length} файл(ов), суммарно{" "}
          {d.previewTotalChars ?? d.previews.reduce((a, p) => a + p.charsRead, 0)} симв.
        </div>
      ) : null}
      <ul className="mt-2 space-y-1">
        {d.candidates.map((c: FileCandidate) => (
          <li
            key={c.path}
            className={`rounded-md border p-2 ${
              c.isBestGuess
                ? "border-sky-500/30 bg-sky-500/5"
                : "border-bg-border bg-bg"
            }`}
          >
            <div className="text-sm font-medium">
              {c.title}
              {c.isBestGuess ? (
                <span className="ml-2 rounded-full border border-sky-500/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-sky-300">
                  best guess
                </span>
              ) : null}
            </div>
            <div className="font-mono text-[11px] text-ink-dim">{c.path}</div>
          </li>
        ))}
      </ul>
      {d.reason ? (
        <div className="mt-2 text-[11px] text-ink-dim">{d.reason}</div>
      ) : null}
    </>
  );
}

function renderAnswerFromVault(data: unknown): ReactNode {
  const d = data as {
    answer?: string;
    sources?: { path: string; title: string }[];
  };
  return (
    <>
      <div className="text-sm text-ink">
        {d.answer ? <Markdown text={d.answer} /> : null}
      </div>
      {d.sources && d.sources.length > 0 ? (
        <div className="mt-2 text-[11px] text-ink-dim">
          Sources:{" "}
          {d.sources.map((s, i) => (
            <span key={s.path}>
              <span className="font-mono">{s.path}</span>
              {i < d.sources!.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function renderReadConfirmedFile(data: unknown, ctx: RendererCtx): ReactNode {
  const d = data as FileReadResult;
  return (
    <>
      <div className="text-sm">
        Прочитан файл{" "}
        <span className="font-medium">&ldquo;{d.title}&rdquo;</span>
        {d.task ? <> для задачи: {d.task}</> : null}.
        <div className="mt-1 font-mono text-[11px] text-ink-dim">{d.path}</div>
      </div>
      {ctx.confirmed && d.content ? (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-bg-border bg-bg p-3 text-sm text-ink">
          <Markdown text={d.content} />
        </div>
      ) : null}
    </>
  );
}

function renderRunFileTask(data: unknown, ctx: RendererCtx): ReactNode {
  const d = data as FileTaskExecution;
  return (
    <>
      <div className="text-sm">
        Ran <span className="font-medium">{d.kind}</span> on{" "}
        <span className="font-medium">&ldquo;{d.title}&rdquo;</span>.
        <div className="mt-1 font-mono text-[11px] text-ink-dim">{d.path}</div>
        {d.truncated ? (
          <div className="mt-1 text-[11px] text-amber-300">
            Note body was truncated to fit the context cap.
          </div>
        ) : null}
      </div>
      {ctx.confirmed && d.markdown ? (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-bg-border bg-bg p-3 text-sm text-ink">
          <Markdown text={d.markdown} />
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-ink-dim">
          Output hidden — confirmation required to display.
        </div>
      )}
    </>
  );
}

function renderSoftDelete(data: unknown): ReactNode {
  const d = data as { path?: string };
  return (
    <div className="text-sm">
      Soft-deleted to:
      <div className="mt-1 font-mono text-[11px] text-ink-dim">{d.path}</div>
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
