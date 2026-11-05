import { describe, expect, it, vi } from "vitest";
import { OUTBOX_SCRIPT } from "../../src/pages/outbox.ts";

type Evt = { event_id: string; n?: number };
type Outbox = { enqueue(e: Evt): void; flush(): void; pending(): Evt[] };
type Opts = {
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
  send: (e: Evt) => Promise<number>;
  key: string;
  cap: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

// The script is plain browser JavaScript in a string, so the test evaluates it the way a page would.
// oxlint-disable-next-line no-new-func -- the outbox ships to the browser as a string, evaluating it is the test
const createOutbox = new Function(OUTBOX_SCRIPT + "; return createOutbox;")() as (
  opts: Opts,
) => Outbox;

const KEY = "funnel_outbox_v1";

function mapStorage(map = new Map<string, string>()) {
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

// A send mock whose answers each test controls: every call waits until the test settles it.
function controlledSend() {
  const calls: Evt[] = [];
  const settle: { resolve: (s: number) => void; reject: (e: Error) => void }[] = [];
  const send = (e: Evt) =>
    new Promise<number>((resolve, reject) => {
      calls.push(e);
      settle.push({ resolve, reject });
    });
  return { send, calls, settle };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const ev = (id: string, n = 0): Evt => ({ event_id: id, n });

describe("outbox", () => {
  it("ID-1 events are sent one per request, in order, one at a time", async () => {
    const { send, calls, settle } = controlledSend();
    const box = createOutbox({ storage: mapStorage(), send, key: KEY, cap: 100 });
    box.enqueue(ev("a"));
    box.enqueue(ev("b"));
    box.enqueue(ev("c"));
    await tick();
    expect(calls.map((c) => c.event_id)).toEqual(["a"]);
    settle[0]!.resolve(202);
    await tick();
    expect(calls.map((c) => c.event_id)).toEqual(["a", "b"]);
    settle[1]!.resolve(202);
    await tick();
    settle[2]!.resolve(202);
    await tick();
    expect(calls.map((c) => c.event_id)).toEqual(["a", "b", "c"]);
    expect(box.pending()).toEqual([]);
  });

  it("TEST-3 R-3 an event that failed to send is resent with the same event id", async () => {
    const { send, calls, settle } = controlledSend();
    const box = createOutbox({ storage: mapStorage(), send, key: KEY, cap: 100 });
    box.enqueue(ev("a"));
    await tick();
    settle[0]!.reject(new Error("offline"));
    await tick();
    expect(box.pending()).toHaveLength(1);
    box.flush();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]!.event_id).toBe("a");
  });

  it("NFR-4 a 503 or 429 keeps the event, a 202 or 400 removes it", async () => {
    for (const [status, kept] of [
      [503, true],
      [429, true],
      [408, true],
      [202, false],
      [400, false],
    ] as const) {
      const send = vi.fn<(e: Evt) => Promise<number>>().mockResolvedValue(status);
      const box = createOutbox({ storage: mapStorage(), send, key: KEY, cap: 100 });
      box.enqueue(ev("a"));
      await tick();
      expect(box.pending().length, `status ${status}`).toBe(kept ? 1 : 0);
    }
  });

  it("R-3 events left in storage are sent after a reload", async () => {
    const storage = mapStorage();
    const first = createOutbox({
      storage,
      send: () => Promise.reject(new Error("offline")),
      key: KEY,
      cap: 100,
    });
    first.enqueue(ev("a"));
    await tick();
    expect(JSON.parse(storage.map.get(KEY)!)).toHaveLength(1);

    const send = vi.fn<(e: Evt) => Promise<number>>().mockResolvedValue(202);
    const second = createOutbox({ storage, send, key: KEY, cap: 100 });
    second.flush();
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual(ev("a"));
    expect(second.pending()).toEqual([]);
    expect(JSON.parse(storage.map.get(KEY)!)).toEqual([]);
  });

  it("R-14 the outbox keeps at most 100 events, dropping the oldest", async () => {
    const box = createOutbox({
      storage: mapStorage(),
      send: () => Promise.reject(new Error("offline")),
      key: KEY,
      cap: 100,
    });
    for (let i = 0; i < 101; i++) box.enqueue(ev(`e${i}`, i));
    await tick();
    const pending = box.pending();
    expect(pending).toHaveLength(100);
    expect(pending[0]!.event_id).toBe("e1");
    expect(pending[99]!.event_id).toBe("e100");
  });

  it("R-12 the outbox works when storage throws", async () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const send = vi.fn<(e: Evt) => Promise<number>>().mockResolvedValue(202);
    const box = createOutbox({ storage, send, key: KEY, cap: 100 });
    box.enqueue(ev("a"));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(box.pending()).toEqual([]);
  });

  it("R-12 the outbox works without storage", async () => {
    const send = vi.fn<(e: Evt) => Promise<number>>().mockResolvedValue(202);
    const box = createOutbox({ storage: null, send, key: KEY, cap: 100 });
    box.enqueue(ev("a"));
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("NFR-4 a retryable failure schedules one retry after 30 seconds", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const setTimer = (fn: () => void, ms: number) => void timers.push({ fn, ms });
    const send = vi
      .fn<(e: Evt) => Promise<number>>()
      .mockResolvedValueOnce(503)
      .mockResolvedValueOnce(503)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(202);
    const box = createOutbox({ storage: mapStorage(), send, key: KEY, cap: 100, setTimer });
    box.enqueue(ev("a"));
    await tick();
    expect(timers.map((t) => t.ms)).toEqual([30_000]);
    // A flush while the timer is pending does not schedule a second one.
    box.flush();
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(1);
    // The timer fires, the send is rejected, and one new timer is scheduled.
    timers[0]!.fn();
    await tick();
    expect(send).toHaveBeenCalledTimes(3);
    expect(timers.map((t) => t.ms)).toEqual([30_000, 30_000]);
    timers[1]!.fn();
    await tick();
    expect(box.pending()).toEqual([]);
    expect(timers).toHaveLength(2);
  });
});
