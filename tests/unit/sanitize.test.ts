import { describe, expect, it } from "vitest";
import { sanitizePayload } from "../../src/events/sanitize.ts";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("sanitizePayload", () => {
  it("R-23 R-12 a key named email is removed at any depth", () => {
    const result = sanitizePayload({
      email: "a",
      nested: { userEmail: "b" },
      list: [{ EMAIL: "c" }],
      keep: 1,
    });
    expect(result).toEqual({ payload: { nested: {}, list: [{}], keep: 1 }, removed: 3 });
  });

  it("R-23 string values are left unchanged", () => {
    const payload = { url: "https://x.example/?e=user2@example.com" };
    expect(sanitizePayload(payload)).toEqual({ payload, removed: 0 });
  });

  it("R-23 the demo's step payloads are unchanged", () => {
    const payload = { step: 1, question_key: "gender", value: "women" };
    expect(sanitizePayload(payload)).toEqual({ payload, removed: 0 });
  });

  it("R-23 sanitizing does not change its input", () => {
    const input = deepFreeze({ email: "a", nested: { userEmail: "b" }, list: [{ EMAIL: "c" }] });
    const copy = structuredClone(input);
    sanitizePayload(input);
    expect(input).toEqual(copy);
  });
});
