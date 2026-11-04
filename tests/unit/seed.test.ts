import { describe, expect, it } from "vitest";
import catalogJson from "../../config/catalog-v1.json";
import { encrypt, importAesKey } from "../../src/domain/crypto.ts";
import { renderSql, seedStatements, type CatalogFile } from "../../src/db/seed.ts";

const file = catalogJson as CatalogFile;
const key = await importAesKey(btoa("test-only-master-key-32-bytes!!!"), "MASTER_KEY");
const secrets = new Map<string, string>();
const PLAIN = new Map([
  ["partnerA", "test-partner-a-secret"],
  ["partnerB", "test-partner-b-secret"],
]);
for (const [id, secret] of PLAIN) secrets.set(id, await encrypt(key, secret));

describe("seed", () => {
  it("OFF-1 seed statements insert one catalog version and the seven offers", () => {
    const st = seedStatements(file, secrets, 1000);
    const count = (t: string) => st.filter((s) => s.sql.includes(`INTO ${t} `)).length;
    expect(count("partners")).toBe(2);
    expect(count("catalog_history")).toBe(1);
    expect(count("offers")).toBe(7);
    for (const s of st) expect(s.sql).toContain("ON CONFLICT");
    const first = file.offers[0]!;
    const row = st.find((s) => s.sql.includes("INTO offers ") && s.params.includes(first.id))!;
    expect(row.params).toContain(first.epu);
    expect(row.params).toContain(JSON.stringify(first.genders));
    expect(row.params).toContain(1);
  });

  it("OFF-1 rendered seed SQL quotes strings and holds no plain partner secret", () => {
    expect(
      renderSql([{ sql: "INSERT INTO t VALUES (?, ?, ?)", params: ["O'Brien", 2, null] }]),
    ).toContain("'O''Brien', 2, NULL");
    const sql = renderSql(seedStatements(file, secrets, 1000));
    expect(sql).not.toContain("test-partner-a-secret");
    expect(sql).not.toContain("test-partner-b-secret");
  });
});
