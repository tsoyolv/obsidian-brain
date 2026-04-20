import { getRuntimeConfig } from "@/lib/config";
import { handleError, ok } from "@/lib/api/responses";
import { ensureStartupBootstrap } from "@/lib/bootstrap/startup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureStartupBootstrap();
    return ok(getRuntimeConfig());
  } catch (err) {
    return handleError("GET /api/config/runtime", err);
  }
}
