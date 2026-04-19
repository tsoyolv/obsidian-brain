"use client";

import type { Role } from "@/lib/types";

interface Props {
  role: Role;
  content: string;
  pending?: boolean;
}

export function MessageBubble({ role, content, pending }: Props) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed " +
          (isUser
            ? "bg-accent text-white"
            : "border border-bg-border bg-bg-panel text-ink")
        }
      >
        {content}
        {pending ? (
          <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-current align-middle" />
        ) : null}
      </div>
    </div>
  );
}
