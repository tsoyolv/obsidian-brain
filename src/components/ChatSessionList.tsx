"use client";

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
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  sortMode: SessionSortMode;
  onSortModeChange: (mode: SessionSortMode) => void;
  creating?: boolean;
  loading?: boolean;
}

export function ChatSessionList({
  sessions,
  currentId,
  onSelect,
  onCreate,
  sortMode,
  onSortModeChange,
  creating,
  loading,
}: Props) {
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
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    className={
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm " +
                      (active
                        ? "bg-accent/10 text-ink"
                        : "text-ink-muted hover:bg-bg-elevated")
                    }
                  >
                    <span className="line-clamp-1 font-medium text-ink">
                      {s.title}
                    </span>
                    <span className="text-[11px] text-ink-dim">
                      {s.messageCount} msg ·{" "}
                      {new Date(s.updatedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
