"use client";

export type TabId = "capture" | "chat";

interface Props {
  current: TabId;
  onChange: (id: TabId) => void;
}

const TABS: { id: TabId; label: string; sub: string }[] = [
  { id: "capture", label: "Capture", sub: "operational" },
  { id: "chat", label: "Chat", sub: "discussion" },
];

export function TabSwitcher({ current, onChange }: Props) {
  return (
    <div
      role="tablist"
      className="flex items-center gap-1 rounded-xl border border-bg-border bg-bg-elevated p-1"
    >
      {TABS.map((t) => {
        const active = t.id === current;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={
              "flex flex-col items-start rounded-lg px-3 py-1 text-left transition leading-tight " +
              (active
                ? "bg-accent text-white shadow-sm"
                : "text-ink-muted hover:text-ink hover:bg-bg-panel")
            }
          >
            <span className="text-sm font-medium">{t.label}</span>
            <span
              className={
                "text-[10px] uppercase tracking-wider " +
                (active ? "text-white/70" : "text-ink-dim")
              }
            >
              {t.sub}
            </span>
          </button>
        );
      })}
    </div>
  );
}
