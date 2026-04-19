import { getSearchService } from "@/lib/services/search";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const limitParam = url.searchParams.get("limit");
    const folder = url.searchParams.get("folder") ?? undefined;
    const limit = limitParam
      ? Math.max(1, Math.min(100, Number(limitParam)))
      : 25;

    const hits = await getSearchService().search(q, { limit, folder });
    return ok({ query: q, hits });
  } catch (err) {
    return handleError("GET /api/search", err);
  }
}
