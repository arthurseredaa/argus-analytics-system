import { env } from "cloudflare:test";
import catalogJson from "../../config/catalog-v1.json";
import { seedStatements, type CatalogFile } from "../../src/db/seed.ts";
import { encrypt, importAesKey } from "../../src/domain/crypto.ts";

export const TEST_PARTNER_SECRETS: ReadonlyMap<string, string> = new Map([
  ["partnerA", "test-partner-a-secret"],
  ["partnerB", "test-partner-b-secret"],
]);

// Loads catalog version 1 and the two test partners; safe to call again.
export async function seedFacts(db: D1Database): Promise<void> {
  const file = catalogJson as CatalogFile;
  const key = await importAesKey(env.MASTER_KEY, "MASTER_KEY");
  const encrypted = new Map<string, string>();
  for (const [id, secret] of TEST_PARTNER_SECRETS) encrypted.set(id, await encrypt(key, secret));
  const statements = seedStatements(file, encrypted, Date.now());
  await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
}
