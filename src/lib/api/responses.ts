import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("api");

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(
  message: string,
  status = 400,
  details?: unknown
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { message, details } },
    { status }
  );
}

export function handleError(scope: string, err: unknown): NextResponse {
  if (err instanceof ZodError) {
    log.warn(`${scope}: validation error`, { issues: err.issues });
    return fail("Invalid request", 400, err.issues);
  }
  if (err instanceof Error) {
    log.error(`${scope}: ${err.message}`, { stack: err.stack });
    return fail(err.message, 500);
  }
  log.error(`${scope}: unknown error`, { err });
  return fail("Unexpected error", 500);
}
