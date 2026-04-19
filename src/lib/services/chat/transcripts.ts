import type { ChatMessage } from "@/lib/types";

/**
 * Pure markdown rendering for chat transcripts. No I/O.
 */

export function renderChatMessageMarkdown(m: ChatMessage): string {
  const heading = m.role === "user" ? "### User" : "### Assistant";
  return `\n${heading}  \n_${m.createdAt}_\n\n${m.content}\n`;
}

export function stripMdExt(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}
