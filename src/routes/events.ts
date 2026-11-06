// Route: POST /api/events, the browser event intake.
// Implements ADR 0005 and "Event envelope" of data-model.md; serves ID-1, ID-2, BIZ-2, NFR-4, NFR-5, R-12, R-14, R-23.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import type { Flow } from "../domain/flow.ts";
import { checkIncoming } from "../events/envelope.ts";
import { EventsUnavailable, sendEvent } from "../events/producer.ts";
import { readLimited } from "./body.ts";

const MAX_BODY_BYTES = 4096;

// One JSON object per line; callers pass field names and counts, never request values.
const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

export function eventsRoute(flows: ReadonlyMap<string, Flow>): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post("/events", async (c) => {
    const bytes = await readLimited(c.req.raw, MAX_BODY_BYTES);
    if (bytes === null) return c.json({ error: "too_large" }, 413);
    const text = new TextDecoder().decode(bytes);

    // The parse error is not logged: V8 quotes part of the input in its message.
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_body", fields: [] }, 400);
    }

    const checked = checkIncoming(raw, flows);
    if (!checked.ok) {
      log({ msg: "event_rejected", error: checked.error, fields: checked.fields });
      return c.json({ error: checked.error, fields: checked.fields }, 400);
    }

    try {
      await sendEvent(c.env, {
        ...checked.event,
        user_id: c.get("userId"),
        received_at: Date.now(),
      });
    } catch (err) {
      // The Queue and R2 both refused; sendEvent has logged why.
      if (!(err instanceof EventsUnavailable)) throw err;
      return c.json({ error: "unavailable" }, 503, { "Retry-After": "30" });
    }
    return c.json({ ok: true }, 202);
  });

  return route;
}
