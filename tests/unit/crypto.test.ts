import { describe, expect, it } from "vitest";
import {
  ConfigError,
  decrypt,
  emailHash,
  encrypt,
  importAesKey,
  importHmacKey,
} from "../../src/domain/crypto.ts";

const KEY_A = btoa("test-only-master-key-32-bytes!!!");
const KEY_B = btoa("another-test-key-of-32-bytes!!!!");
const HASH_KEY = btoa("test-only-email-hash-key-32byte!");

describe("crypto", () => {
  it("DEMO-8 P-5 email encrypts to v1 ciphertext and decrypts back", async () => {
    const k = await importAesKey(KEY_A, "MASTER_KEY");
    const token = await encrypt(k, "user1@example.com");
    expect(token).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(token).not.toContain("user1");
    expect(await decrypt(k, token)).toBe("user1@example.com");
  });

  it("DEMO-8 P-5 two encryptions of one email differ", async () => {
    const k = await importAesKey(KEY_A, "MASTER_KEY");
    expect(await encrypt(k, "user1@example.com")).not.toBe(await encrypt(k, "user1@example.com"));
  });

  it("DEMO-8 P-5 ciphertext under another key does not decrypt", async () => {
    const k1 = await importAesKey(KEY_A, "MASTER_KEY");
    const k2 = await importAesKey(KEY_B, "MASTER_KEY");
    const token = await encrypt(k1, "user1@example.com");
    await expect(decrypt(k2, token)).rejects.toMatchObject({ name: "OperationError" });
  });

  it("DEMO-8 P-5 email hash ignores case and surrounding spaces", async () => {
    const h = await importHmacKey(HASH_KEY, "EMAIL_HASH_KEY");
    const a = await emailHash(h, " User1@Example.com ");
    expect(a).toBe(await emailHash(h, "user1@example.com"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("DEMO-8 a key that is not 32 bytes is a config error that does not show the value", async () => {
    const err = await importAesKey("not-base64", "MASTER_KEY").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("MASTER_KEY");
    expect((err as Error).message).not.toContain("not-base64");
  });
});
