/**
 * Pure token-scoring helpers for vault search. No I/O.
 * Internal to the vault module.
 */

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\-а-яё]+/i)
    .filter((s) => s.length >= 2);
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/** Score a single document against tokenized query terms. */
export function scoreDocument(args: {
  title: string;
  content: string;
  tokens: string[];
}): number {
  const titleLower = args.title.toLowerCase();
  const contentLower = args.content.toLowerCase();
  let score = 0;
  for (const t of args.tokens) {
    if (titleLower.includes(t)) score += 3;
    score += countOccurrences(contentLower, t);
  }
  return score;
}

/** Build a small contextual snippet around the first matching token. */
export function makeSnippet(content: string, tokens: string[]): string {
  const lower = content.toLowerCase();
  let bestIdx = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx === -1) {
    return content.slice(0, 160).replace(/\s+/g, " ").trim();
  }
  const start = Math.max(0, bestIdx - 60);
  const end = Math.min(content.length, bestIdx + 140);
  return (
    (start > 0 ? "…" : "") +
    content.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < content.length ? "…" : "")
  );
}
