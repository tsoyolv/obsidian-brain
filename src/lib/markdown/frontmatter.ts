import matter from "gray-matter";
import type { NoteFrontmatter } from "@/lib/types";

export interface ParsedNote {
  data: NoteFrontmatter;
  body: string;
}

/** Parses a markdown string with optional YAML frontmatter. */
export function parseMarkdown(raw: string): ParsedNote {
  const parsed = matter(raw);
  return {
    data: (parsed.data ?? {}) as NoteFrontmatter,
    body: parsed.content ?? "",
  };
}

/** Serializes body + frontmatter back into a markdown string. */
export function serializeMarkdown(body: string, data?: NoteFrontmatter): string {
  if (!data || Object.keys(data).length === 0) {
    return body.endsWith("\n") ? body : `${body}\n`;
  }
  const out = matter.stringify(body, data as Record<string, unknown>);
  return out.endsWith("\n") ? out : `${out}\n`;
}
