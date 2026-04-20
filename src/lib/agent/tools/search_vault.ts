import { z } from "zod";
import { llmProviderFactory, type FileRankCandidate } from "@/lib/providers/llm";
import { getSearchService } from "@/lib/services/search";
import type { SearchHit } from "@/lib/types";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Free-text keyword query. Searches both filenames and bodies."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Maximum number of strong/near hits per bucket (default 10)."),
});

/**
 * One hit returned to the agent. Mirrors {@link SearchHit} plus an optional
 * `isBestGuess` flag the rerank step sets on its single top pick.
 */
export interface AgentSearchHit extends SearchHit {
  /** Set on the rerank-pick when {@link rerankIfNeeded} runs. */
  isBestGuess?: boolean;
}

export interface SearchVaultOutput {
  query: string;
  /** High-confidence content matches. */
  strong: AgentSearchHit[];
  /** Near-miss content matches. Surfaced so the model can suggest spelling fixes / topic pivots. */
  near: AgentSearchHit[];
  /**
   * Reformulated queries the tool tried in order, after the original
   * came back empty-strong-but-non-empty-near. Empty when no
   * reformulation was attempted.
   */
  reformulationsTried: string[];
}

/**
 * Soft cap on the LLM-driven rerank step. The rerank is a "nice to have"
 * — if the model is slow or unavailable we keep the original ordering
 * rather than blocking the agent's turn.
 */
const RERANK_TIMEOUT_MS = 3000;

/** Rerank only triggers when there's a real ambiguity to resolve. */
const RERANK_TRIGGER_STRONG_COUNT = 5;
/** Number of strong hits the rerank actually inspects. */
const RERANK_CANDIDATE_LIMIT = 10;
/** How many near-titles we hand to the LLM as inspiration for a reformulation. */
const REFORMULATION_SAMPLE_TITLES = 5;
/** Timebox for reformulation step; skip if it is slow. */
const REFORMULATION_TIMEOUT_MS = 1200;

const REFORMULATE_SYSTEM_PROMPT = [
  "You help a vault search system recover from a near-miss query. The user",
  "submitted a query that returned only weak (near-miss) matches. Given the",
  "original query and a small sample of titles from those near-misses,",
  "produce ONE reformulated query that is more likely to match the user's",
  "intent — typically by correcting an obvious typo, swapping a synonym, or",
  "narrowing/broadening one keyword.",
  "",
  "Hard rules:",
  "  * Output a SINGLE alternative query. Do not return multiple options.",
  "  * Keep the same language as the original (English in / English out,",
  "    Russian in / Russian out, mixed in / mixed out).",
  "  * If the original query already looks correct and you have no better",
  "    suggestion, return it unchanged.",
  "",
  'Respond with STRICT JSON only: { "reformulation": "<alternative query>" }',
  "No prose, no markdown, no extra fields.",
].join("\n");

/**
 * Read-only keyword search across the vault. Backed by
 * `searchService.searchLayered`, which:
 *   - separates strong content matches from near-misses
 *   - rewards heading and folder-name hits in addition to title/body
 *   - already excludes the `Deleted/` subtree by construction
 *
 * Layered behaviour added on top of the base search:
 *   1. If the first call returns NO strong hits but DOES return near
 *      hits, we ask the LLM for ONE reformulation (using sample titles
 *      from the near hits as hints) and re-run the search exactly once.
 *   2. If the strong list is large enough that ranking matters, we ask
 *      the LLM to pick the single best candidate and annotate it with
 *      `isBestGuess: true`. The rerank is time-boxed; on timeout or
 *      error we fall back to the score-sorted ordering.
 */
export const searchVaultTool: AgentTool<z.infer<typeof ParamsSchema>, SearchVaultOutput> = {
  name: "search_vault",
  description:
    "Keyword search across the user's vault notes. Returns matching paths, " +
    "titles, and short snippets, split into strong vs near-miss buckets. " +
    "Use to find notes by content, not to answer questions (use " +
    "answer_from_vault for that).",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const search = getSearchService();
    const limit = input.limit ?? 10;
    const reformulationsTried: string[] = [];

    let layered = await search.searchLayered(input.query, { limit });

    if (layered.strong.length === 0 && layered.near.length > 0) {
      const reformulation = await timeBox(
        tryReformulate(input.query, layered.near),
        REFORMULATION_TIMEOUT_MS
      ).catch(
        (err) => {
          ctx.logger.warn("search_vault: reformulation failed", {
            err: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      );
      if (
        reformulation &&
        reformulation.toLowerCase() !== input.query.toLowerCase()
      ) {
        reformulationsTried.push(reformulation);
        const rerun = await search.searchLayered(reformulation, { limit });
        ctx.logger.info("search_vault: reformulated", {
          original: input.query,
          reformulation,
          strongAfter: rerun.strong.length,
          nearAfter: rerun.near.length,
        });
        if (rerun.strong.length > 0 || rerun.near.length > layered.near.length) {
          layered = rerun;
        }
      }
    }

    let strong: AgentSearchHit[] = layered.strong;
    if (strong.length > RERANK_TRIGGER_STRONG_COUNT) {
      const ranked = await rerankIfNeeded(input.query, strong).catch((err) => {
        ctx.logger.warn("search_vault: rerank failed", {
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      if (ranked) strong = ranked;
    }

    ctx.logger.info("search_vault: done", {
      query: input.query,
      strong: strong.length,
      near: layered.near.length,
      reformulationsTried: reformulationsTried.length,
    });

    return {
      query: input.query,
      strong,
      near: layered.near,
      reformulationsTried,
    };
  },
};

/**
 * Ask the LLM for ONE reformulation of `query`, using sample titles from
 * the near-miss bucket as context. Returns `null` when the model can't be
 * parsed or returns an empty string.
 */
async function tryReformulate(
  query: string,
  near: SearchHit[]
): Promise<string | null> {
  const llm = llmProviderFactory.get();
  const sampleTitles = near
    .slice(0, REFORMULATION_SAMPLE_TITLES)
    .map((h) => h.title);

  const resp = await llm.sendMessage({
    temperature: 0,
    responseFormat: "json_object",
    messages: [
      { role: "system", content: REFORMULATE_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({ query, sampleTitles }),
      },
    ],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(resp.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = (parsed as Record<string, unknown>).reformulation;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Run an LLM-backed rerank over the top strong hits and annotate the
 * picked one with `isBestGuess: true`. Time-boxed so a slow provider
 * can't stall the agent loop; on timeout, the original ordering is
 * preserved unchanged.
 */
async function rerankIfNeeded(
  query: string,
  strong: AgentSearchHit[]
): Promise<AgentSearchHit[] | null> {
  const llm = llmProviderFactory.get();
  const candidates: FileRankCandidate[] = strong
    .slice(0, RERANK_CANDIDATE_LIMIT)
    .map((h) => ({ path: h.path, title: h.title }));

  const ranked = await timeBox(
    llm.rankFileCandidates({ query, candidates }),
    RERANK_TIMEOUT_MS
  );
  if (!ranked || !ranked.bestPath) return null;

  const bestPath = ranked.bestPath;
  return strong.map((h) =>
    h.path === bestPath ? { ...h, isBestGuess: true } : h
  );
}

/**
 * Resolve with the promise's value, or `null` if it doesn't settle within
 * `ms`. The underlying promise is left to run to completion in the
 * background; rejection is swallowed (only the timeout result reaches the
 * caller). Used here because the rerank is best-effort.
 */
function timeBox<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}
