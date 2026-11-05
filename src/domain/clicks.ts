// Domain: click ids and the partner URL that carries one.
// Implements ADR 0007 / P-2; serves PB-4, OFF-11.
// WebCrypto only and erasable TypeScript, so it has no Node-specific code.

// 128 random bits as 32 lower-case hex characters.
export function newClickId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The offer URL with `click_id` set; other query parameters are kept.
export function partnerUrl(offerUrl: string, clickId: string): string {
  const url = new URL(offerUrl);
  url.searchParams.set("click_id", clickId);
  return url.toString();
}
