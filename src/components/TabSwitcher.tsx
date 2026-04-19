"use client";

export type TabId = "capture" | "chat";

interface Props {
  current: TabId;
  onChange: (id: TabId) => void;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "capture", label: "Capture" },
  { id: "chat", label: "Chat" },
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
              "rounded-lg px-4 py-1.5 text-sm font-medium transition " +
              (active
                ? "bg-accent text-white shadow-sm"
                : "text-ink-muted hover:text-ink hover:bg-bg-panel")
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
