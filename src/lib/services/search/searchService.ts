import path from "node:path";
import type { SearchHit } from "@/lib/types";
import {
  getVaultService,
  type FileMatch,
  type VaultService,
} from "@/lib/services/vault";
import { createLogger } from "@/lib/utils/logger";
import { parseHeadings, type Heading } from "./headings";

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

/** One heading-level match surfaced by {@link SearchService.searchLayered}. */
export interface HeadingHit {
  /** Vault-relative path of the file the heading lives in. */
  path: string;
  /** Filename without `.md`. */
  title: string;
  /** Heading text (markup stripped). */
  heading: string;
  /** 1-based source line of the heading. */
  line: number;
  /** Short excerpt around the heading line — body content following the heading. */
  snippet: string;
}

/**
 * Result of {@link SearchService.searchLayered}.
 *
 * The four buckets are independent — a single file may appear in multiple
 * (e.g. a strong content hit AND a filename match AND a heading hit). The
 * caller decides how to merge / dedupe; this service stays opinion-free.
 */
export interface LayeredSearchResult {
  /** High-confidence content matches. Score >= {@link STRONG_THRESHOLD}. */
  strong: SearchHit[];
  /** Low-confidence content matches. 0 < score < {@link STRONG_THRESHOLD}. */
  near: SearchHit[];
  /** Filename-only matches, identical shape / scoring to `vault.findFilesByName`. */
  byFilename: FileMatch[];
  /** Headings that contain at least one query token, ordered by parent-doc score. */
  byHeading: HeadingHit[];
}

/**
 * Vault-wide keyword search.
 *
 * The legacy {@link search} method scores BOTH filename (title) and full
 * body content, returning a flat list. It remains the primary entry point
 * for chat / capture flows that just need "the top N notes for this query".
 *
 * {@link searchLayered} is a richer variant used by the agent's
 * `search_vault` tool. It separates strong and near-miss content matches,
 * also surfaces filename-only matches and heading hits, and uses an
 * extended scoring model (path-segment tokens + heading hits) so things
 * like "books in /Lists/Reading/foo.md" score higher even when the title
 * itself is a poor match.
 *
 * Both methods exclude the vault's `Deleted/` folder by construction, via
 * `vault.listFiles()`.
 */
export interface SearchService {
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  searchLayered(
    query: string,
    options?: SearchOptions
  ): Promise<LayeredSearchResult>;
}

const DEFAULT_LIMIT = 25;

/** Score weights — small integers, easy to reason about and tune. */
const TITLE_PHRASE_WEIGHT = 10;
const TITLE_TOKEN_WEIGHT = 5;
const CONTENT_OCCURRENCE_WEIGHT = 1;
/** Per-token bonus when a folder segment in the file's path contains the token. */
const PATH_SEGMENT_TOKEN_WEIGHT = TITLE_TOKEN_WEIGHT * 0.5;
/** Per-matched-heading bonus added to the document score. */
const HEADING_TOKEN_WEIGHT = TITLE_TOKEN_WEIGHT * 0.7;

/**
 * Threshold separating `strong` from `near` in {@link searchLayered}. A
 * single title-token hit (or roughly five body occurrences) is enough to
 * promote a document into `strong`; anything weaker is a near-miss.
 */
const STRONG_THRESHOLD = TITLE_TOKEN_WEIGHT;

/** Snippet window around the first matching token. */
const SNIPPET_BEFORE_CHARS = 60;
const SNIPPET_AFTER_CHARS = 140;
const SNIPPET_FALLBACK_CHARS = 160;

/**
 * Bound on the parsed-headings cache. We expect vaults of at most a few
 * thousand notes; capping the cache keeps memory predictable while still
 * absorbing the common "user types five queries in a row" pattern.
 */
const HEADINGS_CACHE_LIMIT = 500;

class SearchServiceImpl implements SearchService {
  private readonly vault: VaultService = getVaultService();
  /**
   * LRU keyed by `${mtimeMs}:${relPath}`. Insertion order is also access
   * order (Map preserves it); we delete-and-reinsert on hit to refresh
   * LRU position, and evict from the front when over capacity.
   *
   * This is the only stateful piece of the service; everything else is
   * stateless / pure.
   */
  private readonly headingsCache = new Map<string, Heading[]>();

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
      const scored = await this.scoreFile(rel, tokens, phrase);
      if (!scored || scored.score === 0) continue;
      hits.push(scored.hit);
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async searchLayered(
    query: string,
    options: SearchOptions = {}
  ): Promise<LayeredSearchResult> {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return { strong: [], near: [], byFilename: [], byHeading: [] };
    }

    const phrase = tokens.join(" ");
    const limit = options.limit ?? DEFAULT_LIMIT;

    const files = await this.vault.listFiles(options.folder);

    type ScoredDoc = {
      hit: SearchHit;
      headingHits: HeadingHit[];
    };
    const docs: ScoredDoc[] = [];

    for (const rel of files) {
      const scored = await this.scoreFile(rel, tokens, phrase, {
        collectHeadings: true,
      });
      if (!scored || scored.score === 0) continue;
      docs.push({ hit: scored.hit, headingHits: scored.headingHits });
    }

    docs.sort((a, b) => b.hit.score - a.hit.score);

    const strong: SearchHit[] = [];
    const near: SearchHit[] = [];
    const byHeading: HeadingHit[] = [];
    for (const d of docs) {
      if (d.hit.score >= STRONG_THRESHOLD) strong.push(d.hit);
      else near.push(d.hit);
      for (const h of d.headingHits) byHeading.push(h);
    }

    // findFilesByName already excludes Deleted/ when no folder is passed —
    // same invariant as listFiles. Limit it independently from content
    // hits so a query that misses content but hits a filename still
    // surfaces its filename match.
    const byFilename = await this.vault.findFilesByName(query, {
      limit,
      folder: options.folder,
    });

    return {
      strong: strong.slice(0, limit),
      near: near.slice(0, limit),
      byFilename,
      byHeading: byHeading.slice(0, limit),
    };
  }

  /**
   * Read + score a single file. Returns `null` when the file can't be
   * read (permissions, transient I/O error). The caller treats this as
   * "skip silently" rather than failing the whole search.
   *
   * The optional `collectHeadings` flag triggers the
   * {@link searchLayered}-only path of building per-heading hits; for the
   * legacy `search()` method we skip the work entirely.
   */
  private async scoreFile(
    rel: string,
    tokens: string[],
    phrase: string,
    opts: { collectHeadings?: boolean } = {}
  ): Promise<{ hit: SearchHit; score: number; headingHits: HeadingHit[] } | null> {
    let body: string;
    try {
      const note = await this.vault.readNote(rel);
      body = note.body;
    } catch (err) {
      log.warn("readNote failed during search; skipping", {
        path: rel,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const title = basenameWithoutExt(rel);
    const pathSegments = pathSegmentTokens(rel);
    const headings = await this.getHeadings(rel, body);

    const matchedHeadings: Heading[] = [];
    if (headings.length > 0) {
      for (const h of headings) {
        const lower = h.text.toLowerCase();
        if (tokens.some((t) => lower.includes(t))) {
          matchedHeadings.push(h);
        }
      }
    }

    const score = scoreDocument({
      title,
      content: body,
      tokens,
      phrase,
      pathSegments,
      headingMatches: matchedHeadings.length,
    });

    if (score === 0) {
      return { hit: { path: rel, title, snippet: "", score }, score, headingHits: [] };
    }

    const hit: SearchHit = {
      path: rel,
      title,
      snippet: makeSnippet(body, tokens),
      score,
    };

    let headingHits: HeadingHit[] = [];
    if (opts.collectHeadings && matchedHeadings.length > 0) {
      headingHits = matchedHeadings.map((h) => ({
        path: rel,
        title,
        heading: h.text,
        line: h.line,
        snippet: snippetAfterLine(body, h.line),
      }));
    }

    return { hit, score, headingHits };
  }

  /**
   * Fetch (or compute + memoize) the headings list for a file. Cache key
   * is `${mtimeMs}:${relPath}` so any edit invalidates the entry; LRU
   * eviction keeps the cache bounded across long-lived processes.
   *
   * If `statFile` fails (file vanished between listFiles and now), we
   * skip caching and parse on the fly so the search still works.
   */
  private async getHeadings(rel: string, body: string): Promise<Heading[]> {
    let mtimeMs: number | null = null;
    try {
      const stats = await this.vault.statFile(rel);
      mtimeMs = stats.mtimeMs;
    } catch {
      mtimeMs = null;
    }

    if (mtimeMs === null) {
      return parseHeadings(body);
    }

    const key = `${mtimeMs}:${rel}`;
    const cached = this.headingsCache.get(key);
    if (cached) {
      // LRU bump: re-insert to mark as most-recently used.
      this.headingsCache.delete(key);
      this.headingsCache.set(key, cached);
      return cached;
    }

    const parsed = parseHeadings(body);

    // Evict stale entries for the same path (mtime changed) — keeps the
    // cache from growing unbounded for files edited many times.
    for (const k of this.headingsCache.keys()) {
      if (k !== key && k.endsWith(`:${rel}`)) this.headingsCache.delete(k);
    }
    this.headingsCache.set(key, parsed);
    while (this.headingsCache.size > HEADINGS_CACHE_LIMIT) {
      const oldest = this.headingsCache.keys().next().value;
      if (oldest === undefined) break;
      this.headingsCache.delete(oldest);
    }
    return parsed;
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
 * Split a query into lowercase tokens. The character class intentionally
 * allows latin and cyrillic word characters so that mixed English/Russian
 * queries tokenize the same way.
 *
 * Length floor: 2 by default, relaxed to 1 when the WHOLE query is short
 * (<=3 chars). This keeps "go", "ai", "Go", "GPT" usable as queries
 * without flooding longer queries with one-letter noise tokens.
 */
function tokenize(query: string): string[] {
  const trimmed = query.trim();
  const minLen = trimmed.length <= 3 ? 1 : 2;
  return trimmed
    .toLowerCase()
    .split(/[^a-z0-9_\-а-яё]+/i)
    .filter((s) => s.length >= minLen);
}

/**
 * Folder-segment tokens for a vault-relative path. The basename is
 * EXCLUDED — the title is already scored separately, so re-counting it as
 * a path segment would double-credit filename hits.
 */
function pathSegmentTokens(relPath: string): string[] {
  const dir = path.dirname(relPath);
  if (!dir || dir === "." || dir === path.sep) return [];
  const segments = dir.split(/[\\/]/).filter(Boolean);
  const out: string[] = [];
  for (const seg of segments) {
    const sub = seg
      .toLowerCase()
      .split(/[^a-z0-9_\-а-яё]+/i)
      .filter((s) => s.length > 0);
    for (const s of sub) out.push(s);
  }
  return out;
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
 * Combined filename + path + heading + content scoring.
 *
 *   - exact phrase appearing in the title gets a chunky bonus
 *   - every individual token found in the title is rewarded
 *   - every individual token found in a folder segment of the path adds
 *     a half-strength bonus (folder names are real signal — "Books" /
 *     "Reading" / "Tasks" — but weaker than title hits)
 *   - every matched heading adds a 0.7×TITLE_TOKEN bonus
 *   - every occurrence of a token in the body adds 1
 *
 * Net effect: filename hits dominate near-ties, but a body that mentions
 * the query many times (or whose folder/headings carry the topic) can
 * still outrank a weak title-only match.
 */
function scoreDocument(args: {
  title: string;
  content: string;
  tokens: string[];
  phrase: string;
  pathSegments: string[];
  headingMatches: number;
}): number {
  const titleLower = args.title.toLowerCase();
  const contentLower = args.content.toLowerCase();
  let score = 0;

  if (args.phrase && titleLower.includes(args.phrase)) {
    score += TITLE_PHRASE_WEIGHT;
  }

  for (const t of args.tokens) {
    if (titleLower.includes(t)) score += TITLE_TOKEN_WEIGHT;
    if (args.pathSegments.some((s) => s.includes(t))) {
      score += PATH_SEGMENT_TOKEN_WEIGHT;
    }
    score += countOccurrences(contentLower, t) * CONTENT_OCCURRENCE_WEIGHT;
  }

  if (args.headingMatches > 0) {
    score += args.headingMatches * HEADING_TOKEN_WEIGHT;
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

/**
 * Snippet for a heading hit: the heading line plus a few following lines,
 * collapsed to a single line and capped at 200 chars. We don't expand
 * upwards — for headings the interesting context is what's UNDER them.
 */
function snippetAfterLine(content: string, line1Based: number): string {
  const lines = content.split(/\r?\n/);
  const idx = line1Based - 1;
  if (idx < 0 || idx >= lines.length) return "";
  const collected: string[] = [];
  let chars = 0;
  for (let i = idx; i < Math.min(lines.length, idx + 8); i++) {
    const l = (lines[i] ?? "").trim();
    if (!l) continue;
    collected.push(l);
    chars += l.length + 1;
    if (chars >= 200) break;
  }
  return collected.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function basenameWithoutExt(relPath: string): string {
  const base = path.basename(relPath);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}
