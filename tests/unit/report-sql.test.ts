import { describe, expect, it } from "vitest";
import { REPORT_SQL } from "../../src/db/report.ts";
import metrics from "../../docs/design/metrics-and-operations.md?raw";

const firstLine = (sql: string): string => sql.split("\n")[0] ?? "";
const idsOf = (line: string): string[] => line.match(/M-\d+/g) ?? [];

describe("report SQL", () => {
  it("AN-8 every report query names a metric id from the design", () => {
    const entries = Object.entries(REPORT_SQL);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, { sql }] of entries) {
      const line = firstLine(sql);
      expect(line.startsWith("-- "), name).toBe(true);
      const ids = idsOf(line);
      expect(ids.length, name).toBeGreaterThan(0);
      for (const id of ids) expect(metrics, `${name} ${id}`).toContain(`| ${id} |`);
    }
  });

  it("AN-8 every metric the MVP report shows has a query", () => {
    const named = new Set(Object.values(REPORT_SQL).flatMap(({ sql }) => idsOf(firstLine(sql))));
    for (const id of [1, 2, 3, 4, 5, 8, 10, 11, 13, 14, 15, 16])
      expect(named.has(`M-${id}`), `M-${id}`).toBe(true);
  });
});
