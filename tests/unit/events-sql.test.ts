import { describe, expect, it } from "vitest";
import { eventInsertStatements } from "../../src/db/events.ts";
import type { StoredEvent } from "../../src/events/envelope.ts";

const event = (i: number, payload: Record<string, unknown> = { step: 1 }): StoredEvent => ({
  event_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  schema_version: 1,
  type: "step_viewed",
  client_time: 1762300000000,
  received_at: 1762300000100,
  user_id: "u1",
  visit_id: "v1",
  seq: 1,
  prelander_id: "demo",
  payload,
});

describe("events SQL", () => {
  it("ID-4 100 events become statements of at most 9 rows and 90 bound parameters", () => {
    const statements = eventInsertStatements(Array.from({ length: 100 }, (_, i) => event(i)));
    expect(statements).toHaveLength(12);
    for (const s of statements) expect(s.params.length).toBeLessThanOrEqual(90);
    expect(statements[11]?.params).toHaveLength(10);
    expect(statements.reduce((n, s) => n + s.params.length, 0)).toBe(1000);
  });

  it("ID-1 every insert ignores a repeated event id", () => {
    const statements = eventInsertStatements(Array.from({ length: 20 }, (_, i) => event(i)));
    for (const s of statements) expect(s.sql).toContain("ON CONFLICT (event_id) DO NOTHING");
  });

  it("ID-4 payload is stored as JSON text", () => {
    const payload = { anything: { nested: [1, "two"] } };
    const [statement] = eventInsertStatements([event(1, payload)]);
    expect(statement?.params[9]).toBe(JSON.stringify(payload));
  });

  it("ID-4 no events give no statements", () => {
    expect(eventInsertStatements([])).toEqual([]);
  });
});
