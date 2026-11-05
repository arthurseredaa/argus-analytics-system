import { afterEach, describe, expect, it } from "vitest";
import { storedEvent } from "../fixtures/events.ts";
import { loadNow, pauseLoader, putPending, resumeLoader } from "../fixtures/files.ts";
import { getPath } from "../fixtures/http.ts";
import type { PipelineHealth } from "../../src/events/health.ts";

const health = async (): Promise<PipelineHealth> =>
  (await (await getPath("/__test/health")).json()) as PipelineHealth;

afterEach(resumeLoader);

describe("pipeline health", () => {
  it("NFR-5 health shows pending files and the age of the oldest", async () => {
    await pauseLoader();
    await putPending([storedEvent()]);
    const h = await health();
    expect(h.pending_files).toBeGreaterThanOrEqual(1);
    expect(h.pending_oldest_age_ms).toBeTypeOf("number");
    expect(h.pending_oldest_age_ms).toBeGreaterThanOrEqual(0);
    expect(h.pending_truncated).toBe(false);
  });

  it("NFR-3 health shows the last load time and freshness", async () => {
    const t0 = Date.now();
    await putPending([storedEvent({ received_at: t0 - 5000 })]);
    await loadNow();
    const h = await health();
    expect(h.last_load_at).toBeGreaterThanOrEqual(t0);
    expect(h.events_newest_at).toBeGreaterThanOrEqual(t0 - 5000);
    expect(h.freshness_ms).toBeTypeOf("number");
    expect(h.freshness_ms).toBeGreaterThanOrEqual(0);
  });

  it("NFR-4 health shows the loader paused while the flag exists", async () => {
    await pauseLoader();
    expect((await health()).loader_paused).toBe(true);
    await resumeLoader();
    expect((await health()).loader_paused).toBe(false);
  });

  it("R-12 health sets cache-control no-store", async () => {
    const res = await getPath("/__test/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
