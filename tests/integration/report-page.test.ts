import { describe, expect, it } from "vitest";
import { call } from "../fixtures/events.ts";
import { an1Fixture } from "../fixtures/report.ts";

const DAY_2_TEXT = "2001-02-04";

async function page(query: Record<string, string>): Promise<Response> {
  return call(`/report?${new URLSearchParams(query)}`, {});
}

describe("report page", () => {
  it("AN-6 report page renders the five counts", async () => {
    const { prelander } = await an1Fixture();
    const res = await page({ from: DAY_2_TEXT, to: DAY_2_TEXT, prelander });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const [metric, value] of [
      ["started", 3],
      ["step_2", 2],
      ["step_3", 2],
      ["went_to_offer", 1],
      ["lead", 1],
      ["purchase", 1],
    ] as const)
      expect(html, metric).toContain(`data-metric="${metric}">${value}<`);
  });

  it("AN-6 the page switches between the cohort and the postback view", async () => {
    const { prelander } = await an1Fixture();
    const base = { from: DAY_2_TEXT, to: DAY_2_TEXT, prelander };

    const cohort = await (await page(base)).text();
    expect(cohort).toContain('data-view="cohort"');
    const link = new URLSearchParams({ view: "postback", ...base });
    expect(cohort).toContain(`href="/report?${link.toString().replaceAll("&", "&amp;")}"`);

    const postback = await (await page({ view: "postback", ...base })).text();
    expect(postback).toContain('data-view="postback"');
    expect(postback).toContain('data-metric="purchase">2<');
    expect(postback).not.toContain('data-metric="started"');
  });

  it("AN-6 the page prints the as-of time", async () => {
    const html = await (await page({})).text();
    const match = /data-as-of="([^"]*)"/.exec(html);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });

  it("AN-6 a bad query gives 400 on the page", async () => {
    const res = await page({ from: "2001-02-30" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid report query");
  });

  it("AN-6 the page sets no cookie and is not cached", async () => {
    const res = await page({});
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("AN-6 markup in the query never reaches the page", async () => {
    const res = await page({ prelander: '"><script>alert(1)</script>' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("<script>");
  });
});
