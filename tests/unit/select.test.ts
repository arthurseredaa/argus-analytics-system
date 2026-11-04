import { describe, expect, it } from "vitest";
import md from "../../docs/requirements/offer-selection.md?raw";
import selectSource from "../../src/domain/select.ts?raw";
import { select } from "../../src/domain/select.ts";
import { applyChanges, catalogV1, parseDecisionTable } from "../fixtures/decision-table.ts";

const CARDS: Record<number, string[]> = {
  1: ["OFF-5", "OFF-12"],
  2: ["OFF-5"],
  3: ["OFF-5", "OFF-12"],
  4: ["OFF-5"],
  5: ["OFF-6", "OFF-12"],
  6: ["OFF-5", "OFF-12"],
  7: ["OFF-6", "OFF-12"],
  8: ["OFF-6", "OFF-12"],
  9: ["OFF-8"],
  10: ["OFF-5"],
  11: ["OFF-5"],
  12: ["OFF-5"],
  13: ["OFF-6"],
  14: ["OFF-5"],
  15: ["OFF-7"],
  16: ["OFF-3", "OFF-12"],
  17: ["OFF-3"],
  18: ["OFF-9"],
  19: ["OFF-9"],
  20: ["OFF-9"],
  21: ["OFF-8", "OFF-9"],
  22: ["OFF-4"],
  23: ["OFF-4"],
  24: ["QZ-5"],
  25: ["QZ-5"],
  26: ["QZ-3"],
  27: ["OFF-3"],
  28: ["OFF-9"],
  29: ["OFF-5"],
};

const rows = parseDecisionTable(md);

describe("decision table", () => {
  it("TEST-1 every decision table row is mapped to a card", () => {
    const nums = rows.map((r) => r.n);
    expect(nums).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    expect(Object.keys(CARDS).map(Number)).toEqual(nums);
    const first = ["OFF-5", "OFF-6", "OFF-7", "OFF-8", "OFF-12"];
    const second = ["OFF-3", "OFF-4", "OFF-9"];
    for (const n of [...Array.from({ length: 15 }, (_, i) => i + 1), 29])
      expect(CARDS[n]!.some((c) => first.includes(c))).toBe(true);
    for (const n of [16, 17, 18, 19, 20, 21, 22, 23, 27, 28])
      expect(CARDS[n]!.some((c) => second.includes(c))).toBe(true);
  });

  for (const row of rows) {
    const target = row.expected.action === "redirect" ? row.expected.offerId! : row.expected.action;
    for (const moment of row.moments) {
      const suffix = row.bothMoments ? ` at ${moment}` : "";
      it(`${CARDS[row.n]!.join(" ")} row ${row.n} ${row.answersLabel} gives ${target}${suffix}`, () => {
        const facts = { answers: row.answers, leads: row.leads, purchases: [] };
        const result = select(facts, applyChanges(catalogV1(), row.change), moment);
        expect(result).toEqual({ ...row.expected, reason: row.reason, catalogVersion: 1 });
      });
    }
  }
});

describe("lead ties and purity", () => {
  const twoLeads = [
    { offerId: "001", acceptedAt: 1000 },
    { offerId: "004", acceptedAt: 1000 },
  ];
  const answers = { gender: "women", ethnicity: "asia" };

  it("OFF-4 Q-10 leads accepted at the same time go to the higher EPU", () => {
    const r = select({ answers, leads: twoLeads, purchases: [] }, catalogV1(), "completion");
    expect(r).toMatchObject({ action: "redirect", offerId: "004", reason: "lead_return" });
  });

  it("OFF-4 Q-10 equal time and equal EPU go to the lower offer id", () => {
    const catalog = applyChanges(catalogV1(), [{ type: "epu", offerId: "001", epu: 1.1 }]);
    const r = select({ answers, leads: twoLeads, purchases: [] }, catalog, "completion");
    expect(r).toMatchObject({ offerId: "001", reason: "lead_return" });
  });

  it("OFF-12 select is pure", () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === "object") {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    };
    const facts = deepFreeze({ answers, leads: twoLeads.map((l) => ({ ...l })), purchases: [] });
    const catalog = deepFreeze(catalogV1());
    const a = select(facts, catalog, "completion");
    const b = select(facts, catalog, "completion");
    expect(a).toEqual(b);
    const imports = selectSource.split("\n").filter((l) => /^\s*import\b/.test(l));
    expect(imports.every((l) => /^\s*import type\b/.test(l))).toBe(true);
  });

  it("OFF-8 empty catalog gives no_offer with no version", () => {
    const r = select(
      { answers: { gender: "women", ethnicity: "asia" }, leads: [], purchases: [] },
      { version: null, offers: [] },
      "completion",
    );
    expect(r).toEqual({
      action: "no_offer",
      offerId: null,
      reason: "no_offer",
      catalogVersion: null,
    });
  });
});
