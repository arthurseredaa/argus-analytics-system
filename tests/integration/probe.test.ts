import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PROBE_USER_ID } from "../../src/routes/probe.ts";
import { call, captureQueue } from "../fixtures/events.ts";
import { clearBucket, filesWith } from "../fixtures/files.ts";
import { newCookie } from "../fixtures/http.ts";
import { failingFacts, recordingDataset } from "../fixtures/metrics.ts";

beforeEach(clearBucket);

describe("GET /__probe", () => {
  it("NFR-6 probe answers 200 with the D1 time", async () => {
    const res = await call("/__probe", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; d1_ms: number };
    expect(body.ok).toBe(true);
    expect(body.d1_ms).toBeGreaterThanOrEqual(0);
  });

  it("NFR-6 probe writes nothing and sets no cookie", async () => {
    const cookie = newCookie();
    const cookieId = cookie.slice(4);
    for (const init of [{}, { cookie }]) {
      const { queue, sent } = captureQueue();
      const rec = recordingDataset();
      const res = await call("/__probe", init, { EVENTS_QUEUE: queue, METRICS: rec.dataset });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(sent).toEqual([]);
      const rows = await env.FACTS.prepare("SELECT id FROM users WHERE id IN (?1, ?2)")
        .bind(PROBE_USER_ID, cookieId)
        .all();
      expect(rows.results).toEqual([]);
      expect(await filesWith("pending/", PROBE_USER_ID)).toEqual([]);
      expect(rec.points.map((p) => p.indexes)).toEqual([["GET /__probe"]]);
    }
  });

  it("NFR-6 probe answers 500 when D1 fails", async () => {
    const res = await call("/__probe", {}, { FACTS: failingFacts() });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });
});
