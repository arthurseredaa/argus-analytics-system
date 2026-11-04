// Domain: offer selection, one pure function with no I/O.
// Implements ADR 0004 "Shape of the selection code"; serves OFF-3 to OFF-9, OFF-12, Q-1, Q-10.
import type { Catalog, Offer } from "./catalog.ts";

export type Moment = "entry" | "completion" | "redirect";

export type Facts = {
  answers: Readonly<Record<string, unknown>>;
  leads: readonly { offerId: string; acceptedAt: number }[];
  purchases: readonly { offerId: string }[];
};

export type Reason = "lead_return" | "best_epu" | "fallback_universal" | "no_offer" | "quiz_needed";

export type Selection = {
  action: "redirect" | "quiz" | "no_offer";
  offerId: string | null;
  reason: Reason;
  catalogVersion: number | null;
};

const byId = (a: Offer, b: Offer): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function select(facts: Facts, catalog: Catalog, moment: Moment): Selection {
  const done = (
    action: Selection["action"],
    offerId: string | null,
    reason: Reason,
  ): Selection => ({ action, offerId, reason, catalogVersion: catalog.version });

  // Step 1: drop offers the user may not be sent to. Empty today; the exclusion after a
  // Purchase (DES-5, Q-20) goes here as one filter, and also stops a Lead redirect.
  const candidates: readonly Offer[] = catalog.offers;
  const active = candidates.filter((o) => o.active);
  const activeById = new Map(active.map((o) => [o.id, o]));

  // Step 2: Leads for active offers, newest first, then higher EPU, then lower offer id.
  const leads = facts.leads
    .flatMap((l) => {
      const offer = activeById.get(l.offerId);
      return offer === undefined ? [] : [{ offer, acceptedAt: l.acceptedAt }];
    })
    .toSorted(
      (a, b) => b.acceptedAt - a.acceptedAt || b.offer.epu - a.offer.epu || byId(a.offer, b.offer),
    );
  const lead = leads[0];
  if (lead !== undefined) return done("redirect", lead.offer.id, "lead_return");

  // Step 3: at entry a user with no Lead at all sees the quiz again (Q-1). Leads that exist
  // only for inactive or removed offers do not count, so selection goes on (rule 3).
  if (moment === "entry" && facts.leads.length === 0) return done("quiz", null, "quiz_needed");

  // Step 4: without both answers the quiz is needed.
  const { gender, ethnicity } = facts.answers;
  if (typeof gender !== "string" || typeof ethnicity !== "string")
    return done("quiz", null, "quiz_needed");

  // Step 5: highest EPU among active specialised matches, ties to the lowest id.
  const best = active
    .filter(
      (o) => o.kind === "specialised" && o.ethnicity === ethnicity && o.genders.includes(gender),
    )
    .toSorted((a, b) => b.epu - a.epu || byId(a, b))[0];
  if (best !== undefined) return done("redirect", best.id, "best_epu");

  // Step 6: the universal offer, if active (the lowest id if Q-7 ever allows several).
  const universal = active.filter((o) => o.kind === "universal").toSorted(byId)[0];
  if (universal !== undefined) return done("redirect", universal.id, "fallback_universal");

  // Step 7.
  return done("no_offer", null, "no_offer");
}
