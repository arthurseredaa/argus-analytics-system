import { describe, expect, it } from "vitest";
import { REPORT_SQL } from "../../src/db/report.ts";
import metrics from "../../docs/design/metrics-and-operations.md?raw";

const firstLine = (sql: string): string => sql.split("\n")[0] ?? "";
const idsOf = (line: string): string[] => line.match(/M-\d+/g) ?? [];

describe("report SQL", () => {
  it("AN-8 every report query names a metric id from the design", () => {
    const entries = Object.entries(REPORT_SQL);
    expect(entries.length).toBeGreaterThan(0);
    // The freshness query reads no metric; its header says so instead of naming one.
    expect(idsOf(firstLine(REPORT_SQL["events_newest"]?.sql ?? ""))).toEqual([]);
    for (const [name, { sql }] of entries.filter(([n]) => n !== "events_newest")) {
      const line = firstLine(sql);
      expect(line.startsWith("-- "), name).toBe(true);
      const ids = idsOf(line);
      expect(ids.length, name).toBeGreaterThan(0);
      for (const id of ids) expect(metrics, `${name} ${id}`).toContain(`| ${id} |`);
    }
  });

  it("AN-8 the Lead query names every metric it computes", () => {
    for (const name of ["cohort_leads_offer", "postback_leads_offer"])
      expect(idsOf(firstLine(REPORT_SQL[name]?.sql ?? "")), name).toEqual(["M-13", "M-26", "M-27"]);
  });

  it("AN-8 every statement in the list is one the report runs", () => {
    // The Lead query of the postback view runs at offer grain only; the other grains are sums.
    expect(Object.keys(REPORT_SQL).filter((n) => n.startsWith("postback_leads"))).toEqual([
      "postback_leads_offer",
    ]);
  });

  it("AN-8 every metric the MVP report shows has a query", () => {
    const named = new Set(Object.values(REPORT_SQL).flatMap(({ sql }) => idsOf(firstLine(sql))));
    for (const id of [1, 2, 3, 4, 5, 8, 10, 11, 13, 14, 15, 16])
      expect(named.has(`M-${id}`), `M-${id}`).toBe(true);
  });
});
