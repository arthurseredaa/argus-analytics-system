import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import catalogJson from "../../config/catalog-v1.json";
import { seedStatements, type CatalogFile } from "../../src/db/seed.ts";
import { encrypt, importAesKey } from "../../src/domain/crypto.ts";
import { TEST_PARTNER_SECRETS } from "../fixtures/facts.ts";
import { newCookie, postComplete } from "../fixtures/http.ts";

// Adds a catalog version equal to version 1 except for offer 001's EPU.
async function addVersion(version: number, epu001: number): Promise<void> {
  const base = catalogJson as CatalogFile;
  const file: CatalogFile = {
    ...base,
    version,
    offers: base.offers.map((o) => (o.id === "001" ? { ...o, epu: epu001 } : o)),
  };
  const key = await importAesKey(env.MASTER_KEY, "MASTER_KEY");
  const enc = new Map<string, string>();
  for (const [id, secret] of TEST_PARTNER_SECRETS) enc.set(id, await encrypt(key, secret));
  const stmts = seedStatements(file, enc, Date.now());
  await env.FACTS.batch(stmts.map((s) => env.FACTS.prepare(s.sql).bind(...s.params)));
}

const body = {
  prelander_id: "demo",
  answers: { gender: "women", ethnicity: "asia" },
  email: "user1@example.com",
};

it("OFF-2 EPU change takes effect without deploy", async () => {
  const row = await env.FACTS.prepare("SELECT MAX(version) AS v FROM catalog_history").first<{
    v: number;
  }>();
  const v = row!.v;

  await addVersion(v + 1, 0.95);
  const raised = await (await postComplete(body, newCookie())).json();
  expect(raised).toMatchObject({ offer_id: "001", reason: "best_epu", catalog_version: v + 1 });

  await addVersion(v + 2, 0.8);
  const restored = await (await postComplete(body, newCookie())).json();
  expect(restored).toMatchObject({ offer_id: "003", reason: "best_epu", catalog_version: v + 2 });
});
