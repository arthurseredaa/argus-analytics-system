import { describe, expect, it } from "vitest";
import { checkProgress, closeStage, type Progress } from "../../scripts/lib/state-rules.ts";

function fixture(): Progress {
  return {
    plan: "docs/plans/example.md",
    updated: "2026-11-01",
    stages: [
      { id: 0, title: "Setup", status: "done", closed: "2026-11-01", verified: "pnpm check" },
      { id: 1, title: "Events", status: "next" },
      { id: 2, title: "Report", status: "pending" },
    ],
  };
}

describe("state-rules check", () => {
  it("state-rules a valid document has no errors", () => {
    expect(checkProgress(fixture())).toEqual([]);
  });

  it("state-rules two next stages is an error", () => {
    const doc = fixture();
    doc.stages[2]!.status = "in_progress";
    const errors = checkProgress(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("exactly one");
  });

  it("state-rules a done stage without closed or verified is an error", () => {
    const doc = fixture();
    delete doc.stages[0]!.closed;
    delete doc.stages[0]!.verified;
    const errors = checkProgress(doc);
    expect(errors.some((e) => e.includes("closed"))).toBe(true);
    expect(errors.some((e) => e.includes("verified"))).toBe(true);
  });

  it("state-rules an unknown status or an extra key is an error", () => {
    const doc = fixture() as unknown as { stages: Record<string, unknown>[] };
    doc.stages[1]!.status = "blocked";
    doc.stages[2]!.owner = "someone";
    const errors = checkProgress(doc);
    expect(errors.some((e) => e.includes("blocked"))).toBe(true);
    expect(errors.some((e) => e.includes("owner"))).toBe(true);
  });

  it("state-rules no next is valid only when all stages are done or skipped", () => {
    const doc = fixture();
    doc.stages[1]!.status = "pending";
    expect(checkProgress(doc).some((e) => e.includes("exactly one"))).toBe(true);
    doc.stages[1] = { id: 1, title: "Events", status: "skipped" };
    doc.stages[2] = { id: 2, title: "Report", status: "skipped" };
    expect(checkProgress(doc)).toEqual([]);
  });

  it("state-rules malformed input is reported without throwing", () => {
    expect(checkProgress(null)).toHaveLength(1);
    expect(checkProgress([])).toHaveLength(1);
    expect(checkProgress({ plan: "p", updated: "2026-11-01" }).length).toBeGreaterThan(0);
    expect(checkProgress({ plan: "p", updated: "2026-11-01", stages: ["x"] })).toHaveLength(1);
  });

  it("state-rules a bad date, commit or duplicate id is an error", () => {
    const doc = fixture();
    doc.updated = "5 Nov 2026";
    doc.stages[0]!.commit = "XYZ";
    doc.stages[2]!.id = 1;
    const errors = checkProgress(doc);
    expect(errors.some((e) => e.includes("updated"))).toBe(true);
    expect(errors.some((e) => e.includes("commit"))).toBe(true);
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("state-rules the $schema pointer is allowed", () => {
    expect(checkProgress({ ...fixture(), $schema: "./progress.schema.json" })).toEqual([]);
  });

  it("state-rules a numeric $schema is an error", () => {
    const errors = checkProgress({ ...fixture(), $schema: 5 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("$schema");
  });
});

describe("state-rules close", () => {
  const close = { verified: "pnpm check", notes: "all good", date: "2026-11-05" };

  it("state-rules close moves the stage to done and the next pending to next", () => {
    const out = closeStage(fixture(), 1, close);
    expect(out.stages[1]).toMatchObject({
      status: "done",
      closed: "2026-11-05",
      verified: "pnpm check",
      notes: "all good",
    });
    expect(out.updated).toBe("2026-11-05");
    expect(out.stages[2]!.status).toBe("next");
    expect(checkProgress(out)).toEqual([]);
  });

  it("state-rules close of the last stage leaves no next", () => {
    const doc = closeStage(fixture(), 1, close);
    const out = closeStage(doc, 2, { verified: "pnpm check", date: "2026-11-06" });
    expect(out.stages.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(out.stages[2]!.notes).toBeUndefined();
    expect(checkProgress(out)).toEqual([]);
  });

  it("state-rules close of a pending or unknown stage throws", () => {
    expect(() => closeStage(fixture(), 2, close)).toThrow(/stage 2 is pending/);
    expect(() => closeStage(fixture(), 9, close)).toThrow(/stage 9 not found/);
  });

  it("state-rules close does not change the input document", () => {
    const doc = fixture();
    const before = structuredClone(doc);
    closeStage(doc, 1, close);
    expect(doc).toEqual(before);
  });
});
