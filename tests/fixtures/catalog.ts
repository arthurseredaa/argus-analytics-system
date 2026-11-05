// Fixture: writes a new catalog version through the same statements the offer script uses.
import { env } from "cloudflare:test";
import { catalogChangeStatements, type CatalogChange } from "../../src/db/catalog-change.ts";

// Returns the new version. A test that changes the catalog restores it in `finally`.
export async function changeCatalog(change: CatalogChange): Promise<number> {
  const row = await env.FACTS.prepare("SELECT MAX(version) AS v FROM catalog_history").first<{
    v: number;
  }>();
  const current = row!.v;
  const statements = catalogChangeStatements(current, change, Date.now());
  await env.FACTS.batch(statements.map((s) => env.FACTS.prepare(s.sql).bind(...s.params)));
  return current + 1;
}
