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
      // Preamble: a comment frame flushes headers + opens the TCP pipe on the
      // client fetch reader immediately, before the first token arrives.
      // Without it some dev-server/proxy setups wait for ~a few KB of body.
      enqueue(`: open\n\n`);
      try {
        for await (const ev of produce()) {
          let frame = "";
          if (ev.event) frame += `event: ${ev.event}\n`;
          frame += `data: ${ev.data === undefined ? "{}" : JSON.stringify(ev.data)}\n\n`;
          enqueue(frame);
          // Yield to the event loop so each enqueue is delivered as its own
          // TCP write rather than coalesced with subsequent frames in the
          // same synchronous tick.
          await Promise.resolve();
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
