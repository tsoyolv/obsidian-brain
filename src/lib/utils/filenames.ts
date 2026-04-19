/**
 * Filename / title sanitization for safe writes into the vault.
 *
 * Rules:
 *  - strip path separators (no traversal via title)
 *  - strip control chars
 *  - replace characters illegal on Windows/macOS for portability
 *  - collapse whitespace
 *  - cap length to a reasonable size
 */

const ILLEGAL = /[<>:"/\\|?*\x00-\x1F]/g;
const MAX_LEN = 120;

export function sanitizeFilename(input: string): string {
  const cleaned = input
    .normalize("NFC")
    .replace(/\r?\n+/g, " ")
    .replace(ILLEGAL, "")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = cleaned.slice(0, MAX_LEN).trim();
  if (truncated.length === 0) return "untitled";
  // Avoid trailing dots/spaces (problematic on Windows).
  return truncated.replace(/[.\s]+$/g, "");
}

/** Ensures filename ends with `.md`, applying sanitization to the base. */
export function ensureMarkdownExt(name: string): string {
  const base = name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
  return `${sanitizeFilename(base)}.md`;
}
