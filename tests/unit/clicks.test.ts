import { describe, expect, it } from "vitest";
import { newClickId, partnerUrl } from "../../src/domain/clicks.ts";

describe("click ids", () => {
  it("PB-4 P-2 click id has 128 random bits", () => {
    expect(newClickId()).toMatch(/^[0-9a-f]{32}$/);
    const ids = new Set(Array.from({ length: 1000 }, () => newClickId()));
    expect(ids.size).toBe(1000);
  });

  it("OFF-11 partner url carries the click id", () => {
    expect(partnerUrl("https://asia-connect.example", "abc")).toBe(
      "https://asia-connect.example/?click_id=abc",
    );
    const url = new URL(partnerUrl("https://asia-connect.example/offer?a=1", "abc"));
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.get("click_id")).toBe("abc");
  });
});
