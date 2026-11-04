import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decrypt, importAesKey } from "../../src/domain/crypto.ts";
import { seedFacts, TEST_PARTNER_SECRETS } from "../fixtures/facts.ts";

const count = async (t: string) =>
  (await env.FACTS.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;

describe("seed", () => {
  it("OFF-1 seeded catalog version 1 has the seven offers, all active", async () => {
    const { results } = await env.FACTS.prepare(
      "SELECT id, epu, active FROM offers WHERE version = 1 ORDER BY id",
    ).all<{ id: string; epu: number; active: number }>();
    expect(results.map((r) => r.id)).toEqual(["001", "002", "003", "004", "005", "006", "007"]);
    expect(results.map((r) => r.epu)).toEqual([0.8, 0.65, 0.95, 1.1, 0.7, 0.6, 0.5]);
    expect(results.every((r) => r.active === 1)).toBe(true);
  });

  it("OFF-1 seeding twice changes nothing", async () => {
    const tables = ["partners", "catalog_history", "offers"];
    const before = await Promise.all(tables.map(count));
    await seedFacts(env.FACTS);
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  it("PB-3 partner secrets are stored encrypted", async () => {
    const key = await importAesKey(env.MASTER_KEY, "MASTER_KEY");
    for (const [id, secret] of TEST_PARTNER_SECRETS) {
      const row = await env.FACTS.prepare(
        "SELECT secret_current_enc AS enc FROM partners WHERE id = ?",
      )
        .bind(id)
        .first<{ enc: string }>();
      expect(row!.enc.startsWith("v1:")).toBe(true);
      expect(await decrypt(key, row!.enc)).toBe(secret);
    }
  });
});
