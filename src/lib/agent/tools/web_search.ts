import { z } from "zod";
import { getWebSearchService } from "@/lib/services/webSearch";
import type { AgentTool } from "../types";

const ParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Web search query for fresh/external information."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Maximum number of web results to return (default 5)."),
});

export interface WebSearchToolOutput {
  provider: string;
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    score?: number;
  }>;
}

/**
 * External web search (outside the vault). Use this when the user asks for
 * current/public facts or asks to check a website/service status.
 */
export const webSearchTool: AgentTool<
  z.infer<typeof ParamsSchema>,
  WebSearchToolOutput
> = {
  name: "web_search",
  description:
    "Search the public web for fresh or external information. Returns " +
    "title/url/snippet results. Use when the answer is not in the vault.",
  parameters: ParamsSchema,
  async run(input, ctx) {
    const web = getWebSearchService();
    const out = await web.search(input.query, input.maxResults);
    ctx.logger.info("web_search: done", {
      query: input.query,
      results: out.results.length,
    });
    return out;
  },
};

