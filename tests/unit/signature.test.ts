import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "../../src/domain/signature.ts";

const secret = "test-partner-a-secret";
const t = 1762300000;
const nowMs = t * 1000;
const body = '{"type":"lead"}';

const check = (
  header: string | undefined,
  over: { body?: string; secrets?: string[]; nowMs?: number } = {},
) =>
  verifySignature({
    header,
    body: over.body ?? body,
    secrets: over.secrets ?? [secret],
    nowMs: over.nowMs ?? nowMs,
  });
const wrongHex = (i: number) => i.toString(16).padStart(64, "0");
const header = async (key: string) => `t=${t},v1=${await signPayload(key, t, body)}`;

describe("postback signature", () => {
  it("PB-3 a signature over the raw body verifies", async () => {
    expect(await signPayload(secret, t, body)).toMatch(/^[0-9a-f]{64}$/);
    expect(await check(await header(secret))).toBe("ok");
  });

  // Computed outside the repository code, so a bug in signPayload() and in the helpers cannot hide each other:
  //   printf '%s' '1762300000.{"type":"lead"}' | openssl dgst -sha256 -hmac 'test-partner-a-secret'
  it("PB-3 R-11 a signature matches a vector computed with openssl", async () => {
    const expected = "21616546dd8456dae4ba84a88257532f4b3205f419763767490fbfe9d7286963";
    expect(await signPayload(secret, t, body)).toBe(expected);
    expect(await check(`t=1762300000,v1=${expected}`)).toBe("ok");
  });

  it("PB-3 R-11 no header gives missing", async () => {
    expect(await check(undefined)).toBe("missing");
  });
  it("PB-3 R-11 a header without t or v1 gives malformed", async () => {
    const v1 = await signPayload(secret, t, body);
    expect(await check("garbage")).toBe("malformed");
    expect(await check(`v1=${v1}`)).toBe("malformed");
    expect(await check(`t=${t}`)).toBe("malformed");
    expect(await check(`t=${t},t=${t},v1=${v1}`)).toBe("malformed");
    expect(await check("")).toBe("malformed");
  });
  it("PB-3 R-11 v1 that is not 64 hex gives malformed", async () => {
    expect(await check(`t=${t},v1=abc`)).toBe("malformed");
    expect(await check(`t=${t},v1=${"g".repeat(64)}`)).toBe("malformed");
    expect(await check(`t=${t},v1=${"a".repeat(65)}`)).toBe("malformed");
  });
  it("PB-3 R-11 more than 8 v1 values give malformed", async () => {
    const good = await signPayload(secret, t, body);
    const withGood = (n: number) =>
      [...Array.from({ length: n - 1 }, (_, i) => wrongHex(i + 1)), good]
        .map((v) => `v1=${v}`)
        .join(",");
    expect(await check(`t=${t},${withGood(9)}`)).toBe("malformed");
    expect(await check(`t=${t},${withGood(8)}`)).toBe("ok");
  });
  it("PB-3 R-11 a wrong secret gives mismatch", async () => {
    expect(await check(await header("another-secret"))).toBe("mismatch");
  });
  it("PB-3 R-11 a re-serialised body gives mismatch", async () => {
    expect(await check(await header(secret), { body: '{ "type": "lead" }' })).toBe("mismatch");
  });
  it("PB-3 R-11 stale timestamp gives stale", async () => {
    expect(await check(await header(secret), { nowMs: nowMs + 301_000 })).toBe("stale");
    expect(await check(await header(secret), { nowMs: nowMs - 301_000 })).toBe("stale");
    expect(await check(await header(secret), { nowMs: nowMs + 299_000 })).toBe("ok");
    expect(await check(await header(secret), { nowMs: nowMs - 299_000 })).toBe("ok");
  });
  it("PB-3 rotation: the current and the previous secret both verify", async () => {
    const secrets = ["current-secret", "previous-secret"];
    expect(await check(await header("current-secret"), { secrets })).toBe("ok");
    expect(await check(await header("previous-secret"), { secrets })).toBe("ok");
  });
  it("PB-3 any of several v1 values may match", async () => {
    const wrong = "0".repeat(64);
    const right = await signPayload(secret, t, body);
    expect(await check(`t=${t},v1=${wrong},v1=${right}`)).toBe("ok");
  });
});
