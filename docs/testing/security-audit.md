# Security audit, 2026-11-06

The audit ran the `security-audit` skill (`.claude/skills/security-audit`, pinned in `skills-lock.json`) over commit `d9f44d3`, before stage 10. It was a `quick` profile and read source only: by Arthur's decision no code ran and nothing was sent to the deployed Worker. Four agents mapped the system, five hunted, one checked coverage and eight verified. One verifier was replaced because its answer broke the result schema.

## Result

No finding was confirmed, because confirming one needs a local run, and the audit did not run code. Seven leads survived independent verification as "needs validation":

| Lead | What happened to it |
|---|---|
| `/__test/reset` and `/__test/seed` are open on the deployed demo | Kept for the demo, recorded as R-25 |
| `/api/events` read a body without a true `Content-Length` in full before its size check, and `/api/complete` had no size check | Fixed: both routes read through the streamed cap `readLimited()` in `src/routes/body.ts` (NFR-2) |
| Unauthenticated writes to the facts database have no limit | Not in the MVP, recorded under R-14 |
| The loader drains at most 7,200 rows a minute, so a flood delays every client's events | Not in the MVP, recorded under R-14 |
| The open report scans every row of its window on each request | Not in the MVP, recorded under R-14 |
| A cross-site POST to the two browser endpoints replaces the visitor's `uid` cookie | Fixed: `sameOrigin()` in `src/routes/same-origin.ts` (R-26) |
| A browser event can take the EventID of a later postback event | Fixed: the browser envelope accepts only a lowercase UUID v4 (R-27, ID-1) |

The postback signature check and the partner and click binding held. So did the bound SQL parameters and the HTML escaping, and the email stayed out of events and logs.

## Not covered

The coverage check named four areas that the `quick` profile records and does not hunt:

- the alert cron, the Analytics Engine SQL call and the R2 control objects;
- the operator scripts other than `seed.ts` and `offer.ts`;
- the business rules of click issuance, such as repeated `/go` and completing the quiz again after a click;
- data retention: no D1 retention job, R2 lifecycle rules set outside the repository, the test reset as the only delete path.

## Hardening notes

These are not findings. They are listed so that a later change can pick them up.

- The CI actions are pinned to `@v4` tags, not to commit SHAs.
- No route sets a CSP or `frame-ancestors` header, so the quiz page can be framed.
- `quarantine.body` keeps the raw signed body, fields outside the contract included, with no retention.
- On a duplicate postback the event is built from the click in the new body, while the stored conversion keeps the first click.
- `PARTNER_SECRET_*` is only checked for being non-empty; `MASTER_KEY` must be 32 bytes.
- Payloads with `schema_version` other than 1 are not checked per type, and the funnel query does not filter on `schema_version`.
- Nothing reads `events-dlq`, and the loader never deletes a batch manifest it cannot parse.
