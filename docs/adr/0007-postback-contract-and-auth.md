# 0007. Accept postbacks only as POST requests signed with HMAC over a timestamp and the body

- Status: proposed
- Date: 2026-11-02
- Relates to: PB-1 to PB-8, Q-6, Q-8, Q-11, Q-19, Q-23, Q-24, R-4, R-5, R-6, R-11, R-12, R-13, P-2, P-4

## Context

Partners report a registration (Lead) or a purchase (Purchase) by calling our endpoint from their server (PB-1). The spec asks us to propose the contract, an authenticity check, the correlation with the click, user and offer, and protection against double counting, where a redelivered message and a second real purchase are different cases (PB-2 to PB-5). Malformed and unauthorised postbacks must not change data (PB-8).

The endpoint is open to the internet. A forged Lead would add revenue that does not exist and give a real user a redirect to an offer they never registered with (R-11). The spec says nothing about the HTTP method or the signing scheme; what partners can actually send is Q-6.

A postback finds its click by the click ID we passed to the partner in the redirect URL (P-2). Clicks are written to D1 before the redirect (ADR 0003), so a postback for a real click always finds it (R-6).

## Constraints

- Partner secrets cannot be hashed, because we need the secret itself to compute the HMAC; they have to be stored so that we can read them.
- A new partner should be a data change, with no deploy (the plan's evolution rule).
- Partners retry when they do not get a `2xx` answer, so the status code tells them whether to retry.
- Lead and Purchase are facts the rules read within seconds (A-4), so they are written to D1 synchronously; their analytics events go through the Queue (ADR 0005).
- No email or identity credential in URLs or logs (R-12, ADR 0002).

## Options considered

1. HMAC-SHA256 over a timestamp and the raw body, with a per-partner secret. The partner sends `X-Signature: t=<unix seconds>,v1=<hex HMAC of "t.body">`. Proves the sender knows the secret and that the body was not changed; the secret never travels; the timestamp limits replay. Where it breaks: partners have to compute the signature, which some tracking platforms cannot do (Q-6); clocks that drift more than the allowed window cause rejections.
2. A per-partner token in a header (`Authorization: Bearer <token>`). Simple for partners. Where it breaks: the secret travels with every request, the body is not protected, and a captured request can be replayed until the token is rotated.
3. IP allowlist only. Nothing to compute. Where it breaks: partner IPs change and are often shared cloud addresses, and it says nothing about whether the body is genuine. Useful only as an extra layer.
4. GET with a token in the URL, for tracking platforms that can only fire a URL template. Where it breaks: the token ends up in proxy and server logs (R-13), the parameters are not protected, and there is no replay protection beyond deduplication. The spec does not ask for it, so it is not offered.

## Decision

Option 1, and only option 1. GET postbacks and unsigned modes are not part of the contract. If a real partner can only send GET, that is a new decision with its own ADR.

### Request

```
POST /postback/v1/{partner_id}
Content-Type: application/json
X-Signature: t=1762092000,v1=<hex HMAC-SHA256 of "1762092000.<raw body>">

{"type": "lead", "click_id": "c_8f3a", "transaction_id": "T-123", "occurred_at": "2026-11-02T14:00:00Z"}
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | `lead` or `purchase` |
| `click_id` | yes | the click ID we sent in the redirect (P-2) |
| `transaction_id` | yes | the partner's ID for this registration or purchase |
| `occurred_at` | yes | when it happened at the partner, ISO 8601 in UTC |
| `payout`, `currency` | no | amount paid to us, as a decimal string, and an ISO 4217 code; used later for EPU from real data |
| `partner_user_id` | no | the partner's user ID, kept for Q-19 |

- The version is in the path. A partner on `/v1/` keeps working when `/v2/` appears.
- The signature is checked over the raw bytes of the body, before parsing, and compared in constant time. `v1` names the signing scheme, so a new scheme can be added beside it.
- A timestamp more than 5 minutes from our clock is rejected. Within the window, a replay is caught by deduplication.
- The body is limited to 16 KB.

### Partners and secrets

- Table `partners` in the facts database: `partner_id`, name, the offer IDs the partner owns, `secret_current`, `secret_previous`, `active`. Adding a partner is one row.
- Secrets are encrypted with AES-GCM under a master key kept in a Worker secret. A copy of the database (an export, a Time Travel restore) holds only ciphertext. Changing the master key means re-encrypting the rows, one script.
- Rotation: the new secret goes into `secret_current` and the old one moves to `secret_previous`; a signature made with either is accepted until the partner confirms the switch and `secret_previous` is cleared.

### Processing and answers

In order: check the partner, the signature and the timestamp; parse and validate the fields; find the click; write the postback; send the event.

| What arrives | Answer | Data |
|---|---|---|
| Valid, new | `202` | postback row in D1, event to the Queue |
| Same partner, type and `transaction_id` again | `200`, body says `duplicate` | nothing changes |
| Unknown partner, missing or wrong signature | `401` | nothing |
| Timestamp outside the 5-minute window | `401` | nothing |
| Missing or invalid field, body over 16 KB | `400` | nothing |
| Click belongs to an offer of another partner (Q-24) | `400` | nothing |
| Unknown `click_id` | `202` | row in `postback_quarantine` with the reason, not counted, alert (Q-11) |
| A partner secret or `MASTER_KEY` cannot be used (operator error) | `500` `config_error` | nothing |
| D1 unavailable | `503` | nothing; the partner retries |

- The deduplication key is `(partner_id, type, transaction_id)`, a unique index in D1 (P-4, R-4). A redelivery has the same `transaction_id`; a second real purchase has a new one, so it is counted (PB-5).
- A second Lead for the same user and offer with a new `transaction_id` is stored but counted once: one Lead per user per offer (Q-23).
- A Purchase without an earlier Lead is counted and flagged, and gives no redirect right (Q-8). A Lead for a disabled offer is counted and gives no redirect right (Q-24, rule 3).
- The postback's analytics event gets a deterministic EventID derived from `(partner_id, type, transaction_id)`. If the event cannot be queued or written to R2, the endpoint answers `503`; the partner retries, the D1 write is a no-op on the unique key, and the event is sent again with the same EventID, so analytics gets it once.
- An unknown click ID means a click deleted by the 90-day cleanup (ADR 0003), a partner integration error, or a forgery. The quarantine keeps the postback for review; it is never matched to a user by anything other than the click ID.
- Request logs do not record bodies or signatures.

### MVP

The MVP has the endpoint and a script that signs test requests with a test partner's secret, so reviewers can send a Lead and a Purchase and repeat one (PB-7, DEMO-3 to DEMO-6). No real partner and no simulator server.

## Consequences

- Easier: the contract has one mode, one set of tests, and nothing secret in URLs.
- Easier: a new partner or a rotated secret is a data change.
- Harder: a partner whose platform cannot sign requests cannot integrate until a new ADR decides how; Q-6 asks this up front.
- Harder: the master key is one more secret to keep and rotate.
- Watch: `401` rate per partner (a spike means a wrong secret or an attack), rows in quarantine (alert on any), duplicates per partner (a high rate means their retries are aggressive), timestamp rejections (clock drift at a partner).

## Verification

- `PB-3 unsigned postback is rejected and changes nothing` and `PB-3 postback with a wrong signature is rejected`.
- `R-11 stale timestamp is rejected`: a correctly signed request with `t` 6 minutes old gets `401`.
- `PB-8 malformed postback changes nothing`: state before and after compared.
- `R-4 same postback twice counts once` and `PB-5 two purchases with different transaction ids count twice`.
- `Q-11 unknown click id goes to quarantine with 202`.
- `Q-24 click of another partner's offer is rejected with 400`.
- `Q-23 second lead for the same user and offer is stored and counted once`.
- `postback event retried after a queue failure reaches analytics once`.
- `rotation: signatures with the current and the previous secret are both accepted`.
- `partner secrets are stored encrypted`: the `partners` table holds no plaintext secret.
- The R-12 log check also searches captured logs for signatures and request bodies.

## References

- `docs/requirements/requirements.md`: PB-1 to PB-8.
- `docs/requirements/open-questions.md`: Q-6, Q-8, Q-11, Q-19, Q-23, Q-24.
- `docs/requirements/risks.md`: R-4 to R-6, R-11 to R-13.
- `docs/requirements/proposals.md`: P-2, P-4.
- ADR 0002 (no credentials in URLs), ADR 0003 (clicks before redirect, cleanup), ADR 0005 (event path).

## Outcome

2026-11-05, Part 2 stage 3. `POST /postback/v1/{partner}` is built in `src/routes/postback.ts` as decided, with the signature check in `src/domain/signature.ts` and the writes in `src/db/conversions.ts`. Two details were added while building it: `X-Signature` may carry at most 8 `v1` values, so an unauthenticated request cannot make the Worker run unlimited HMAC checks; and a partner secret that cannot be decrypted answers `500` with `config_error`, since that is our configuration and not the partner's request. The event of an accepted or duplicate postback carries `payout` as the partner's decimal string and `occurred_at` in milliseconds; `conversions.payout` stays a number.

The checks above run under these test names:

| Verification item | Test |
|---|---|
| unsigned and wrong signature | `PB-3 R-11 no signature gives 401`, `PB-3 R-11 wrong signature gives 401` |
| stale timestamp | `PB-3 R-11 stale timestamp gives 401` |
| malformed postback changes nothing | `PB-8 malformed postback changes nothing: <case>`, one per case |
| same postback twice, two purchases | `PB-5 R-4 same postback twice counts once`, `PB-5 two purchases with different transaction ids count twice`, `TEST-3 R-4 a redelivered Lead and a second real Purchase` |
| unknown click | `PB-4 Q-11 unknown click is quarantined with 202` |
| another partner's click | `PB-4 Q-24 offer mismatch is rejected` |
| second Lead for the same user and offer | `PB-5 Q-23 second lead for the same user and offer is stored`; counting it once is the report's job, stage 4 |
| event after a Queue failure | `PB-5 the postback event retried after a queue failure reaches analytics once` |
| rotation | `PB-3 rotation: signatures with the current and the previous secret are both accepted` |
| secrets stored encrypted | `PB-3 partner secrets are stored encrypted` |
| logs | `R-12 postback logs carry no body, signature or transaction id` |

All of them pass in `pnpm check` (333 tests). The demo run against the deployed Worker is recorded in the stage 3 notes of `docs/state/progress.json`.

