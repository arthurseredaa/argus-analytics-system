import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { changeCatalog } from "../fixtures/catalog.ts";
import { newCookie, postComplete } from "../fixtures/http.ts";

const body = {
  prelander_id: "demo",
  answers: { gender: "women", ethnicity: "asia" },
  email: "user1@example.com",
};

type Row = { id: string; partner_id: string; epu: number; active: number; url: string };

const offersOf = async (version: number) =>
  (
    await env.FACTS.prepare(
      "SELECT id, partner_id, epu, active, url FROM offers WHERE version = ? ORDER BY id",
    )
      .bind(version)
      .all<Row>()
  ).results;

describe("catalog change", () => {
  it("A-4 Q-9 disabled offer is not selected once the change has taken effect", async () => {
    try {
      await changeCatalog({ kind: "status", offerId: "003", active: false });
      const res = await postComplete(body, newCookie());
      expect(await res.json()).toMatchObject({ offer_id: "001" });
    } finally {
      await changeCatalog({ kind: "status", offerId: "003", active: true });
    }
  });

  it("Q-9 the new version keeps every other offer unchanged", async () => {
    const before = (await env.FACTS.prepare("SELECT MAX(version) AS v FROM catalog_history").first<{
      v: number;
    }>())!.v;
    let next: number | undefined;
    try {
      next = await changeCatalog({ kind: "status", offerId: "003", active: false });
      expect(next).toBe(before + 1);
      const old = await offersOf(before);
      const now = await offersOf(next);
      expect(now).toHaveLength(7);
      expect(now.filter((o) => o.id !== "003")).toEqual(old.filter((o) => o.id !== "003"));
      expect(now.find((o) => o.id === "003")?.active).toBe(0);
      const history = await env.FACTS.prepare(
        "SELECT changed_by, note FROM catalog_history WHERE version = ?",
      )
        .bind(next)
        .first();
      expect(history).toEqual({ changed_by: "offer-script", note: "set-status 003 inactive" });
    } finally {
      if (next !== undefined) await changeCatalog({ kind: "status", offerId: "003", active: true });
    }
  });
});
