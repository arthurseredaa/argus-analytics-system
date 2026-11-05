import { describe, expect, it } from "vitest";
import { catalogChangeStatements } from "../../src/db/catalog-change.ts";

describe("catalog change statements", () => {
  it("Q-9 a status change writes version n+1 with one offer changed", () => {
    const st = catalogChangeStatements(1, { kind: "status", offerId: "003", active: false }, 5000);
    expect(st).toHaveLength(2);
    expect(st[0]!.sql).toContain("INTO catalog_history");
    expect(st[0]!.params).toContain(2);
    expect(st[0]!.params).toContain("set-status 003 inactive");
    expect(st[1]!.sql).toContain("INTO offers");
    expect(st[1]!.sql).toContain("FROM offers WHERE version");
    expect(st[1]!.params).toEqual([2, "003", 0, 1]);
  });

  it("Q-9 an EPU change touches only the epu column", () => {
    const st = catalogChangeStatements(4, { kind: "epu", offerId: "001", epu: 0.95 }, 5000);
    expect(st[0]!.params).toContain(5);
    expect(st[0]!.params).toContain("set-epu 001 0.95");
    expect(st[1]!.sql).toMatch(/CASE WHEN id = \? THEN \? ELSE epu END/);
    expect(st[1]!.sql).not.toMatch(/ELSE active END/);
    expect(st[1]!.params).toEqual([5, "001", 0.95, 4]);
  });
});
