import { createLogger } from "@/lib/utils/logger";

const log = createLogger("sse");

export interface SSEEvent {
  /** Event name; omit to use the default ("message"). */
  event?: string;
  /** Payload; serialized to JSON. */
  data?: unknown;
}

/**
 * Wrap an async iterable of SSE events into a streamed Response.
 * Keeps all transport concerns (encoding, headers, error frames) out of the
 * service layer and out of route handlers.
 */
export function sseResponse(
  produce: () => AsyncIterable<SSEEvent>,
  init: { scope?: string } = {}
): Response {
  const scope = init.scope ?? "stream";
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (frame: string) =>
        controller.enqueue(encoder.encode(frame));
      try {
        for await (const ev of produce()) {
          let frame = "";
          if (ev.event) frame += `event: ${ev.event}\n`;
          frame += `data: ${ev.data === undefined ? "{}" : JSON.stringify(ev.data)}\n\n`;
          enqueue(frame);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "stream failed";
        log.error(`${scope}: ${message}`, { err });
        enqueue(
          `event: error\ndata: ${JSON.stringify({ message })}\n\n`
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
