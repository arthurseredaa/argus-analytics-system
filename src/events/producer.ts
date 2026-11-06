// Events: the one place that sends to the Queue, for browser and server events alike.
// Implements ADR 0005 "Path of an event" (json content type, payload sanitized before the send, one-event R2 file when the Queue refuses); serves NFR-4, NFR-5, R-12, R-23.
import type { StoredEvent } from "./envelope.ts";
import { NDJSON_PUT, pendingKey, toNdjson } from "./files.ts";
import { sanitizePayload } from "./sanitize.ts";

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

export type EventSinks = Pick<Env, "EVENTS_QUEUE" | "EVENTS_BUCKET">;

// The Queue and R2 both refused the event.
export class EventsUnavailable extends Error {}

// Sends to the Queue; when the Queue rejects (backlog full, outage), writes a one-event file to R2
// `pending/`. Throws EventsUnavailable only when both refuse. Logs name the type and the error
// class, never an error message or the event.
export async function sendEvent(sinks: EventSinks, event: StoredEvent): Promise<"queue" | "r2"> {
  const { payload, removed } = sanitizePayload(event.payload);
  if (removed > 0) log({ msg: "payload_sanitized", type: event.type, removed });
  const clean = { ...event, payload };
  try {
    await sinks.EVENTS_QUEUE.send(clean, { contentType: "json" });
    return "queue";
  } catch {
    log({ msg: "queue_send_failed", type: event.type });
  }
  try {
    await sinks.EVENTS_BUCKET.put(
      pendingKey("event", event.received_at, event.event_id),
      toNdjson([clean]),
      NDJSON_PUT,
    );
  } catch (err) {
    log({
      msg: "r2_fallback_failed",
      type: event.type,
      name: err instanceof Error ? err.name : "unknown",
    });
    throw new EventsUnavailable();
  }
  log({ msg: "event_written_to_r2", type: event.type });
  return "r2";
}

// Server events: the request does not wait for the sinks and does not fail when both refuse.
export function emitInBackground(
  ctx: Pick<ExecutionContext, "waitUntil">,
  sinks: EventSinks,
  events: readonly StoredEvent[],
): void {
  for (const event of events) {
    ctx.waitUntil(
      sendEvent(sinks, event).then(
        () => undefined,
        (err: unknown) => {
          if (!(err instanceof EventsUnavailable)) throw err;
        },
      ),
    );
  }
}
