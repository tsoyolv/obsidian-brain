import type { SearchHit } from "@/lib/types";
import { getVaultService } from "@/lib/services/vault";

export interface SearchOptions {
  limit?: number;
  folder?: string;
}

export interface SearchService {
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}

class SearchServiceImpl implements SearchService {
  private readonly vault = getVaultService();

  async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
    return this.vault.searchNotes(query, options);
  }
}

let cached: SearchService | null = null;

export function getSearchService(): SearchService {
  if (cached) return cached;
  cached = new SearchServiceImpl();
  return cached;
}
