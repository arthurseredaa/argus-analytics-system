import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postbackCountsSince, recordPostback } from "../../src/db/postback-counts.ts";
import { runAlerts } from "../../src/ops/alerts.ts";
import { alertLines, logLines, queueWithBacklog } from "../fixtures/alerts.ts";
import { clearBucket } from "../fixtures/files.ts";
import { overloadedFacts, recordingDataset } from "../fixtures/metrics.ts";
import {
  deleteTestPartner,
  insertTestPartner,
  leadBody,
  postback,
  userWithClick,
} from "../fixtures/postback.ts";

const SECRET = "pbc-secret";

beforeEach(clearBucket);
afterEach(() => {
  vi.restoreAllMocks();
});

// A partner of its own, removed when the case ends.
async function withPartner(run: (id: string) => Promise<void>): Promise<void> {
  const id = `pbc-${crypto.randomUUID()}`;
  await insertTestPartner({ id, active: true, current: SECRET });
  try {
    await run(id);
  } finally {
    await deleteTestPartner(id);
  }
}

const olderThanADay = () => postbackCountsSince(env.FACTS, Date.now() - 26 * 3_600_000);

const countsOf = async (partner: string) =>
  (await postbackCountsSince(env.FACTS, Date.now() - 15 * 60_000)).find(
    (r) => r.partner_id === partner,
  );

// The alert run against the test bindings, with no backlog and a recording dataset.
const runNow = () =>
  runAlerts(
    {
      ...env,
      METRICS: recordingDataset().dataset,
      EVENTS_QUEUE: queueWithBacklog(0),
      EVENTS_DLQ: queueWithBacklog(0),
    },
    Date.now(),
  );

async function wrongSecretLeads(partner: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const res = await postback(partner, leadBody("a".repeat(32)), { secret: "not-the-secret" });
    expect(res.status).toBe(401);
  }
}

describe("postback counts", () => {
  it("PB-3 a postback with a wrong secret counts a request and no acceptance", async () => {
    await withPartner(async (id) => {
      const res = await postback(id, leadBody("a".repeat(32)), { secret: "another-secret" });
      expect(res.status).toBe(401);
      const row = (await postbackCountsSince(env.FACTS, Date.now() - 60_000)).find(
        (r) => r.partner_id === id,
      );
      expect(row).toEqual({ partner_id: id, requests: 1, accepted: 0 });
    });
  });

  it("PB-1 an accepted Lead and its duplicate count as accepted", async () => {
    const before = (await countsOf("partnerA")) ?? { requests: 0, accepted: 0 };
    const { clickId } = await userWithClick();
    const body = leadBody(clickId);
    expect((await postback("partnerA", body)).status).toBe(202);
    expect((await postback("partnerA", body)).status).toBe(200);
    const after = await countsOf("partnerA");
    expect(after?.requests).toBe(before.requests + 2);
    expect(after?.accepted).toBe(before.accepted + 2);
  });

  it("PB-3 an unknown partner is not counted", async () => {
    const id = `nobody-${crypto.randomUUID()}`;
    expect((await postback(id, leadBody("a".repeat(32)))).status).toBe(401);
    expect(await countsOf(id)).toBeUndefined();
  });

  it("PB-3 Q-11 postbacks_without_conversions fires after five rejected postbacks of one partner", async () => {
    const log = vi.spyOn(console, "log");
    await withPartner(async (five) => {
      await withPartner(async (four) => {
        await wrongSecretLeads(five, 5);
        await wrongSecretLeads(four, 4);
        await runNow();
        const lines = alertLines(log).filter((l) => l["id"] === "postbacks_without_conversions");
        const mine = lines.find((l) => l["partner_id"] === five);
        expect(mine).toMatchObject({ value: 5, threshold: 5 });
        expect(lines.some((l) => l["partner_id"] === four)).toBe(false);
      });
    });
  });

  it("PB-4 Q-11 five quarantined postbacks of one partner fire it too", async () => {
    const log = vi.spyOn(console, "log");
    await withPartner(async (id) => {
      for (let i = 0; i < 5; i++) {
        const res = await postback(id, leadBody("b".repeat(32)), { secret: SECRET });
        expect(res.status).toBe(202);
      }
      await runNow();
      const line = alertLines(log).find(
        (l) => l["id"] === "postbacks_without_conversions" && l["partner_id"] === id,
      );
      expect(line).toMatchObject({ value: 5, threshold: 5 });
    });
  });

  it("PB-3 counts older than a day are deleted by the alert run", async () => {
    await withPartner(async (id) => {
      await recordPostback(env.FACTS, {
        at: Date.now() - 25 * 3_600_000,
        partnerId: id,
        accepted: false,
      });
      expect((await olderThanADay()).some((r) => r.partner_id === id)).toBe(true);
      await runNow();
      expect((await olderThanADay()).some((r) => r.partner_id === id)).toBe(false);
    });
  });

  it("NFR-6 a D1 overload in a postback is tagged on its data point", async () => {
    const log = vi.spyOn(console, "log");
    const rec = recordingDataset();
    const res = await postback(
      "partnerA",
      leadBody("a".repeat(32)),
      {},
      { FACTS: overloadedFacts(), METRICS: rec.dataset },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(rec.points[0]?.blobs?.[3]).toBe("d1_overload");
    const line = logLines(log, "postback")[0];
    expect(line?.["reason"]).toBe("d1_unavailable");
    expect(JSON.stringify(line)).not.toContain("overloaded");
  });
});
