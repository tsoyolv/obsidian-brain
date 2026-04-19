"use client";

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating?: boolean;
}

export function ChatSessionList({
  sessions,
  currentId,
  onSelect,
  onCreate,
  creating,
}: Props) {
  return (
    <div className="flex h-full flex-col gap-2">
      <button
        type="button"
        onClick={onCreate}
        disabled={creating}
        className="btn-primary w-full"
      >
        {creating ? "Creating…" : "+ New chat"}
      </button>
      <div className="flex-1 overflow-y-auto rounded-xl border border-bg-border bg-bg-panel">
        {sessions.length === 0 ? (
          <div className="p-3 text-xs text-ink-dim">No sessions yet.</div>
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
