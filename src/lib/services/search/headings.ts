/**
 * Pure markdown heading parser used by `searchService` to score / surface
 * heading-level matches.
 *
 * No I/O, no logging, no dependencies on anything outside this file. The
 * caller passes in the body string (already without YAML frontmatter, as
 * `vault.readNote` returns it) and gets back an ordered list of headings
 * with their level and 1-based line number.
 *
 * Code fences are skipped so things like `# heading` that appear INSIDE a
 * fenced block don't pollute the heading index. Both backtick (```` ``` ````)
 * and tilde (`~~~`) fences are recognised; the parser tracks the opening
 * fence's marker so a backtick fence isn't accidentally closed by a tilde
 * line (or vice versa).
 *
 * Non-goals (intentionally NOT modelled here):
 *   - Setext-style headings (`===` / `---` underlines). Rare in practice for
 *     Obsidian vaults and they noticeably complicate the parser.
 *   - Indented code blocks (4-space). Treated as regular paragraphs; a
 *     `# foo` indented four spaces is currently parsed as a heading.
 *   - Trailing closing `#`s (e.g. `## foo ##`). Stripped from the captured
 *     `text` so callers get the canonical heading title.
 */

export interface Heading {
  /** Heading text with markup characters stripped (no leading `#`s, no trailing closers). */
  text: string;
  /** Heading level, 1–6, matching the number of leading `#` characters. */
  level: number;
  /** 1-based line number of the heading in the source body. */
  line: number;
}

/**
 * Parse markdown body into an ordered list of headings.
 *
 * Returns an empty array for empty input or a body with no ATX headings.
 * Output order matches source order; duplicates (same text at multiple
 * lines) are preserved — the caller is responsible for any de-duplication.
 */
export function parseHeadings(body: string): Heading[] {
  if (!body) return [];

  const lines = body.split(/\r?\n/);
  const out: Heading[] = [];

  // Track the active fence so a `~~~` line doesn't close a ``` block.
  let fenceMarker: "`" | "~" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmedLeading = raw.replace(/^[ \t]+/, "");

    // Fence handling: a line starting with three or more of the same
    // marker character toggles the active fence. CommonMark allows the
    // closing fence to be longer; we don't track length because in
    // practice it's not a meaningful distinction for our scoring.
    const fenceOpen = /^(`{3,}|~{3,})/.exec(trimmedLeading);
    if (fenceOpen) {
      const marker = fenceOpen[1]!.startsWith("`") ? "`" : "~";
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = null;
      }
      continue;
    }
    if (fenceMarker !== null) continue;

    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(trimmedLeading);
    if (!m) continue;

    const level = m[1]!.length;
    // Strip optional trailing closing `#`s (e.g. `## foo ##`).
    const text = m[2]!.replace(/\s+#+\s*$/, "").trim();
    if (!text) continue;

    out.push({ text, level, line: i + 1 });
  }

  return out;
}
