import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("webSearchService");

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface WebSearchOutput {
  provider: "tavily";
  query: string;
  results: WebSearchResult[];
}

export interface WebSearchService {
  search(query: string, maxResults?: number): Promise<WebSearchOutput>;
}

class TavilyWebSearchService implements WebSearchService {
  async search(query: string, maxResults = 5): Promise<WebSearchOutput> {
    const cfg = getConfig();
    const apiKey = cfg.tavily.apiKey;
    if (!apiKey) {
      throw new Error(
        "Web search is not configured. Set TAVILY_API_KEY in .env.local."
      );
    }

    const q = query.trim();
    if (!q) {
      throw new Error("Query must not be empty.");
    }

    const limit = Math.max(1, Math.min(10, Math.trunc(maxResults || 5)));
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_images: false,
        include_raw_content: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tavily search failed: ${res.status} ${body}`.trim());
    }

    const json = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
      }>;
    };

    const results: WebSearchResult[] = Array.isArray(json.results)
      ? json.results
          .map((r) => ({
            title: (r.title ?? "").trim(),
            url: (r.url ?? "").trim(),
            snippet: (r.content ?? "").trim(),
            score: typeof r.score === "number" ? r.score : undefined,
          }))
          .filter((r) => r.title && r.url)
      : [];

    log.info("web search done", { query: q, results: results.length });
    return {
      provider: "tavily",
      query: q,
      results,
    };
  }
}

let cached: WebSearchService | null = null;

export function getWebSearchService(): WebSearchService {
  if (cached) return cached;
  cached = new TavilyWebSearchService();
  return cached;
}

