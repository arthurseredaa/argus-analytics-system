// Route helper: the transition to an offer, shared by GET /go and the entry redirect.
// Implements ADR 0004 (selection decides the offer) and ADR 0007 (click id on the partner URL); serves OFF-3, OFF-9, OFF-11, PB-4.
// The click is stored before the 302, so a postback never names a click that is not in D1 yet.
import type { Context } from "hono";
import type { AppEnv } from "../app.ts";
import { insertClick, type Click } from "../db/clicks.ts";
import type { Catalog, Offer } from "../domain/catalog.ts";
import { newClickId, partnerUrl } from "../domain/clicks.ts";
import type { Selection } from "../domain/select.ts";
import { makeServerEvent, type StoredEvent } from "../events/envelope.ts";
import { emitInBackground } from "../events/producer.ts";

export type Target = { offer: Offer; reason: Click["reason"]; catalogVersion: number };

// The offer a `redirect` selection names, or null for any other selection.
export function redirectTarget(selection: Selection, catalog: Catalog): Target | null {
  const { action, reason, catalogVersion } = selection;
  if (action !== "redirect" || catalogVersion === null) return null;
  if (reason !== "lead_return" && reason !== "best_epu" && reason !== "fallback_universal")
    return null;
  const offer = catalog.offers.find((o) => o.id === selection.offerId);
  return offer === undefined ? null : { offer, reason, catalogVersion };
}

// Writes the click, sends `extraEvents` and `offer_click` in the background, then answers 302.
export async function startTransition(
  c: Context<AppEnv>,
  input: Target & { prelanderId: string; visitId: string; extraEvents?: StoredEvent[] },
): Promise<Response> {
  const clickId = newClickId();
  const now = Date.now();
  const userId = c.get("userId");
  await insertClick(c.env.FACTS, {
    clickId,
    userId,
    offerId: input.offer.id,
    catalogVersion: input.catalogVersion,
    prelanderId: input.prelanderId,
    visitId: input.visitId,
    reason: input.reason,
    createdAt: now,
  });
  emitInBackground(c.executionCtx, c.env, [
    ...(input.extraEvents ?? []),
    makeServerEvent({
      type: "offer_click",
      userId,
      visitId: input.visitId,
      prelanderId: input.prelanderId,
      payload: {
        click_id: clickId,
        offer_id: input.offer.id,
        catalog_version: input.catalogVersion,
        reason: input.reason,
      },
      now,
    }),
  ]);
  return c.body(null, 302, {
    location: partnerUrl(input.offer.url, clickId),
    "cache-control": "no-store",
  });
}
