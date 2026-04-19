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
  // js-yaml (used by gray-matter) throws "unacceptable kind of an object to
  // dump [object Undefined]" on any `undefined` value, so callers that build
  // metadata via `{ tags: cls.data.tags }` would crash whenever the optional
  // field is missing. Strip undefined keys defensively at the boundary.
  const cleaned = data ? stripUndefined(data) : undefined;
  if (!cleaned || Object.keys(cleaned).length === 0) {
    return body.endsWith("\n") ? body : `${body}\n`;
  }
  const out = matter.stringify(body, cleaned as Record<string, unknown>);
  return out.endsWith("\n") ? out : `${out}\n`;
}

function stripUndefined(obj: NoteFrontmatter): NoteFrontmatter {
  const out: NoteFrontmatter = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
