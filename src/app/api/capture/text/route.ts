import { z } from "zod";
import { getCaptureService } from "@/lib/services/capture";
import { handleError, ok } from "@/lib/api/responses";

export const runtime = "nodejs";

const BodySchema = z.object({
  text: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const result = await getCaptureService().handleText({ text: body.text });
    return ok(result);
  } catch (err) {
    return handleError("POST /api/capture/text", err);
  }
}
