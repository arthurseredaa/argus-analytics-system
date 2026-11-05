import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertEvents, newestEventAt, pingEvents } from "../../src/db/events.ts";
import { LOADER_LIMITS, batchId, runLoader } from "../../src/events/loader.ts";
import { deepPayload } from "../fixtures/event-bodies.ts";
import { eventsOf, storedEvent } from "../fixtures/events.ts";
import {
  insertFailingEvents,
  keysUnder,
  linesOf,
  loadNow,
  pauseLoader,
  putPending,
  resumeLoader,
  unreachableEvents,
} from "../fixtures/files.ts";

const newUser = () => crypto.randomUUID();
const manifestOf = async (id: string) => {
  const object = await env.EVENTS_BUCKET.get(`batches/${id}.json`);
  return object === null ? null : ((await object.json()) as { attempt: number; files: string[] });
};

afterEach(() => vi.restoreAllMocks());

describe("the loader", () => {
  it("NFR-5 R-8 the loader drops repeated event ids inside a batch", async () => {
    const user_id = newUser();
    const a = storedEvent({ user_id });
    const b = storedEvent({ user_id });
    await putPending([a, a, b, a], 1);
    const run = await loadNow();
    expect(await eventsOf(user_id)).toHaveLength(2);
    expect(await linesOf(`loaded/${run.batchIds[0]}.ndjson`)).toHaveLength(2);
    expect(run.duplicates).toBeGreaterThanOrEqual(2);
  });

  it("NFR-5 R-8 an event repeated in a later file is stored once", async () => {
    const user_id = newUser();
    const a = storedEvent({ user_id });
    await putPending([a], 1);
    await loadNow();
    await putPending([a], 2);
    await loadNow();
    expect(await eventsOf(user_id)).toHaveLength(1);
  });

  it("NFR-5 an invalid row goes to rejected/ and the rest of the batch loads", async () => {
    const user_id = newUser();
    const good = storedEvent({ user_id });
    const bad = [
      "not json",
      '{"event_id":"x"}',
      JSON.stringify({ ...storedEvent({ user_id }), received_at: "yesterday" }),
      JSON.stringify(storedEvent({ user_id, payload: deepPayload(33) })),
    ];
    const key = await putPending([JSON.stringify(good), ...bad].join("\n") + "\n", 1);
    const run = await loadNow();
    expect(await eventsOf(user_id)).toHaveLength(1);
    expect(await linesOf(`rejected/${run.batchIds[0]}-invalid.ndjson`)).toEqual(bad);
    expect(await keysUnder(key)).toEqual([]);
    expect(run.invalid).toBe(4);
  });

  it("NFR-5 a run takes at most 9,000 files", async () => {
    expect(LOADER_LIMITS.maxFilesPerRun).toBe(9000);
    const user_id = newUser();
    const keys: string[] = [];
    for (let i = 0; i < 12; i++) keys.push(await putPending([storedEvent({ user_id })], 1000 + i));
    const first = await loadNow({ maxFilesPerRun: 5 });
    expect(first.files).toBe(5);
    expect((await keysUnder("pending/")).filter((k) => keys.includes(k))).toHaveLength(7);
    const second = await loadNow({ maxFilesPerRun: 5 });
    const third = await loadNow({ maxFilesPerRun: 5 });
    expect([second.files, third.files]).toEqual([5, 2]);
    const rows = await eventsOf(user_id);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(12);
  });

  it("NFR-5 a run stops after its batch limit", async () => {
    expect(LOADER_LIMITS.maxRowsPerBatch).toBe(900);
    expect(LOADER_LIMITS.maxBatchesPerRun).toBe(8);
    const user_id = newUser();
    for (let i = 0; i < 4; i++)
      await putPending([storedEvent({ user_id }), storedEvent({ user_id })], 2000 + i);
    const limits = { maxRowsPerBatch: 3, maxBatchesPerRun: 2 };
    const first = await loadNow(limits);
    expect(first.batchIds).toHaveLength(2);
    expect([first.files, first.rows]).toEqual([2, 4]);
    const second = await loadNow(limits);
    expect([second.files, second.rows]).toEqual([2, 4]);
    expect(await eventsOf(user_id)).toHaveLength(8);
  });

  it("NFR-5 a batch failing five loads goes to rejected/", async () => {
    const user_id = newUser();
    const key = await putPending([storedEvent({ user_id }), storedEvent({ user_id })], 3000);
    const id = await batchId([key]);
    for (const attempt of [2, 3, 4, 5]) {
      const run = await loadNow({}, insertFailingEvents());
      expect(run.status).toBe("batch_failed");
      expect((await manifestOf(id))?.attempt).toBe(attempt);
      expect(await keysUnder(key)).toEqual([key]);
    }
    const last = await loadNow({}, insertFailingEvents());
    expect(last.rejected).toBe(1);
    expect(await linesOf(`rejected/${id}.ndjson`)).toHaveLength(2);
    expect(await keysUnder(key)).toEqual([]);
    expect(await manifestOf(id)).toBeNull();
    await loadNow();
    expect(await eventsOf(user_id)).toHaveLength(0);
  });

  it("NFR-5 an unreachable events database does not count as a load attempt", async () => {
    const user_id = newUser();
    const key = await putPending([storedEvent({ user_id }), storedEvent({ user_id })], 4000);
    const id = await batchId([key]);
    for (let i = 0; i < 10; i++) {
      const run = await loadNow({}, unreachableEvents());
      expect(run.status).toBe("d1_unreachable");
      expect((await manifestOf(id))?.attempt).toBe(1);
      expect(await keysUnder(`rejected/${id}`)).toEqual([]);
    }
    await loadNow();
    expect(await eventsOf(user_id)).toHaveLength(2);
    expect(await manifestOf(id)).toBeNull();
  });

  it("NFR-5 a run resumes an unfinished batch first and stores it once", async () => {
    const user_id = newUser();
    const rows = [storedEvent({ user_id }), storedEvent({ user_id })];
    const key = await putPending(rows, 5000);
    const id = await batchId([key]);
    await insertEvents(env.EVENTS, rows);
    await env.EVENTS_BUCKET.put(
      `batches/${id}.json`,
      JSON.stringify({ batch_id: id, files: [key], attempt: 1, created_at: 1 }),
    );
    const run = await loadNow();
    expect(run.batchIds[0]).toBe(id);
    expect(await eventsOf(user_id)).toHaveLength(2);
    expect(await keysUnder(key)).toEqual([]);
    expect(await manifestOf(id)).toBeNull();
    expect(await linesOf(`loaded/${id}.ndjson`)).toHaveLength(2);
  });

  it("NFR-5 a manifest naming a deleted file is closed without error", async () => {
    const user_id = newUser();
    const present = await putPending([storedEvent({ user_id })], 6000);
    const missing = `pending/${String(6001).padStart(13, "0")}-b-${crypto.randomUUID()}.ndjson`;
    const id = await batchId([present, missing]);
    await env.EVENTS_BUCKET.put(
      `batches/${id}.json`,
      JSON.stringify({ batch_id: id, files: [present, missing], attempt: 1, created_at: 1 }),
    );
    const run = await loadNow();
    expect(run.status).toBe("done");
    expect(await eventsOf(user_id)).toHaveLength(1);
    expect(await manifestOf(id)).toBeNull();
  });

  it("NFR-5 two overlapping runs store each event once", async () => {
    const user_id = newUser();
    const rows = [storedEvent({ user_id }), storedEvent({ user_id }), storedEvent({ user_id })];
    await putPending(rows, 7000);
    await Promise.all([loadNow(), loadNow()]);
    expect(await eventsOf(user_id)).toHaveLength(3);
  });

  it("NFR-4 a paused loader skips the run and leaves the files", async () => {
    const user_id = newUser();
    await pauseLoader();
    try {
      const key = await putPending([storedEvent({ user_id })], 8000);
      const run = await loadNow();
      expect(run.status).toBe("paused");
      expect(run.files).toBe(0);
      expect(await keysUnder(key)).toEqual([key]);
      expect(await eventsOf(user_id)).toHaveLength(0);
    } finally {
      await resumeLoader();
    }
    await loadNow();
    expect(await eventsOf(user_id)).toHaveLength(1);
  });

  it("NFR-3 a loading run records the last load time", async () => {
    const user_id = newUser();
    await putPending([storedEvent({ user_id }), storedEvent({ user_id })], 9000);
    const run = await runLoader(env, 1_762_300_000_000);
    expect(run.status).toBe("done");
    const object = await env.EVENTS_BUCKET.get("control/last-load.json");
    const recorded = (await object!.json()) as { at: number; files: number; rows: number };
    expect(recorded.at).toBe(1_762_300_000_000);
    expect(recorded.files).toBeGreaterThanOrEqual(1);
    expect(recorded.rows).toBeGreaterThanOrEqual(2);
  });

  it("R-12 loader logs carry counts and batch ids, never row content", async () => {
    const user_id = newUser();
    const spy = vi.spyOn(console, "log");
    await putPending(
      [
        storedEvent({
          user_id,
          type: "step_answered",
          payload: { step: 1, question_key: "ethnicity", value: "asia" },
        }),
      ],
      10_000,
    );
    await loadNow({}, insertFailingEvents());
    await loadNow();
    const lines = spy.mock.calls.map((args) => String(args[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toContain("asia");
      expect(line).not.toContain(user_id);
    }
  });
});

describe("the events database helpers", () => {
  it("NFR-3 pingEvents tells a reachable database from an unreachable one", async () => {
    expect(await pingEvents(env.EVENTS)).toBe(true);
    expect(await pingEvents(unreachableEvents())).toBe(false);
  });

  it("NFR-3 newestEventAt gives the newest received_at", async () => {
    const received_at = Date.now();
    await insertEvents(env.EVENTS, [storedEvent({ received_at })]);
    expect(await newestEventAt(env.EVENTS)).toBeGreaterThanOrEqual(received_at);
  });
});
