// Builds a signed partner postback request for scripts/postback.ts and for tests.
// Implements ADR 0007; serves PB-3, PB-7. WebCrypto only and erasable TypeScript, no Node imports.
import { signPayload } from "../../src/domain/signature.ts";

export type PostbackInput = {
  base: string;
  partner: string;
  type: "lead" | "purchase";
  clickId: string;
  transactionId: string;
  secret: string;
  nowMs: number;
  payout?: string;
  currency?: string;
};

export async function buildPostbackRequest(
  input: PostbackInput,
): Promise<{ url: string; init: RequestInit }> {
  const body = JSON.stringify({
    type: input.type,
    click_id: input.clickId,
    transaction_id: input.transactionId,
    occurred_at: new Date(input.nowMs).toISOString(),
    ...(input.payout === undefined ? {} : { payout: input.payout }),
    ...(input.currency === undefined ? {} : { currency: input.currency }),
  });
  const t = Math.floor(input.nowMs / 1000);
  const signature = await signPayload(input.secret, t, body);
  return {
    url: `${input.base.replace(/\/+$/, "")}/postback/v1/${encodeURIComponent(input.partner)}`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Signature": `t=${t},v1=${signature}`,
      },
      body,
      redirect: "manual",
    },
  };
}
