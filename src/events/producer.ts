// Events: the one place that sends to the Queue, for browser and server events alike.
// Implements ADR 0005 (json content type, payload sanitized before the send); serves NFR-4, NFR-5, R-12, R-23.
// Stage 5 adds the R2 fallback around these sends.
import type { StoredEvent } from "./envelope.ts";
import { sanitizePayload } from "./sanitize.ts";

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

// Rejects when the Queue rejects; the caller decides what that means.
export async function sendEvent(queue: Queue, event: StoredEvent): Promise<void> {
  const { payload, removed } = sanitizePayload(event.payload);
  if (removed > 0) log({ msg: "payload_sanitized", type: event.type, removed });
  await queue.send({ ...event, payload }, { contentType: "json" });
}

// Server events: the request does not wait for the Queue and does not fail when it refuses.
export function emitInBackground(
  ctx: ExecutionContext,
  queue: Queue,
  events: readonly StoredEvent[],
): void {
  for (const event of events) {
    ctx.waitUntil(
      sendEvent(queue, event).catch(() => {
        log({ msg: "queue_send_failed", source: "server", type: event.type });
      }),
    );
  }
}
