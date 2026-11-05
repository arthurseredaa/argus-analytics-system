// Domain: HMAC-SHA256 signatures on partner postbacks and their check.
// Implements ADR 0007; serves PB-3, R-11.
// WebCrypto only and erasable TypeScript, so the Worker and scripts/postback.ts share it.

export const SIGNATURE_WINDOW_S = 300;

const enc = new TextEncoder();
const HEADER_PATTERN = /^t=(\d{1,15})((?:,v1=[^,]*)+)$/;
const HEX_64 = /^[0-9a-f]{64}$/i;

// `t=<digits>,v1=<hex>[,v1=<hex>...]`. The v1 values are not checked for shape here.
export function parseSignatureHeader(
  header: string | undefined,
): { t: number; v1: string[] } | null {
  if (header === undefined) return null;
  const match = HEADER_PATTERN.exec(header.trim());
  if (!match) return null;
  const v1 = match[2]!
    .split(",")
    .slice(1)
    .map((part) => part.slice("v1=".length));
  return { t: Number(match[1]), v1 };
}

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Hex HMAC-SHA256 of `${t}.${body}`; the key is the UTF-8 bytes of the secret as given.
export async function signPayload(secret: string, t: number, body: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    enc.encode(`${t}.${body}`),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type SignatureCheck = "ok" | "missing" | "malformed" | "stale" | "mismatch";

export async function verifySignature(input: {
  header: string | undefined;
  body: string;
  secrets: readonly string[];
  nowMs: number;
}): Promise<SignatureCheck> {
  if (input.header === undefined) return "missing";
  const parsed = parseSignatureHeader(input.header);
  if (!parsed || !parsed.v1.every((v) => HEX_64.test(v))) return "malformed";
  if (Math.abs(input.nowMs / 1000 - parsed.t) > SIGNATURE_WINDOW_S) return "stale";

  const data = enc.encode(`${parsed.t}.${input.body}`);
  const candidates = parsed.v1.map(hexToBytes);
  let ok = false;
  // Every secret and every v1 is checked, so the time taken does not show which one matched.
  for (const secret of input.secrets) {
    const key = await hmacKey(secret, "verify");
    for (const sig of candidates) {
      if (await crypto.subtle.verify("HMAC", key, sig, data)) ok = true;
    }
  }
  return ok ? "ok" : "mismatch";
}
