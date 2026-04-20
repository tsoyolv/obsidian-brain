import type { ChatMessage, ChatMessageRole } from "@/lib/types";

/**
 * Pure markdown rendering + parsing for chat transcripts. No I/O.
 *
 * In addition to the standard `## User` / `## Assistant` headings, agent-
 * driven turns may emit `## Tool Call` and `## Tool Result` entries. Both
 * are persisted as collapsed `<details>` blocks so Obsidian renders the
 * transcript cleanly while still keeping the structured payload available
 * for round-trip parsing.
 */

const HEADING_BY_ROLE: Record<ChatMessageRole, string> = {
  system: "## System",
  user: "## User",
  assistant: "## Assistant",
  tool_call: "## Tool Call",
  tool_result: "## Tool Result",
};

const ROLE_BY_HEADING: Record<string, ChatMessageRole> = {
  system: "system",
  user: "user",
  assistant: "assistant",
  "tool call": "tool_call",
  "tool result": "tool_result",
};

export function renderChatMessageMarkdown(m: ChatMessage): string {
  const heading = HEADING_BY_ROLE[m.role] ?? `## ${m.role}`;
  if (m.role === "tool_call" || m.role === "tool_result") {
    const name = m.toolName ?? "?";
    const payload =
      m.role === "tool_call"
        ? {
            args: m.args ?? null,
            plannerModel: m.plannerModel ?? null,
            finalModel: m.finalModel ?? null,
          }
        : { result: m.result ?? null };
    const json = safeJson(payload);
    const body = [
      `<details><summary>tool: ${name}</summary>`,
      "",
      "```json",
      json,
      "```",
      "",
      "</details>",
    ].join("\n");
    return `\n${heading}  \n_${m.createdAt}_\n\n${body}\n`;
  }
  return `\n${heading}  \n_${m.createdAt}_\n\n${m.content}\n`;
}

export function stripMdExt(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}

export interface ParsedTranscriptMessage {
  role: ChatMessageRole;
  /** ISO timestamp parsed from the `_<iso>_` line, or empty if absent. */
  createdAt: string;
  /** Display text for plain messages; rendered tool-block body otherwise. */
  content: string;
  /** Set on tool entries; extracted from the `<summary>` line. */
  toolName?: string;
  args?: unknown;
  plannerModel?: string;
  finalModel?: string;
  result?: unknown;
}

/**
 * Inverse of {@link renderChatMessageMarkdown}: extract the message sequence
 * back out of a transcript body. Tolerant of hand-edits (extra blank lines,
 * missing timestamp line, malformed tool JSON). Ignores any prose before
 * the first `## ...` heading, so we don't pick up a leading summary callout.
 */
export function parseTranscriptMarkdown(
  body: string
): ParsedTranscriptMessage[] {
  const headingRe = /^##\s+(User|Assistant|System|Tool Call|Tool Result)\s*\r?\n/gim;
  const hits: { role: ChatMessageRole; headingStart: number; contentStart: number }[] =
    [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    const role = ROLE_BY_HEADING[m[1]!.toLowerCase()];
    if (!role) continue;
    hits.push({
      role,
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

    if (cur.role === "tool_call" || cur.role === "tool_result") {
      const toolName = extractToolName(content);
      const json = extractJsonBlock(content);
      const parsedJson = json ? safeParse(json) : undefined;
      const entry: ParsedTranscriptMessage = {
        role: cur.role,
        createdAt,
        content,
        toolName,
      };
      if (cur.role === "tool_call") {
        if (parsedJson && typeof parsedJson === "object" && parsedJson !== null) {
          const obj = parsedJson as Record<string, unknown>;
          entry.args = obj.args;
          entry.plannerModel =
            typeof obj.plannerModel === "string" ? obj.plannerModel : undefined;
          entry.finalModel =
            typeof obj.finalModel === "string" ? obj.finalModel : undefined;
        }
      } else {
        entry.result =
          parsedJson && typeof parsedJson === "object" && parsedJson !== null
            ? (parsedJson as Record<string, unknown>).result
            : undefined;
      }
      out.push(entry);
    } else {
      out.push({ role: cur.role, createdAt, content });
    }
  }
  return out;
}

function extractToolName(content: string): string | undefined {
  const m = /<summary>tool:\s*([^<\n]+?)<\/summary>/i.exec(content);
  return m ? m[1]!.trim() : undefined;
}

function extractJsonBlock(content: string): string | undefined {
  const m = /```json\s*\r?\n([\s\S]*?)\r?\n```/i.exec(content);
  return m ? m[1]! : undefined;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
