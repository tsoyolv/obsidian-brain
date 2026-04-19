import path from "node:path";
import type { SearchHit } from "@/lib/types";
import { getVaultService, type VaultService } from "@/lib/services/vault";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("searchService");

export interface SearchOptions {
  /** Maximum number of hits to return. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
  /**
   * Restrict the search to a vault-relative folder. The vault's `Deleted/`
   * subtree is always pruned at root and is never reachable through this
   * service even if a caller passes `folder: "Deleted"` — the underlying
   * `vault.listFiles()` call here is rooted at the vault root when no folder
   * is given, so no caller can use this surface to surface trashed content.
   */
  folder?: string;
}

/**
 * Vault-wide keyword search.
 *
 * Scoring covers BOTH filename (title) and full body content, so a query that
 * only matches the filename still surfaces a hit. Each hit carries:
 *
 *   - `path`    — vault-relative path of the matched file
 *   - `title`   — filename without `.md`
 *   - `snippet` — short contextual excerpt around the first match
 *   - `score`   — higher = better; opaque integer, only meaningful for sorting
 *
 * Used by:
 *   - the `search` capture intent (presents hits to the user)
 *   - the `ask_vault_question` capture intent (feeds top hits to the LLM as
 *     bounded, partial context — see captureService)
 *
 * The vault's `Deleted/` folder is excluded by construction: this service
 * iterates files via `vault.listFiles()` which prunes that subtree at the
 * vault root.
 */
export interface SearchService {
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}

const DEFAULT_LIMIT = 25;

/** Score weights — small integers, easy to reason about and tune. */
const TITLE_PHRASE_WEIGHT = 10;
const TITLE_TOKEN_WEIGHT = 5;
const CONTENT_OCCURRENCE_WEIGHT = 1;

/** Snippet window around the first matching token. */
const SNIPPET_BEFORE_CHARS = 60;
const SNIPPET_AFTER_CHARS = 140;
const SNIPPET_FALLBACK_CHARS = 160;

class SearchServiceImpl implements SearchService {
  private readonly vault: VaultService = getVaultService();

  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchHit[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const phrase = tokens.join(" ");
    const limit = options.limit ?? DEFAULT_LIMIT;

    // listFiles() prunes Deleted/ at root, so trashed notes never surface.
    const files = await this.vault.listFiles(options.folder);
    const hits: SearchHit[] = [];

    for (const rel of files) {
      let body: string;
      try {
        const note = await this.vault.readNote(rel);
        body = note.body;
      } catch (err) {
        log.warn("readNote failed during search; skipping", {
          path: rel,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const title = basenameWithoutExt(rel);
      const score = scoreDocument({ title, content: body, tokens, phrase });
      if (score === 0) continue;

      hits.push({
        path: rel,
        title,
        snippet: makeSnippet(body, tokens),
        score,
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

let cached: SearchService | null = null;

export function getSearchService(): SearchService {
  if (cached) return cached;
  cached = new SearchServiceImpl();
  return cached;
}

export function _resetSearchServiceCache(): void {
  cached = null;
}

// ---- helpers (pure, no I/O) ----

/**
 * Split a query into lowercase tokens of length >= 2. The character class
 * intentionally allows latin and cyrillic word characters so that mixed
 * English/Russian queries tokenize the same way.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_\-а-яё]+/i)
    .filter((s) => s.length >= 2);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * Combined filename + content scoring.
 *
 *   - exact phrase appearing in the title gets a chunky bonus
 *   - every individual token found in the title is rewarded
 *   - every occurrence of a token in the body adds 1
 *
 * Net effect: filename hits dominate near-ties, but a body that mentions the
 * query many times can still outrank a weak title-only match.
 */
function scoreDocument(args: {
  title: string;
  content: string;
  tokens: string[];
  phrase: string;
}): number {
  const titleLower = args.title.toLowerCase();
  const contentLower = args.content.toLowerCase();
  let score = 0;

  if (args.phrase && titleLower.includes(args.phrase)) {
    score += TITLE_PHRASE_WEIGHT;
  }

  for (const t of args.tokens) {
    if (titleLower.includes(t)) score += TITLE_TOKEN_WEIGHT;
    score += countOccurrences(contentLower, t) * CONTENT_OCCURRENCE_WEIGHT;
  }

  return score;
}

/**
 * Build a small contextual snippet around the first matching token. Falls
 * back to the document head when no token is present in the body (which
 * happens for filename-only matches).
 */
function makeSnippet(content: string, tokens: string[]): string {
  const lower = content.toLowerCase();
  let bestIdx = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx === -1) {
    return content.slice(0, SNIPPET_FALLBACK_CHARS).replace(/\s+/g, " ").trim();
  }
  const start = Math.max(0, bestIdx - SNIPPET_BEFORE_CHARS);
  const end = Math.min(content.length, bestIdx + SNIPPET_AFTER_CHARS);
  return (
    (start > 0 ? "…" : "") +
    content.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < content.length ? "…" : "")
  );
}

function basenameWithoutExt(relPath: string): string {
  const base = path.basename(relPath);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}
