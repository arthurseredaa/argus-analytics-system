import { describe, expect, it } from "vitest";
import { prelanderFlows } from "../../src/domain/prelanders.ts";
import { z } from "zod";
import {
  checkIncoming,
  derivedEventId,
  makeServerEvent,
  SERVER_TYPES,
} from "../../src/events/envelope.ts";
import { browserEvent } from "../fixtures/event-bodies.ts";

const check = (raw: unknown) => checkIncoming(raw, prelanderFlows);
const viewed = (step: number) =>
  check(browserEvent({ type: "step_viewed", payload: { step, prefilled: false } }));
// An object nested `levels` deep; the object itself is level 1.
const nest = (levels: number): Record<string, unknown> => {
  let inner: Record<string, unknown> = {};
  for (let i = 1; i < levels; i++) inner = { a: inner };
  return inner;
};
const invalid = (fields: string[]) => ({ ok: false, error: "invalid_body", fields });

describe("event envelope", () => {
  it("ID-1 a valid step_answered passes unchanged", () => {
    const body = browserEvent();
    expect(check(body)).toEqual({ ok: true, event: body });
  });

  it("ID-1 event without event id is rejected", () => {
    const { event_id: _omitted, ...body } = browserEvent();
    expect(check(body)).toEqual(invalid(["event_id"]));
  });
  it("ID-1 event id that is not a UUID is rejected", () => {
    expect(check(browserEvent({ event_id: "abc" }))).toEqual(invalid(["event_id"]));
  });
  it("ID-1 a request with more than one event is rejected", () => {
    expect(check([browserEvent(), browserEvent()])).toEqual(invalid([]));
    expect(check(null)).toEqual(invalid([]));
    expect(check("x")).toEqual(invalid([]));
  });

  it("ID-2 user id and received_at in the body are dropped", () => {
    const body = browserEvent();
    expect(check({ ...body, user_id: "u-1", received_at: 5 })).toEqual({ ok: true, event: body });
  });

  it("R-12 envelope has no email field: an unknown envelope field is rejected", () => {
    const result = check(browserEvent({ email: "user2@example.com" }));
    expect(result).toEqual(invalid(["<unknown>"]));
    expect(JSON.stringify(result)).not.toContain("user2");
  });

  it("BIZ-2 a client cannot post a server-only type", () => {
    for (const type of SERVER_TYPES) {
      expect(check(browserEvent({ type }))).toMatchObject({
        ok: false,
        error: "server_only_type",
      });
    }
  });

  it("QZ-1 unknown prelander is rejected", () => {
    expect(check(browserEvent({ prelander_id: "nope" }))).toMatchObject({
      ok: false,
      error: "unknown_prelander",
    });
  });

  it("QZ-4 step_answered value must be one of the step's options", () => {
    const payload = { step: 1, question_key: "gender", value: "women" };
    expect(check(browserEvent({ payload: { ...payload, value: "robots" } }))).toEqual(
      invalid(["payload.value"]),
    );
    expect(check(browserEvent({ payload: { ...payload, question_key: "email" } }))).toMatchObject({
      ok: false,
      fields: expect.arrayContaining(["payload.question_key"]),
    });
    expect(check(browserEvent({ payload: { ...payload, step: 2 } }))).toMatchObject({
      ok: false,
      fields: expect.arrayContaining(["payload.step"]),
    });
    expect(check(browserEvent({ payload: { ...payload, extra: 1 } }))).toMatchObject({
      ok: false,
      fields: expect.arrayContaining(["payload.<unknown>"]),
    });
  });

  it("QZ-4 step_viewed step must be within the flow", () => {
    expect(viewed(4)).toMatchObject({ ok: false, fields: ["payload.step"] });
    expect(viewed(3).ok).toBe(true);
  });

  it("ID-4 unknown schema_version is passed without a payload check", () => {
    expect(check(browserEvent({ schema_version: 2, payload: { anything: "x" } })).ok).toBe(true);
  });
  it("ID-4 unknown event type is passed", () => {
    expect(check(browserEvent({ type: "share_clicked", payload: { target: "x" } })).ok).toBe(true);
  });

  it("R-14 type, visit id and prelander id are length-limited", () => {
    expect(check(browserEvent({ type: "a".repeat(65) }))).toEqual(invalid(["type"]));
    expect(check(browserEvent({ visit_id: "a".repeat(65) }))).toEqual(invalid(["visit_id"]));
    expect(check(browserEvent({ prelander_id: "a".repeat(65) }))).toEqual(
      invalid(["prelander_id"]),
    );
    expect(check(browserEvent({ seq: 0 }))).toEqual(invalid(["seq"]));
  });

  it("ID-1 server events get a fresh UUID, version 1, and no client time or seq", () => {
    const input = {
      type: "lead" as const,
      userId: "u-1",
      visitId: "v1",
      prelanderId: "demo",
      payload: {},
      now: 1762300000000,
    };
    const a = makeServerEvent(input);
    const b = makeServerEvent(input);
    expect(a.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.event_id).not.toBe(b.event_id);
    expect(a).toMatchObject({
      schema_version: 1,
      client_time: null,
      seq: null,
      received_at: 1762300000000,
      user_id: "u-1",
      visit_id: "v1",
      prelander_id: "demo",
    });
  });

  it("ID-1 makeServerEvent keeps a given event id", () => {
    const eventId = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
    const event = makeServerEvent({
      type: "lead",
      userId: null,
      visitId: "v1",
      prelanderId: "demo",
      payload: {},
      now: 1,
      eventId,
    });
    expect(event.event_id).toBe(eventId);
  });

  it("PB-5 the postback EventID is derived from partner, type and transaction id", async () => {
    const a = await derivedEventId(["partner-a", "lead", "tx-1"]);
    expect(await derivedEventId(["partner-a", "lead", "tx-1"])).toBe(a);
    expect(await derivedEventId(["partner-a", "lead", "tx-2"])).not.toBe(a);
    expect(z.uuid().safeParse(a).success).toBe(true);
    expect(a[14]).toBe("8");
    expect(a[19]).toMatch(/[89ab]/);
  });

  it("R-14 a payload nested deeper than 32 levels is rejected", () => {
    for (const schema_version of [1, 2]) {
      const type = schema_version === 1 ? "step_viewed" : "page_error";
      expect(check(browserEvent({ type, schema_version, payload: nest(33) }))).toEqual(
        invalid(["payload"]),
      );
    }
    expect(check(browserEvent({ type: "page_error", payload: nest(1001) }))).toEqual(
      invalid(["payload"]),
    );
    expect(check(browserEvent({ type: "page_error", payload: nest(32) })).ok).toBe(true);
    expect(check(browserEvent({ type: "page_error", payload: { list: [[[1]]] } })).ok).toBe(true);
  });
});
