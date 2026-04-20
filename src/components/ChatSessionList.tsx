"use client";

import { useEffect, useState } from "react";
import { SkeletonLines, Spinner } from "./Spinner";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  agentEnabled?: boolean;
  webSearchEnabled?: boolean;
  totalTokensUsed?: number;
  nextPromptEstimateTokens?: number;
  model?: string;
  tier?: "fast" | "standard" | "reasoning";
}

export interface DeletedSessionSummary {
  id: string;
  title: string;
  deletedPath: string;
  updatedAt: string;
}

export interface ArchivedSessionSummary {
  id: string;
  title: string;
  archivedPath: string;
  updatedAt: string;
}

export type SessionSortMode =
  | "updated_desc"
  | "updated_asc"
  | "created_desc"
  | "created_asc"
  | "title_asc"
  | "title_desc";

interface Props {
  sessions: SessionSummary[];
  archivedSessions?: ArchivedSessionSummary[];
  deletedSessions?: DeletedSessionSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onSelectArchived?: (id: string) => void;
  onDelete: (id: string) => void;
  deletingId?: string | null;
  onRestore?: (deletedPath: string) => void;
  restoringPath?: string | null;
  onCreate: () => void;
  sortMode: SessionSortMode;
  onSortModeChange: (mode: SessionSortMode) => void;
  creating?: boolean;
  loading?: boolean;
}

export function ChatSessionList({
  sessions,
  archivedSessions,
  deletedSessions,
  currentId,
  onSelect,
  onSelectArchived,
  onDelete,
  deletingId,
  onRestore,
  restoringPath,
  onCreate,
  sortMode,
  onSortModeChange,
  creating,
  loading,
}: Props) {
  const DELETED_PAGE_SIZE = 10;
  const [visibleDeletedCount, setVisibleDeletedCount] = useState(DELETED_PAGE_SIZE);

  useEffect(() => {
    setVisibleDeletedCount(DELETED_PAGE_SIZE);
  }, [deletedSessions]);

  const visibleDeletedSessions = (deletedSessions ?? []).slice(0, visibleDeletedCount);
  const hasMoreDeleted = (deletedSessions?.length ?? 0) > visibleDeletedCount;

  return (
    <div className="flex h-full flex-col gap-2">
      <button
        type="button"
        onClick={onCreate}
        disabled={creating}
        className="btn-primary w-full"
      >
        {creating ? (
          <>
            <Spinner />
            Creating…
          </>
        ) : (
          "+ New chat"
        )}
      </button>
      <label className="flex items-center gap-2 px-1 text-xs text-ink-dim">
        <span>Sort</span>
        <select
          value={sortMode}
          onChange={(e) => onSortModeChange(e.target.value as SessionSortMode)}
          className="min-w-0 flex-1 rounded-md border border-bg-border bg-bg-panel px-2 py-1 text-xs text-ink"
        >
          <option value="updated_desc">Updated: newest first</option>
          <option value="updated_asc">Updated: oldest first</option>
          <option value="created_desc">Created: newest first</option>
          <option value="created_asc">Created: oldest first</option>
          <option value="title_asc">Title: A-Z</option>
          <option value="title_desc">Title: Z-A</option>
        </select>
      </label>
      <div className="flex-1 overflow-y-auto rounded-xl border border-bg-border bg-bg-panel">
        {loading && sessions.length === 0 ? (
          <div className="space-y-3 p-3">
            <SkeletonLines lines={3} />
            <SkeletonLines lines={3} />
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-3 text-xs text-ink-dim">
            No sessions yet. Click <span className="text-ink">+ New chat</span>{" "}
            to start one.
          </div>
        ) : (
          <ul className="divide-y divide-bg-border">
            {sessions.map((s) => {
              const active = s.id === currentId;
              const deleting = deletingId === s.id;
              return (
                <li key={s.id}>
                  <div
                    className={
                      "flex items-start gap-2 px-2 py-1.5 " +
                      (active ? "bg-accent/10" : "hover:bg-bg-elevated")
                    }
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(s.id)}
                      className="min-w-0 flex-1 rounded px-1 py-0.5 text-left text-sm text-ink-muted"
                    >
                      <span className="line-clamp-1 font-medium text-ink">
                        {s.title}
                      </span>
                      <span className="text-[11px] text-ink-dim">
                        {s.messageCount} msg ·{" "}
                        {new Date(s.updatedAt).toLocaleString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      disabled={deleting}
                      className="mt-0.5 rounded border border-bg-border bg-bg px-2 py-1 text-[10px] text-ink-dim hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-60"
                      title="Move chat to Deleted/"
                    >
                      {deleting ? "…" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {archivedSessions && archivedSessions.length > 0 ? (
        <div className="rounded-xl border border-bg-border bg-bg-panel">
          <div className="border-b border-bg-border px-3 py-2 text-[11px] uppercase tracking-wider text-ink-dim">
            Archived chats (read-only)
          </div>
          <ul className="divide-y divide-bg-border">
            {archivedSessions.slice(0, 10).map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelectArchived?.(s.id)}
                  className={
                    "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm " +
                    (s.id === currentId
                      ? "bg-accent/10 text-ink"
                      : "text-ink-muted hover:bg-bg-elevated")
                  }
                >
                  <span className="line-clamp-1 font-medium text-ink">{s.title}</span>
                  <span className="text-[11px] text-ink-dim">
                    archived · {new Date(s.updatedAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {deletedSessions && deletedSessions.length > 0 ? (
        <div className="rounded-xl border border-bg-border bg-bg-panel">
          <div className="border-b border-bg-border px-3 py-2 text-[11px] uppercase tracking-wider text-ink-dim">
            Deleted chats (latest first)
          </div>
          <ul className="max-h-72 overflow-y-auto divide-y divide-bg-border">
            {visibleDeletedSessions.map((s) => {
              const restoring = restoringPath === s.deletedPath;
              return (
                <li key={s.deletedPath} className="flex items-start gap-2 px-2 py-1.5">
                  <div className="min-w-0 flex-1 px-1 py-0.5">
                    <div className="line-clamp-1 text-sm text-ink">{s.title}</div>
                    <div className="text-[11px] text-ink-dim">
                      {new Date(s.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRestore?.(s.deletedPath)}
                    disabled={restoring}
                    className="mt-0.5 rounded border border-bg-border bg-bg px-2 py-1 text-[10px] text-ink-dim hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-60"
                    title="Restore chat from Deleted/"
                  >
                    {restoring ? "…" : "Restore"}
                  </button>
                </li>
              );
            })}
          </ul>
          {hasMoreDeleted ? (
            <div className="border-t border-bg-border px-2 py-2">
              <button
                type="button"
                onClick={() =>
                  setVisibleDeletedCount((prev) => prev + DELETED_PAGE_SIZE)
                }
                className="w-full rounded border border-bg-border bg-bg px-2 py-1.5 text-xs text-ink-dim hover:bg-bg-elevated"
              >
                Show more deleted chats
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
