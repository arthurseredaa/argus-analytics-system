// Domain: AES-GCM encryption of emails and partner secrets, and the HMAC email hash.
// Implements ADR 0002 and the "Personal data" section of data-model.md; serves DEMO-8, P-5, PB-3.
// WebCrypto only, so the same code runs in the Worker and in the Node seed script.

// A missing or malformed secret. The message names the variable, never its value.
export class ConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(message);
    this.variable = variable;
    this.name = "ConfigError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function keyBytes(base64: string | undefined, name: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    bytes = fromBase64(base64 ?? "");
  } catch {
    bytes = null;
  }
  if (bytes === null || bytes.length !== 32) {
    throw new ConfigError(name, `${name} must be base64 of exactly 32 bytes`);
  }
  return bytes;
}

export async function importAesKey(base64: string, name: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes(base64, name), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function importHmacKey(base64: string, name: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes(base64, name),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// Returns `v1:<iv base64>:<ciphertext base64>`; a fresh random IV per call.
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(ct))}`;
}

export async function decrypt(key: CryptoKey, token: string): Promise<string> {
  const parts = token.split(":");
  const [version, ivText, ct] = parts;
  if (parts.length !== 3 || version !== "v1" || !ivText || !ct) {
    throw new Error("unsupported ciphertext format");
  }
  const iv = fromBase64(ivText);
  if (iv.length !== 12) throw new Error("unsupported ciphertext format");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fromBase64(ct));
  return dec.decode(plain);
}

// 64 lower-case hex chars; trimmed and lower-cased first, so one address has one hash.
export async function emailHash(key: CryptoKey, email: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(email.trim().toLowerCase()));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}
