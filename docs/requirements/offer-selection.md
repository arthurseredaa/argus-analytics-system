# Offer selection: rules, edge cases, expected results

The rules from the spec, restated so each one can be tested, plus the cases the spec does not cover. The decision table at the end is the source for unit tests and for the demo's expected results.

## Catalog (from the spec)

| ID | Name | Partner ethnicity | Partner gender | EPU, USD | URL | Kind |
|---|---|---|---|---|---|---|
| 001 | Asia Women | asia | women | 0.80 | https://asia-women.example | specialised |
| 002 | Asia Men | asia | men | 0.65 | https://asia-men.example | specialised |
| 003 | Asia Connect | asia | women, men | 0.95 | https://asia-connect.example | specialised |
| 004 | Europe Women | europe | women | 1.10 | https://europe-women.example | specialised |
| 005 | Europe Connect | europe | women, men | 0.70 | https://europe-connect.example | specialised |
| 006 | Latin Men | latam | men | 0.60 | https://latin-men.example | specialised |
| 007 | Global Connect | any | women, men | 0.50 | https://global-connect.example | universal |

All offers start active. "Partner gender" is who the user is looking for, not the user's own gender. The spec never defines "specialised"; we take it to mean every offer except the universal one, and we assume there is exactly one universal offer (Q-7).

## Terms

- Current answers: the latest accepted answer to step 1 (partner gender) and step 2 (partner ethnicity) for the user. The email does not take part in selection.
- Sufficient answers: both step 1 and step 2 have a current answer.
- Match: the offer's ethnicity equals the answer to step 2 and its gender list contains the answer to step 1.
- Lead: a partner postback of type Lead that passed authentication and was correlated to this user. A quiz email is never a Lead.

## Algorithm

Selection runs on the server at two moments: when a user enters the prelander (entry) and when the quiz is completed (completion).

1. Take the user's Leads whose offer is currently active. If there is one, redirect to that offer and skip the quiz. Reason code `lead_return`. EPU is ignored. With several, see "Several Leads" below.
2. Otherwise, if the answers are not sufficient, show the quiz.
3. At entry, a user with no Lead at all sees the quiz again (Q-1). A user whose only Leads are for disabled offers goes straight to step 4 (rule 3 of the spec).
4. Among active specialised offers that match, pick the highest EPU; on equal EPU pick the lowest ID. Reason code `best_epu`.
5. If nothing matched and 007 is active, pick 007 regardless of the answers. Reason code `fallback_universal`.
6. Otherwise show "No offer available". Reason code `no_offer`.

The universal offer never takes part in step 4, even if its EPU is higher than every specialised match.

"Missing configuration" from the spec covers: no offer exists for the combination (women + latam), the offer was removed from the catalog, or an offer row is incomplete (for example no ethnicity). Incomplete rows are excluded from matching and reported as a configuration error. They are not treated as wildcards.

## Several Leads (the spec asks us to propose this)

Options, to be settled in an ADR:

1. Most recent Lead wins (by the time we accepted the postback). Follows the user's latest registration. Default proposal.
2. Highest EPU among Lead offers. Maximises expected revenue but can send the user back to an older registration.
3. First Lead wins. Stable, but ignores newer registrations.

Disabled-offer Leads are filtered out before any of these apply.

## Cases the spec leaves open

| Case | Proposed behaviour | Question |
|---|---|---|
| Returning user, no Lead, sufficient answers | Show the quiz again, prefilled | Q-1 |
| Lead offer no longer matches the current answers | Rule 1 still applies: redirect to the Lead offer | none, spec is explicit |
| Purchase without an earlier Lead | Counts as a Purchase; does not give a redirect right | Q-8 |
| Lead for the universal offer 007 | Same as any Lead: redirect to 007 while it is active | none |
| User changes an answer (back button, second tab) | Latest accepted answer wins | Q-4 |
| Unknown answer value (for example `africa`) | Rejected by validation, not stored | none |
| Offer disabled between selection and redirect | The redirect endpoint re-checks the offer status and runs selection again if it is no longer active. Rules 1 and 2 only allow active offers. | Q-9 |
| Lead for an offer removed from the catalog | Treated like a Lead for a disabled offer (rule 3) | none |

## Decision table (expected results)

All offers active unless the "Catalog change" column says otherwise. "Lead" lists the offers the user has a Lead for.

| # | Answers | Lead | Catalog change | Expected | Reason | Source |
|---|---|---|---|---|---|---|
| 1 | women + asia | none | none | 003 | best_epu | spec example |
| 2 | men + asia | none | none | 003 | best_epu | derived |
| 3 | women + europe | none | none | 004 | best_epu | spec example |
| 4 | men + europe | none | none | 005 | best_epu | derived |
| 5 | women + latam | none | none | 007 | fallback_universal | spec example |
| 6 | men + latam | none | none | 006 | best_epu | spec example |
| 7 | men + latam | none | 006 disabled | 007 | fallback_universal | spec example |
| 8 | men + latam | none | 006 removed | 007 | fallback_universal | spec example |
| 9 | women + latam | none | 007 disabled | No offer available | no_offer | spec rule 2 |
| 10 | women + asia | none | 007 disabled | 003 | best_epu | derived |
| 11 | women + asia | none | 003 disabled | 001 | best_epu | derived |
| 12 | men + asia | none | 003 disabled | 002 | best_epu | derived |
| 13 | men + europe | none | 005 disabled | 007 | fallback_universal | derived |
| 14 | women + asia | none | 001 EPU set to 0.95 | 001 | best_epu, tie on EPU | spec rule 2 |
| 15 | women + asia | none | 007 EPU set to 5.00 | 003 | best_epu, 007 excluded | spec rule 2 |
| 16 | women + asia | 001 | none | 001, quiz skipped | lead_return | spec example |
| 17 | none | 001 | none | 001, quiz skipped | lead_return | spec rule 1 |
| 18 | women + asia | 001 | 001 disabled | 003, quiz skipped | best_epu | spec rule 3 |
| 19 | women only | 001 | 001 disabled | quiz | insufficient answers | spec rule 3 |
| 20 | women + latam | 001 | 001 disabled | 007, quiz skipped | fallback_universal | spec rules 2 and 3 |
| 21 | women + latam | 001 | 001 and 007 disabled | No offer available | no_offer | spec rules 2 and 3 |
| 22 | women + asia | 001 then 004 | none | 004 (option 1) | lead_return | proposal |
| 23 | women + asia | 001 then 004 | 004 disabled | 001 | lead_return | spec rules 1 and 3 |
| 24 | none | none | none | quiz | new user | spec |
| 25 | women + asia, at entry | none | none | quiz, prefilled | returning without Lead | Q-1 |
| 26 | women + asia, email `a@example.com` | none | none | 003, no Lead created | best_epu | spec QZ-3 |
| 27 | men + europe | 001 | none | 001, quiz skipped | lead_return, answers ignored | spec rule 1 |
| 28 | women + asia | 001 | 001 removed | 003, quiz skipped | best_epu | spec rule 3 |
| 29 | women + europe | none | 004 disabled | 005 | best_epu | derived |

Rows 1, 3, 5, 6, 7, 8 and 16 are the spec's own worked examples (OFF-12). The UI text for `no_offer` is «Немає доступного офера», exactly as in the spec; tests assert the reason code, not the text.
