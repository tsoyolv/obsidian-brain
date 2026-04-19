import { getRuntimeConfig } from "@/lib/config";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(getRuntimeConfig());
  } catch (err) {
    return handleError("GET /api/config/runtime", err);
  }
}
