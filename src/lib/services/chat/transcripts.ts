import type { ChatMessage } from "@/lib/types";

/**
 * Pure markdown rendering + parsing for chat transcripts. No I/O.
 */

export function renderChatMessageMarkdown(m: ChatMessage): string {
  const heading = m.role === "user" ? "## User" : "## Assistant";
  return `\n${heading}  \n_${m.createdAt}_\n\n${m.content}\n`;
}

export function stripMdExt(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}

export interface ParsedTranscriptMessage {
  role: "user" | "assistant";
  /** ISO timestamp parsed from the `_<iso>_` line, or empty if absent. */
  createdAt: string;
  content: string;
}

/**
 * Inverse of {@link renderChatMessageMarkdown}: extract the message sequence
 * back out of a transcript body. Tolerant of hand-edits (extra blank lines,
 * missing timestamp line). Ignores any prose before the first `## User` /
 * `## Assistant` heading, so we don't pick up a leading summary callout.
 */
export function parseTranscriptMarkdown(
  body: string
): ParsedTranscriptMessage[] {
  const headingRe = /^##\s+(User|Assistant)\s*\r?\n/gim;
  const hits: { role: "user" | "assistant"; headingStart: number; contentStart: number }[] =
    [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    hits.push({
      role: m[1]!.toLowerCase() as "user" | "assistant",
      headingStart: m.index,
      contentStart: m.index + m[0].length,
    });
  }

  const out: ParsedTranscriptMessage[] = [];
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    const end = i + 1 < hits.length ? hits[i + 1]!.headingStart : body.length;
    const chunk = body.slice(cur.contentStart, end);
    const lines = chunk.split(/\r?\n/);

    while (lines.length && lines[0]!.trim() === "") lines.shift();
    let createdAt = "";
    const first = (lines[0] ?? "").trim();
    const tsMatch = /^_(.+?)_$/.exec(first);
    if (tsMatch) {
      createdAt = tsMatch[1]!;
      lines.shift();
    }
    while (lines.length && lines[0]!.trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

    const content = lines.join("\n");
    if (content.length === 0) continue;
    out.push({ role: cur.role, createdAt, content });
  }
  return out;
}
