# 0004. Offer selection: quiz again without a Lead, most recent Lead wins, one pure selection function

- Status: accepted (2026-11-04, Part 2 stage 1)
- Date: 2026-11-02
- Relates to: OFF-3 to OFF-12, DES-5, Q-1, Q-10, Q-20, Q-21, A-6, R-9, P-3, P-9

## Context

The spec gives three selection rules and leaves two points to us.

- Rule 3 says a Lead for a disabled offer gives no redirect right: "apply normal selection; if the answers are not sufficient, show the quiz". It does not say what happens to a returning user who has no Lead at all but already answered steps 1 and 2 (Q-1). Read one way, sufficient answers skip the quiz only for a user registered with a partner; read the other way, they skip it for everyone.
- The base scenario has one Lead per user, and the spec asks us to propose what happens with several Leads for active offers (OFF-4, Q-10). A user gets two by registering with two partners, for example when the first offer was disabled, rule 3 sent them to a second offer, and the first offer was enabled again.

The same ADR fixes when selection runs and the shape of the selection code, so that a rule change, such as the offer exclusion after Purchase (DES-5), touches one place.

## Constraints

- Rule 1 has to act before the prelander renders (Q-21, A-6), so selection must run on the server at entry, with the facts from ADR 0003.
- The spec's worked examples are fixed (OFF-12): decision table rows 1, 3, 5, 6, 7, 8 and 16 in `offer-selection.md`.
- Offer status can change between selection and redirect (R-9).
- A Lead is a partner postback of type Lead that passed authentication and was matched to the user through its click. An email entered in the quiz is never a Lead.

## Options considered

Returning user without a Lead, with sufficient answers (Q-1):

1. Show the quiz again, empty. The business context frames skipping the prelander as something for users "already registered with a partner"; a user without a Lead did not convert last time, and the prelander gets another chance. Where it breaks: the user answers the same two questions again, one or two clicks of friction, and the reading may not be the one the company meant.
2. Show the quiz again, prefilled with the stored answers. Same reading, less friction. Where it breaks: a user who sees choices already made in a new visit can be confused about what they are confirming. This is a product choice more than an architecture one.
3. Redirect straight away for everyone with sufficient answers. One rule for all users, fewer steps. Where it breaks: the prelander is never shown again to people who did not convert, and the visit drops out of "started the quiz", so the funnel loses the returning cohort.

Several Leads for active offers (Q-10), after Leads for disabled offers are removed:

1. The most recent Lead, by the time we accepted its postback. Follows the user's latest registration, which is the most likely service they use now. Where it breaks: a partner that delivers postbacks late can make an older registration look newer.
2. The Lead offer with the highest EPU. Maximises expected revenue. Where it breaks: it can send the user to an account they left for another service.
3. The first Lead. Stable over time. Where it breaks: it ignores every later registration.

When selection runs:

1. At entry, at quiz completion and again on every press at the redirect. Entry is the only moment rule 1 can skip the quiz; completion is the first moment a new user has answers; selection at the redirect covers R-9. Where it breaks: three call sites read the same facts from D1, so a slow or overloaded D1 delays the entry page, the offer choice and the redirect alike, and the p95 alert from ADR 0003 has to cover all three.
2. Only at completion. Breaks rule 1: a user with a Lead would see the quiz.
3. Only at entry. Breaks every new user, who has no answers at entry.

## Decision

- Q-1: option 1. A returning user without a Lead sees the prelander and an empty quiz. A user whose Leads are all for disabled or removed offers is handled by rule 3: normal selection, with the quiz skipped when the answers are sufficient. Whether the quiz should be prefilled goes to the company as part of Q-1; prefilling changes only the page, because the stored answers are in D1 either way.
- Q-10: option 1. Among Leads for active offers, the one whose postback we accepted last wins. We use our own acceptance time, which every postback has, instead of the partner's registration time, which may be missing or set by a clock we do not control. Two Leads accepted at the same millisecond go to the higher EPU in the current catalog version, the same tie-break as rule 2 uses for revenue, and to the lower offer ID if the EPU is equal too, so the result is always determined. Arthur chose EPU over offer ID here: the case is rare, but when it happens it earns more.
- Selection runs at entry, at completion and at the redirect endpoint (`GET /go?prelander=&visit=`). The redirect takes no offer ID: it runs selection again for the cookie's user on every press, so nothing in the URL chooses the offer, and an offer turned off since the page was shown is never sent to (ADR 0003). The redirect records its result in `offer_click`, not in a second `offer_selected`.

### Shape of the selection code

Selection is one pure function with no I/O:

```
select(facts, catalog, moment) -> { action, offerId, reason, catalogVersion }
```

- `facts`: the user's current answers, Leads with their acceptance time and offer, and Purchases.
- `catalog`: one full catalog version (ADR 0003).
- `moment`: `entry`, `completion` or `redirect`.
- `action`: `redirect`, `quiz` or `no_offer`; `reason`: `lead_return`, `best_epu`, `fallback_universal`, `no_offer` or `quiz_needed`.

The caller reads the facts and the current catalog in one D1 batch, calls the function, and records the result and the catalog version in the `offer_selected` event (P-3), or in `offer_click` at the redirect. The steps inside the function run in a fixed order:

1. Drop offers the user may not be sent to. Empty today; the offer exclusion after Purchase (DES-5, Q-20) goes here as one filter over the candidates, and an excluded offer also stops giving a Lead redirect.
2. Rule 1: Leads for active offers, most recent first, then higher EPU, then lower offer ID. If one exists, redirect to it.
3. At entry without any Lead: show the quiz (Q-1). With Leads for inactive offers only, go on (rule 3).
4. Not sufficient answers: show the quiz.
5. Rule 2: the highest EPU among active specialised matches, ties to the lowest ID.
6. No match: 007 if active.
7. Otherwise `no_offer`.

A change to the rules is a change to this function and its decision table tests, and nothing else.

## Consequences

- Easier: every rule is testable without a database, and the decision table in `offer-selection.md` becomes the unit test fixture directly (P-9).
- Easier: any past redirect is explained by the facts, the catalog version and the reason code in its `offer_selected` event.
- Easier: DES-5 is one filter in step 1 plus its rows in the decision table.
- Harder: if the company reads rule 3 the other way (option 3 for Q-1), step 3 changes and the funnel definition of "started the quiz" changes with it.
- Watch: how often users have more than one active Lead, and how often a late postback reorders Leads. If late postbacks are common for a partner, the partner's registration time may be the better clock for that partner.

## Verification

- Every row of the decision table in `offer-selection.md` is a unit test of `select` (P-9, TEST-1, TEST-2). The OFF-12 rows 1, 3, 5, 6, 7, 8 and 16 were re-read against the spec on 2026-11-02 and match it.
- `Q-1 returning user without a lead sees an empty quiz` (row 25) and `OFF-9 lead for a disabled offer skips the quiz when answers are sufficient` (row 18).
- `Q-10 most recent active lead wins` (row 22), `Q-10 most recent lead for a disabled offer is skipped` (row 23) and `Q-10 leads accepted at the same time go to the higher EPU`.
- `select is pure`: the same inputs give the same output, and the function module imports no database or network code.
- `R-9 offer disabled after selection is not used at redirect`.
- `OFF-3 lead return answers 302 before the prelander renders`: the entry request with a Lead returns a redirect and no HTML.

## References

- `docs/requirements/offer-selection.md`: algorithm, open cases and decision table.
- `docs/requirements/requirements.md`: OFF-1 to OFF-12, DES-5.
- `docs/requirements/open-questions.md`: Q-1, Q-10, Q-20, Q-21.
- ADR 0002 (identity at entry) and ADR 0003 (facts, catalog versions, status checks).

## Outcome

2026-11-04, Part 2 stage 1. Selection is one pure function, `select()` in `src/domain/select.ts`, called at entry, at completion and at the press on the offer button. `tests/unit/select.test.ts` maps every row of the decision table in `docs/requirements/offer-selection.md` to a case (`TEST-1 every decision table row is mapped to a card`). It also checks the tie-break between two Leads (`OFF-4 Q-10 leads accepted at the same time go to the higher EPU`, `OFF-4 Q-10 equal time and equal EPU go to the lower offer id`) and purity (`OFF-12 select is pure`). All 44 cases pass.
