# Acceptance checks

Concrete checks for every functional and non-functional requirement in [requirements.md](../requirements/requirements.md). Each requirement has one card with the automated tests that must exist, manual steps against a running Worker, and the expected result. Run a requirement's card as soon as it is implemented, before the stage that contains it is marked done.

The design is not finished. Endpoints, payloads and storage below are provisional: they follow the defaults in [open-questions.md](../requirements/open-questions.md) and [proposals.md](../requirements/proposals.md), and each one names the ADR that will fix it. When that ADR is accepted, update the conventions table first and then the cards that use it. The expected behaviour in a card changes only when a requirement or a question's answer changes.

## How to use this file

1. Implement the requirement. Its tests carry the requirement ID at the start of the name.
2. Run the card: the automated command, then the manual steps.
3. Run the regression gate below.
4. Paste the output of both into the verification step of the current stage plan. This file holds the checks, not their results.

If a card cannot pass because the design changed, fix the card in the same commit as the design change and say why in the commit message.

## Regression gate

Run after every card. `pnpm check` must pass (typecheck, lint, format check, docs lint, state check and tests). So must `pnpm test:browser` against a local `wrangler dev`, which ends with the email scan over the wrangler log and the local state.

```sh
pnpm check
pnpm test:browser
```

## Conventions

### Environment

Every card runs after `source scripts/acceptance.sh`. For the deployed Worker, export `BASE` first; the script keeps a value that is already set.

```sh
source scripts/acceptance.sh               # against wrangler dev
# or, against Cloudflare:
export BASE=https://<worker>.workers.dev
source scripts/acceptance.sh
# BASE  http://localhost:8787 (`wrangler dev`) unless set
# TMP   a new mktemp -d unless set, for snapshots and logs
# JAR   $TMP/user1.jar unless set, one cookie jar per synthetic user
# state <jar>                                   the caller's user and the global counts from /__test/state
# snap <file>                                   writes state for $JAR and the report into <file>
# answer <jar> <key> <value> [seq]              one step_answered event, prints the HTTP status
# complete <jar> <gender> <ethnicity> <email>   POST /api/complete, the only call that writes answers and email to D1
# viewstep <jar> <step> [seq]                   one step_viewed event, prints the HTTP status
# report [query]                                GET /api/report as sorted JSON without as_of and events_newest_at, so two snapshots can be compared with diff
# health                                        GET /__test/health as sorted JSON: pending files, last load time, freshness, loader_paused
# wait_report <jq filter> <expected> [seconds]  polls /api/report every 3 seconds (default 150) until the filter prints the expected value; returns 1 and prints the last value on timeout
# wait_health <jq filter> <expected> [seconds]  the same on /__test/health, for example: wait_health .pending_files 0
```

The report counts events. An event reaches D1 up to 30 seconds after it is sent (the Queue batch) plus the next minute's loader run, so a check that reads the report right after a visit uses `wait_report`, which waits up to 150 seconds. `wrangler dev` runs no cron: `pnpm test:e2e` and `pnpm test:browser` start it with `--test-scheduled` and call the loader every 10 seconds. With a dev server you started yourself, call `curl -s "$BASE/__scheduled?cron=*+*+*+*+*"` instead of waiting.

Tools: `curl`, `jq`, `wrangler`, and k6 for load. Never pass `-L` to curl in these checks: following a redirect would open a partner site (DEMO-9).

### Endpoints (provisional)

| Purpose | Request | Fixed by |
|---|---|---|
| Prelander entry | `GET /p/{prelanderId}`. Sets the identity cookie, renders the quiz, or answers 302 for a lead return. Writes nothing to D1 for a new user. A lead return creates a new click row. | ADR 0002, ADR 0004 |
| Event ingestion | `POST /api/events` with one event per request: `{"event_id","schema_version","type","client_time","visit_id","seq","prelander_id","payload"}`. The Worker adds `user_id` (from the cookie) and `received_at`. Answers 202; when the Queue refuses the send, the event is written to R2 `pending/` and the answer is still 202, and only when R2 refuses too does it answer `503` with `Retry-After: 30`. A body over 4 KB (4,096 bytes) gets `413`. An unknown envelope field or a server-only type such as `lead` gets `400`; `user_id` and `received_at` in the body are dropped, not rejected. Any key whose name contains `email` is removed from the payload before the Queue. Analytics only: a step event never writes D1. The envelope has no field for an email. | ADR 0005, `docs/design/data-model.md` |
| Quiz completion and offer selection | `POST /api/complete` with `{"prelander_id":"demo","answers":{"gender":"women","ethnicity":"asia"},"email":"u1@example.com"}`, sent once after the email step. Creates the `users` row and writes the answers and the encrypted email to D1. Answers `{"offer_id","name","url","reason","catalog_version"}`. Replaces `POST /api/select`. The latest accepted answer is the completion request the server received last. A user who stops before the email step has no rows in D1. | ADR 0004, `docs/design/data-model.md` |
| Transition | `GET /go?prelander=&visit=`. Takes no offer ID: runs selection again for the cookie's user, stores the click, answers 302 with the click id in the `Location` query. Without answers or Leads it answers 302 to `/p/{prelander}` and stores nothing (Q-30). | ADR 0004, ADR 0007 |
| Postback | `POST /postback/v1/{partner}` with JSON `{"click_id","type","transaction_id","occurred_at","payout?","currency?","partner_user_id?"}` and the header `X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 over "t.body">`, per ADR 0007. The body is limited to 16 KB (16,384 bytes); unknown fields are dropped. Answers: `202 {"status":"accepted"}` for a new conversion, `200 {"status":"duplicate"}` for a redelivery, `202 {"status":"quarantined"}` for an unknown click. `401 {"error":"unauthorized"}` for an unknown or inactive partner and for a missing, wrong or stale signature. `400` for a body over the limit (`too_large`), another content type, an invalid field, or a click on another partner's offer (`click_partner_mismatch`). `500 {"error":"config_error"}` when a partner secret or `MASTER_KEY` cannot be used (an operator error; nothing is written). `503` with `Retry-After: 30` when D1 fails, or when the Queue and R2 both fail (a refused Queue send alone is written to R2 and answers as usual). Sets no cookie. | ADR 0007 |
| Report | `GET /api/report?from=&to=&prelander=&offer=&view=cohort\|postback`, and the `/report` page. `from` and `to` are UTC dates `YYYY-MM-DD`, `to` inclusive; `to` defaults to today and `from` to `to`; a span is at most 92 days. `prelander` and `offer` are ids of up to 64 letters, digits, `_` and `-`; empty means no filter. `view` defaults to `cohort`. Unknown parameters are ignored. Anything invalid gives `400 {"error":"invalid_query"}`. Open, sets no cookie, answers `cache-control: no-store`. Cohort keys: `view`, `from`, `to`, `prelander`, `offer`, `as_of`, `events_newest_at`, `visits`, `visitors`, `started`, `step_1`, `step_2`, `step_3`, `completed`, `dropoff_step_1`, `dropoff_step_2`, `dropoff_step_3`, `went_to_offer`, `transitions`, `lead`, `purchase`, `rates`, `rows` (each cohort row has `day`, `prelander_id`, the same counts and `rates`, and `offers`). Postback keys: `view`, `from`, `to`, `prelander`, `offer`, `as_of`, `events_newest_at`, `lead`, `purchase`, `purchase_without_lead`, `payout`, `rows` (each postback row has `day`, `prelander_id`, `lead`, `purchase`, `purchase_without_lead`, `payout` and `offers`). With `offer` set, the funnel fields and the rates built on them are `null`. | stage 4 metrics |
| Test state | `GET /__test/state`: the caller's user (from the cookie), that user's answers, events, clicks and conversions, and global counts including the quarantine. `POST /__test/reset`. `POST /__test/seed` acts on the caller's user with `{ "answers"?: {"gender":"women"}, "leads"?: [{"offer_id","accepted_at"?}], "clicks"?: [{"offer_id","created_at"?}] }`, for cases that are slow to reach through the UI, such as a Lead on 001 or a click dated yesterday. It answers `{"ok":true,"clicks":[<Lead click ids>,<plain click ids>]}`, or `400` for an offer id outside the current catalog. Leads without `accepted_at` are ordered by array position. Seeded clicks get the reason `best_epu`, and a Lead's click uses the Lead's `accepted_at` as its `created_at`. Reset empties D1 and leaves R2 alone, so files waiting in `pending/` survive it. All three answer `404` unless `TEST_ROUTES` is `on`. The deployed demo has it on (decision 1 of the stage 1 plan); a production deploy leaves it off. | ADR 0003 |
| Offer config | `pnpm offer set-status 006 inactive`, `pnpm offer set-epu 001 0.95`. A data change, no deploy (Q-9). | ADR 0003 |
| Signed postback helper | `pnpm postback lead --click <id> --txn <id>` prints the HTTP status and body (P-10). | ADR 0007 |

### Test names and data

- Every automated test name starts with the requirement ID, then the risk or question ID if it covers one: `OFF-5 row 1 women+asia gives 003`, `PB-5 R-4 same postback twice counts once`. This extends the R-/Q- naming rule in `.claude/rules/requirements.md`, so `pnpm test -t "OFF-5"` runs one card.
- Offer selection tests read their cases from the decision table in [offer-selection.md](../requirements/offer-selection.md) (P-9). Cards cite row numbers instead of copying rows.
- Emails are synthetic: `user1@example.com`, `user2@example.com`. Partner secrets in tests are fixed test values, never real ones.
- Every manual run starts with `curl -s -X POST $BASE/__test/reset` unless the card says otherwise.

## Functional requirements

### Quiz

### QZ-1 Step 1 asks for the desired partner's gender

Depends on: ADR 0005 (event shape), ADR 0004 (completion).

Automated: `pnpm test -t "QZ-1"`. Cases: `QZ-1 accepts women`, `QZ-1 accepts men`, `QZ-1 rejects other values and stores nothing`, `QZ-1 step event alone writes nothing to D1`.

Manual:
1. Open `$BASE/p/demo` in a browser. Step 1 offers two answers, women and men, and the wording asks who the user is looking for, not the user's own gender.
2. `answer $JAR gender women`, wait up to 2 minutes for the Queue batch and the loader (`wait_health .pending_files 0` once the Queue batch has passed), then `state $JAR`.
3. `answer $JAR gender robots`, wait the same, then `state $JAR`.
4. `complete $JAR women asia user1@example.com`, then `state $JAR`.
5. With a new jar, `complete $JAR2 robots asia user2@example.com`, then `state $JAR2`.

Expected: step 2 answers 202 and the state has no user row and no answers: a step event is analytics only. Step 3 answers 400. After step 4 the state shows the gender answer `women`; answers reach D1 only at completion. Step 5 answers 400 and the state stays empty.

### QZ-2 Step 2 asks for ethnicity, worded by the step 1 answer

Depends on: QZ-1.

Automated: `pnpm test -t "QZ-2"`. Cases: `QZ-2 wording after women`, `QZ-2 wording after men`, `QZ-2 accepts asia, europe and latam`, `QZ-2 rejects africa`.

Manual:
1. In a fresh browser profile, answer women at step 1 and read the step 2 question. Repeat with men.
2. `answer $JAR ethnicity africa`, then `complete $JAR women africa user1@example.com`, then `state $JAR`.

Expected: the two step 2 questions differ in wording and offer the same three values, stored at completion as `asia`, `europe` and `latam`. The unknown value gets 400 in both calls and is not stored (offer-selection.md, "Unknown answer value").

### QZ-3 Email does not affect the offer or create a Lead

Depends on: OFF-5, PB-1.

Automated: `pnpm test -t "QZ-3"`. Cases: `QZ-3 same answers with different emails give the same offer`, `QZ-3 row 26 email creates no Lead`.

Manual:
1. Jar `user1.jar`: `complete $TMP/user1.jar women asia user1@example.com`.
2. Jar `user2.jar`: `complete $TMP/user2.jar women asia user2@example.com`.
3. `state` for both jars.

Expected: both responses return 003 with reason `best_epu`. The two users differ only in `email_hash`. Neither user has a Lead.

### QZ-4 Events link to transitions, and current answers are derived

Depends on: ADR 0005, `docs/design/data-model.md` (event catalog).

Automated: `pnpm test -t "QZ-4"`. Cases: `QZ-4 Q-4 latest completion received wins`, `QZ-4 R-10 two tabs complete in turn`, `QZ-4 answer events do not change D1`, `QZ-4 offer_selected carries reason and catalog version`, `QZ-4 click links to its selection, user and offer`.

Manual:
1. `answer $JAR gender women`, then `answer $JAR gender men`.
2. Wait up to 2 minutes for the Queue batch and the loader, then `state $JAR`: the list of answer events, and no stored answers.
3. `complete $JAR women asia user1@example.com`, then `complete $JAR men asia user1@example.com` (a second tab finishing later), `GET $BASE/go?prelander=demo`, then wait up to 2 minutes for the Queue batch and the loader and `state $JAR` again.

Expected: after step 2 both answer events are kept and D1 has no answers, because answers are stored only at completion. After step 3 the current gender answer is `men`: the completion request the server received last wins, and an earlier `client_time` or `seq` does not change that. The selection event has a reason code and a catalog version. The click row points to the same user and offer as the selection.

### QZ-5 The current step is not stored separately

Depends on: data model.

Automated: `pnpm test -t "QZ-5"`. Cases: `QZ-5 reload before completion starts from step 1`, `QZ-5 entry after completion without a Lead shows an empty quiz (Q-1)`.

Manual:
1. `grep -rni "current_step" migrations/ src/` prints nothing.
2. Answer step 1 in a browser, reload the page. Then finish the quiz and open `$BASE/p/demo` again in the same browser.

Expected: no stored step field. Nothing is in D1 before completion (answers are written by `/api/complete`), so after the first reload the page starts at step 1. After completion, with no Lead, the entry shows an empty quiz (Q-1 default; prefilling from stored answers is the recorded trade-off).

### QZ-6 One quiz

Automated: none.

Manual: list the quiz definitions in the code or config.

Expected: exactly one quiz, used by every prelander.

### QZ-7 One page with the three steps

Depends on: QZ-1 to QZ-3.

Automated: `pnpm test:ui -- -g "QZ-7"` (browser test, tool to be chosen in the MVP plan). Cases: `QZ-7 three steps on one page`, `QZ-7 step 2 wording follows step 1`.

Manual: open `$BASE/p/demo`, go through all three steps without a full page navigation, and watch the network tab.

Expected: one page load, three steps, one `POST /api/complete` request after the email step, then the chosen offer's name and URL on screen.

### Identity

### ID-1 Users have a UserID and properties; events have an EventID

Depends on: ADR 0002, ADR 0005.

Automated: `pnpm test -t "ID-1"`. Cases: `ID-1 first visit sets a user id cookie and writes no D1 row`, `ID-1 complete creates the users row`, `ID-1 every stored event has a unique event id`, `ID-1 event without event id is rejected`.

Manual:
1. `curl -s -c $JAR -o /dev/null $BASE/p/demo`, then `state $JAR`.
2. Send an event without `event_id`.
3. `complete $JAR women asia user1@example.com`, then `state $JAR`.

Expected: after step 1 the state shows the cookie's `user_id` and no users row. The event without an id gets 400. After step 3 the users row exists with a properties object.

### ID-2 The same user is recognised on a return visit

Depends on: ADR 0002.

Automated: `pnpm test -t "ID-2"`. Cases: `ID-2 second visit with the same cookie keeps the user id`, `ID-2 R-1 visit without the cookie creates a new user`, `ID-2 malformed cookie value is replaced`, `ID-2 user id in the event body is ignored`.

Manual:
1. `curl -s -c $JAR -b $JAR -D - -o /dev/null $BASE/p/demo` twice.
2. Same request with a new jar.
3. Read the `Set-Cookie` header from step 1.

Expected: steps 1 give the same cookie `user_id` in `state`, step 2 a different one (neither has a users row until completion). The cookie is `HttpOnly`, `Secure` (on the deployed Worker) and `SameSite=Lax`, and holds a random id, not an email or a counter.

### ID-3 An email alone does not confirm identity

Depends on: ID-2, PB-4, OFF-3.

Automated: `pnpm test -t "ID-3"`. Case: `ID-3 earlier user's email in a new browser gives no lead return`.

Manual:
1. User A (`a.jar`): `complete a.jar women asia user1@example.com` (003), `GET $BASE/go?prelander=demo`, then `pnpm postback lead --click <A's click id> --txn T-A1`.
2. User B (`b.jar`, a new jar): `GET /p/demo`, then `complete b.jar women europe user1@example.com`.

Expected: B gets 004 with reason `best_epu`. B's entry answers 200 with the quiz, not 302 to 003. A and B have different user ids.

### ID-4 User properties and events are stored

Depends on: ID-1, QZ-1 to QZ-3.

Automated: `pnpm test -t "ID-4"`. Case: `ID-4 quiz run stores properties and the visit events`.

Manual: run one full quiz to a transition, then `state $JAR`.

Expected: properties show both answers and an email reference (not the email itself, per P-5). The properties come from `/api/complete`; the events table holds the visit events: prelander view, `step_viewed` for each step, an answer event for steps 1 and 2, offer selected, offer click (A-1). The email step has no answer event, so the count of nine in A-1 is confirmed against the data model's catalog (NFR-1 uses the same number).

### Offer catalog and selection

### OFF-1 The synthetic catalog of 7 offers is seeded, all active

Automated: `pnpm test -t "OFF-1"`. Case: `OFF-1 seed equals the spec catalog`.

Manual: `state` shows the catalog, or `pnpm offer list`.

Expected: 7 offers, values equal to the catalog table in offer-selection.md, all active.

### OFF-2 EPU is a configured constant

Depends on: ADR 0003.

Automated: `pnpm test -t "OFF-2"`. Case: `OFF-2 EPU change takes effect without deploy`.

Manual:
1. `grep -rnE "0\.(95|80|65|70|60|50)|1\.10" src/` prints nothing outside seed data.
2. `pnpm offer set-epu 001 0.95`, then `complete` for women + asia (decision table row 14).
3. Restore with `pnpm offer set-epu 001 0.80`.

Expected: no EPU in code. Row 14 gives 001 on the EPU tie, with no deploy in between.

### OFF-3 A Lead for an active offer skips the quiz and beats EPU

Depends on: PB-4, ADR 0004.

Automated: `pnpm test -t "OFF-3"`. Cases: decision table rows 16, 17, 27.

Manual:
1. `POST /__test/seed` with a user who answered women + asia and has a Lead on 001. Put the cookie it returns into `$JAR`.
2. `curl -s -b $JAR -o /dev/null -w '%{http_code} %{redirect_url}\n' $BASE/p/demo`.

Expected: `302` with a `Location` on `https://asia-women.example`, even though 003 has a higher EPU. Reason `lead_return` in the stored selection event, and a new click row for the user.

### OFF-4 Several Leads

Depends on: ADR 0004 (Q-10).

Automated: `pnpm test -t "OFF-4"`. Cases: decision table rows 22 and 23.

Manual: Leads on 001 then 004 for one user, enter the prelander. Disable 004 and enter again.

Expected: first entry goes to 004 (most recent Lead, the current default). After disabling 004 it goes to 001. If ADR 0004 picks another rule, row 22 changes with it.

### OFF-5 Highest EPU among matching active specialised offers, ties to the lowest ID

Automated: `pnpm test -t "OFF-5"`. Cases: decision table rows 1, 2, 3, 4, 6, 10, 11, 12, 14, 29.

Manual: for each of women+asia, men+asia, women+europe, men+europe, men+latam run `complete` in a fresh jar (for example `complete $JAR women asia user1@example.com`).

Expected: 003, 003, 004, 005, 006, each with reason `best_epu`.

### OFF-6 Fallback to the universal offer

Automated: `pnpm test -t "OFF-6"`. Cases: decision table rows 5, 7, 8, 13, plus `OFF-6 incomplete offer row is excluded and reported`.

Manual:
1. `complete` with women + latam.
2. `pnpm offer set-status 006 inactive`, `complete` with men + latam. Restore 006.

Expected: both give 007 with reason `fallback_universal`. An offer row without an ethnicity never matches and produces a configuration error in the logs.

### OFF-7 The universal offer does not compete on EPU

Automated: `pnpm test -t "OFF-7"`. Case: decision table row 15.

Manual: `pnpm offer set-epu 007 5.00`, `complete` with women + asia. Restore with `0.50`.

Expected: 003 with reason `best_epu`.

### OFF-8 No offer available

Automated: `pnpm test -t "OFF-8"`. Cases: decision table rows 9 and 21. UI case: `OFF-8 page shows the no-offer text`.

Manual: `pnpm offer set-status 007 inactive`, women + latam in the browser. Restore 007.

Expected: `POST /api/complete` returns reason `no_offer` and no URL. The page shows `No offer available`. `GET $BASE/go?prelander=demo` with the same cookie answers 200 with `No offer available`, not 302.

### OFF-9 A Lead for a disabled offer gives no redirect right

Depends on: OFF-3.

Automated: `pnpm test -t "OFF-9"`. Cases: decision table rows 18, 19, 20, 21, 28.

Manual:
1. User with women + asia and a Lead on 001. `pnpm offer set-status 001 inactive`.
2. Enter the prelander with curl as in OFF-3.
3. Repeat with a user who only sent step 1 events and never called `complete`.

Expected: step 2 gives `302` to `https://asia-connect.example` with reason `best_epu` (row 18). Step 3 gives 200 with the quiz (row 19): that user has no rows in D1, so the entry treats them as new.

### OFF-10 Selection runs on the server and the demo shows name and URL

Automated: `pnpm test -t "OFF-10"`. Case: `OFF-10 complete returns name and url of the chosen offer`.

Manual:
1. `complete $JAR women asia user1@example.com | jq`.
2. In the browser, finish the quiz and read the screen. Search the page's JavaScript for EPU values or the catalog.

Expected: the response has `name` and `url` of one offer and nothing about the others. The page shows the same name and URL. The client code has no catalog and no selection logic.

### OFF-11 The redirect is checked without opening the partner site

Depends on: ADR 0004, R-9.

Automated: `pnpm test -t "OFF-11"`. Cases: `OFF-11 transition answers 302 with Location and click id`, `OFF-11 click row exists before the 302`, `OFF-11 R-9 offer disabled after selection is re-selected at /go`, `OFF-11 the URL cannot choose the offer`, `OFF-11 a double press makes two clicks`, `OFF-11 HEAD and an unknown prelander write nothing`.

Manual:
1. `complete` with women + asia, then `curl -s -b $JAR -o /dev/null -w '%{http_code} %{redirect_url}\n' "$BASE/go?prelander=demo"`.
2. `complete` again, `pnpm offer set-status 003 inactive`, repeat the curl. Restore 003.

Expected: step 1 prints `302 https://asia-connect.example/?click_id=<random id>`. Step 2 prints a 302 to `https://asia-women.example` (001, the next best match). No request leaves for a `.example` host.

### OFF-12 The spec's worked examples hold

Automated: `pnpm test -t "OFF-12"`. Cases: decision table rows 1, 3, 5, 6, 7, 8, 16.

Manual: run the seven rows by hand with the steps from OFF-5, OFF-6 and OFF-3.

Expected: 003, 004, 007, 006, 007, 007, and 001 with the quiz skipped.

### Postbacks

### PB-1 Lead and Purchase are accepted

Depends on: ADR 0007.

Automated: `pnpm test -t "PB-1"`. Cases: `PB-1 signed lead is accepted`, `PB-1 signed purchase is accepted`, `PB-1 unknown type is rejected`.

Manual: after a transition, `pnpm postback lead --click $CLICK --txn T1`, then `pnpm postback purchase --click $CLICK --txn P1`.

Expected: both answer 202. `state` shows one Lead and one Purchase for the user and offer.

### PB-2 The postback contract

Depends on: ADR 0007.

Automated: `pnpm test -t "PB-2"`. Cases: one per required field missing, `PB-2 optional payout and currency accepted`, `PB-2 unknown extra field ignored`, `PB-2 version is in the path`.

Manual: compare the contract section of the design with the request validation in the code, field by field. `curl` a valid body to `/postback/v2/test`.

Expected: every required field in the design is validated, and nothing else is required. An unknown version answers 404.

### PB-3 Authenticity check

Depends on: ADR 0007.

Automated: `pnpm test -t "PB-3"`. Cases: `PB-3 R-11 no signature gives 401`, `PB-3 R-11 wrong signature gives 401`, `PB-3 R-11 stale timestamp gives 401`, `PB-3 R-11 signature from another partner gives 401`, each asserting the state is unchanged.

Manual:
1. `snap $TMP/before.json`.
2. Send a Lead body with no `X-Signature`, then with a signature made from a wrong secret, then with a timestamp an hour old.
3. `snap $TMP/after.json && diff $TMP/before.json $TMP/after.json`.

Expected: three 401 responses and an empty diff.

### PB-4 Correlation with click, user and offer

Depends on: ADR 0007, R-6, Q-11, Q-24.

Automated: `pnpm test -t "PB-4"`. Cases: `PB-4 lead lands on the click's user and offer`, `PB-4 Q-11 unknown click is quarantined with 202`, `PB-4 R-6 quarantined postback matches once the click exists`, `PB-4 Q-24 offer mismatch is rejected`, `PB-4 Q-24 lead on a disabled offer is counted without a redirect right`.

Manual:
1. Two users with transitions to different offers. Send a Lead for user A's click.
2. Send a Lead with a random click id.

Expected: step 1 gives a Lead to A on A's offer and nothing to B. Step 2 answers 202, the postback sits in quarantine and no count changes.

### PB-5 No double counting

Depends on: ADR 0007, P-4.

Automated: `pnpm test -t "PB-5"`. Cases: `PB-5 R-4 same postback twice counts once`, `PB-5 two purchases with different transaction ids count twice`, `PB-5 Q-23 second lead for the same user and offer is stored`, `PB-5 R-5 missing transaction id is handled as the design says`. The test checks that the second Lead is stored; counting it once is the report's rule, built in stage 4.

Manual:
1. Send the same signed Purchase (`--txn P1`) twice. Read the report.
2. Send a Purchase with `--txn P2`. Read the report.

Expected: purchases are 1 after step 1 and 2 after step 2. The second identical request answers 200, not an error, so the partner stops retrying.

### PB-6 A quiz email is not a Lead

Automated: `pnpm test -t "PB-6"`. Case: decision table row 26.

Manual: complete the quiz with an email, `state $JAR`, then enter the prelander again.

Expected: no Lead and no lead return. The entry shows the quiz (Q-1 default).

### PB-7 Test requests can be sent without a partner

Automated: `pnpm test -t "PB-7"`. Case: `PB-7 helper produces a signature the endpoint accepts`.

Manual: from a fresh clone, follow the README section on test postbacks word for word.

Expected: the commands work as written and print 202. No separate simulator server runs.

### PB-8 Malformed and unauthorised postbacks change nothing

Depends on: PB-3.

Automated: `pnpm test -t "PB-8"`. Cases: invalid JSON, wrong content type, body over the size limit, unknown type, negative payout, unknown partner. Each test compares a state snapshot before and after.

Manual: `snap` before, send each malformed request with a valid signature, `snap` after, `diff`.

Expected: every request answers 400 or 401 and the diff is empty.

### Analytics and reporting

### AN-1 Funnel metrics

Depends on: `docs/design/metrics-and-operations.md`.

Automated: `pnpm test -t "AN-1"`. Case: `AN-1 fixture gives expected start, steps, drop-offs, transitions, Leads, Purchases`.

Manual: reset, run three users (funnel counts come from events, so a user who stops before the email step still counts at the steps reached): one stops after step 1, one stops after step 3, one reaches a Lead and a Purchase. `curl -s "$BASE/api/report" | jq`.

Expected: started 3, step 1 3, step 2 2, step 3 2, transitions 1, Lead 1, Purchase 1. Drop-off after step 1 is 1 and after step 3 is 1.

### AN-2 Breakdown by prelander, offer and period

Automated: `pnpm test -t "AN-2"`. Case: `AN-2 breakdowns sum to the total`.

Manual: reset, then run one user to offer 003 (women and asia) and one to offer 004 (women and europe) on `/p/demo`. The catalog has one prelander, so the per-prelander split is covered by the automated test, which writes rows with two prelander ids. Query the report with `prelander=demo`, with `offer=003`, with `offer=004`, and with a `from` and `to` that exclude today, for example `from=2001-01-01&to=2001-01-02`.

Expected: the per-offer Leads, transitions and Purchases add up to the total, and `prelander=demo` equals the total. The excluded period returns zeros.

### AN-3 Conversion denominators

Automated: `pnpm test -t "AN-3"`. Case: one test per rate in the metric definitions table, computed from the fixture by hand.

Manual: for each rate in the report, recompute it from the counts on the same page using the definition in the metrics document.

Expected: every rate equals its definition. The started metric counts step 1 shown (Q-13).

### AN-4 Repeat visits

Automated: `pnpm test -t "AN-4"`. Cases: `AN-4 Q-26 two visits by one user count one user and two visits`, `AN-4 Q-21 lead return is not counted as started`.

Manual: one jar, enter `/p/demo` twice, answer step 1 both times.

Expected: unique users who started is 1, visits is 2.

### AN-5 Late postbacks

Depends on: Q-12, P-6.

Automated: `pnpm test -t "AN-5"`. Case: `AN-5 R-7 late purchase moves the click-date cohort and lands on today in the postback view`.

Manual: seed a click dated yesterday with `POST /__test/seed`, send a Purchase for it today. Query `view=cohort` for yesterday and `view=postback` for today.

Expected: the cohort view shows the Purchase on yesterday's cohort with the current "as of" time. The postback view shows it today.

### AN-6 The MVP report

Automated: `pnpm test -t "AN-6"`. Case: `AN-6 report page renders the five counts`.

Manual: open `$BASE/report` after the AN-1 fixture.

Expected: the page shows users who started, passed each step, went to an offer, got a Lead, got a Purchase, with the AN-1 numbers.

### AN-7 The report counts recorded events

Automated: `pnpm test -t "AN-7"`. Cases: `AN-7 empty store gives zeros`, `AN-7 fixture gives expected numbers`.

Manual: reset and open the report, then run the AN-1 fixture and open it again.

Expected: all zeros, then the AN-1 numbers.

### AN-8 The report uses the design's metric definitions

Automated: `pnpm test -t "AN-8"`. Case: `AN-8 every report query names a metric id from the design`.

Manual: for each query in the report module, find the comment with its metric id and open that row in the metrics document.

Expected: every query has an id, and every id exists in the metrics document.

### Business context and MVP scope

### BIZ-2 Visitor events are collected

Depends on: ID-4.

Automated: `pnpm test -t "BIZ-2"`. Case: `BIZ-2 every event type in the catalog is accepted and stored`.

Manual: one full demo run, then list event types in `state`.

Expected: every event type in the data model's event catalog appears at least once.

### BIZ-3 Selection uses properties and history on the server

Depends on: OFF-3, OFF-10.

Automated: covered by `OFF-3` and `OFF-10` tests.

Manual: run the OFF-3 manual steps.

Expected: as in OFF-3. The lead return happens before the page renders, with no client script involved.

### MVP-1 Deployed path from answer to event, offer and report

Depends on: all cards above.

Automated: `pnpm test:e2e --base $BASE` (the demo scenario below as `scripts/demo.sh`). Without `--base` and `BASE`, `pnpm test:e2e` starts its own `wrangler dev`. A remote run needs `.dev.vars.remote` for the signed postbacks.

Manual: run the demo scenario below with `BASE` set to the deployed URL.

Expected: same results as locally.

### MVP-4 Analytics read Cloudflare storage, no BigQuery

Automated: none.

Manual: `grep -rniE "@google-cloud|googleapis|bigquery\.(googleapis|client)|GOOGLE_APPLICATION_CREDENTIALS" src/ wrangler.jsonc package.json`, and read the report module's data source.

Expected: the grep prints nothing: no BigQuery client or credential in the runtime. The word "BigQuery" still appears in two comments (`src/db/events.ts` and `wrangler.jsonc`, both "MVP stand-in for BigQuery"); a search for the bare word would list them. The report reads the Cloudflare store chosen in ADR 0003.

### Demo scenario

DEMO-2 to DEMO-6 run as one script from an empty store. Every step's expected output is listed; the README table (DEMO-7) must match it. `pnpm test:e2e` runs the same steps as `scripts/demo.sh` and asserts each answer; it waits for the report where events pass the Queue (a batch of up to 30 seconds) and the loader (one run a minute), so a local run takes about 1.5 minutes and a deployed run about 2 to 3 minutes. It first reads `loader_paused` from `/__test/health`. In a normal run it waits for `pending_files` 0 before the reset. While the loader is paused (`pnpm sink outage on`) it prints `loader paused: funnel cells are expected to stay 0` and expects `0,0,0,0,0` after DEMO-2, `0` visits after DEMO-4 and `0,0,0,0,0,0,1,2,1,1` at the end, each check named `<step> (loader paused)`; all other checks are the same.

```sh
curl -s -X POST $BASE/__test/reset
JAR=$TMP/demo.jar

# DEMO-2: new user, quiz, offer
curl -s -c $JAR -b $JAR -o /dev/null -w '%{http_code}\n' $BASE/p/demo    # 200, quiz
viewstep $JAR 1 1                                                        # 202, step 1 shown: the user has started
answer $JAR gender women 2                                               # 202, analytics only, nothing in D1
viewstep $JAR 2 3                                                        # 202
answer $JAR ethnicity asia 4                                             # 202
viewstep $JAR 3 5                                                        # 202
complete $JAR women asia user1@example.com | jq -c '{offer_id,reason}'   # {"offer_id":"003","reason":"best_epu"}; email only in this body
CLICK=$(curl -s -b $JAR -o /dev/null -w '%{redirect_url}' "$BASE/go?prelander=demo" | sed 's/.*click_id=//')
wait_report '[.visits,.started,.step_2,.step_3,.completed]|@csv' '1,1,1,1,1'

# DEMO-3: Lead for that click
pnpm -s postback lead --click $CLICK --txn DEMO-L1                       # 202
report | jq .lead                                                        # 1

# DEMO-4: return without the quiz
curl -s -b $JAR -o /dev/null -w '%{http_code} %{redirect_url}\n' $BASE/p/demo
                                                                         # 302 https://asia-connect.example/?click_id=<new id>
wait_report .visits 2

# DEMO-5: Purchase, report changes
report > $TMP/before.json
pnpm -s postback purchase --click $CLICK --txn DEMO-P1                   # 202
report > $TMP/after.json
diff $TMP/before.json $TMP/after.json                                    # purchase 0 -> 1 in three places, lead_to_purchase 0 -> 1 in one
curl -s $BASE/report | grep -o 'data-metric="purchase">[0-9]*'           # data-metric="purchase">1

# DEMO-6: same postback again
pnpm -s postback purchase --click $CLICK --txn DEMO-P1                   # 200 {"status":"duplicate"}
pnpm -s postback lead --click $CLICK --txn DEMO-L1                       # 200
report | jq -c '{lead,purchase}'                                         # {"lead":1,"purchase":1}
```

The DEMO-5 diff has exactly four hunks: `purchase` in the total, `purchase` in the day row, and `purchase` and `rates.lead_to_purchase` in offer 003 of that row. Nothing else changes. The snapshots drop `as_of` and `events_newest_at` because they change on every call. The script checks the four paths with `jq`.

### The DEMO-7 table: the report after each step

From an empty store, with the current defaults (Q-13, Q-21). The columns are the keys of the report's total.

| After | visits | started | step_1 | step_2 | step_3 | completed | went_to_offer | transitions | lead | purchase |
|---|---|---|---|---|---|---|---|---|---|---|
| reset | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| DEMO-2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 0 |
| DEMO-3 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 |
| DEMO-4 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 0 |
| DEMO-5 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 |
| DEMO-6 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 1 |

DEMO-5 also moves offer 003's `lead_to_purchase` from 0 to 1, and these are the only cells the Purchase changes. The return visit counts as a visit and a transition, not as a start or a new user on the offer (Q-21).

### DEMO-1 Reviewers can repeat the scenario from short instructions

Automated: none, a manual check.

Manual: someone who did not write the README runs it from a fresh clone against the deployed URL and against `wrangler dev`, without help.

Expected: every step produces the output the README says.

### DEMO-2 A new user gets the correct offer

Automated: `pnpm test -t "DEMO-2"`.

Manual and expected: the DEMO-2 block of the script above.

### DEMO-3 A test Lead for that user's transition

Automated: `pnpm test -t "DEMO-3"`.

Manual and expected: the DEMO-3 block. `state $JAR` then shows a Lead on 003.

### DEMO-4 The same user returns without the quiz

Automated: `pnpm test -t "DEMO-4"`.

Manual and expected: the DEMO-4 block. In a browser with the same cookie, the quiz never appears.

### DEMO-5 A Purchase changes the report

Automated: `pnpm test -t "DEMO-5"`.

Manual and expected: the DEMO-5 block, and the `/report` page shows the new Purchase after a reload.

### DEMO-6 Repeating a postback does not double the numbers

Automated: `pnpm test -t "DEMO-6"`.

Manual and expected: the DEMO-6 block. Repeat the Lead too: Lead stays 1.

### DEMO-7 Test data and expected results are included

Automated: none, a manual check.

Manual: compare the README's expected-results table with the decision table in offer-selection.md and the report numbers above.

Expected: every README row exists in the decision table with the same result.

### DEMO-8 Synthetic emails only; email never in URLs or logs

Depends on: P-5, P-11, R-12.

Automated: `pnpm test:email-scan`. Cases: `DEMO-8 R-12 email absent from captured logs`, `DEMO-8 R-12 email absent from every request URL and Location header`, `DEMO-8 R-12 email absent from Queue messages, R2 files and the events table`, `DEMO-8 email is stored encrypted`.

Manual:
1. `wrangler tail --format json > $TMP/tail.log` against staging in one terminal.
2. Run the demo script.
3. `grep -c "user1@example.com" $TMP/tail.log` and `grep -c "user1%40example.com" $TMP/tail.log`.
4. `grep -rnE "[A-Za-z0-9._%+-]+@" tests/ fixtures/ | grep -v "@example.com"`.
5. After the demo, fetch the R2 files it wrote (bucket from ADR 0006) and dump the events table (`wrangler d1 execute <db> --command "SELECT * FROM events"`). In the test run, read the messages captured from the Queue. `grep -c` each for `user1@example.com` and `user1%40example.com`.

Expected: 0 and 0 in step 3. Step 4 prints nothing. Step 5 prints 0 for the Queue messages, the R2 files and the events table: the envelope has no email field, so the address exists only in the `/api/complete` body and in `users.email_enc` and `users.email_hash`. `state` shows an email hash or ciphertext, never the address.

### DEMO-9 No real transitions to partners

Automated: none, a manual check.

Manual: read the README section that explains how the transition is reproduced. Check that no command in the README or the tests follows redirects (`grep -rnE -- "curl .*-L( |$)|redirect: ?'follow'" README.md tests/`).

Expected: the README says the transition is a 302 checked by its `Location` header (A-5), and the grep prints nothing.

### Automated test requirements

Each TEST row is met when the cards it maps to pass.

### TEST-1 Offer selection, highest EPU, fallback to 007

Automated: `pnpm test -t "OFF-5|OFF-6|OFF-7|OFF-8|OFF-12"`.

Manual: none beyond the cards it maps to.

Expected: all pass, and decision table rows 1 to 15 and 29 each have a test.

### TEST-2 Returning user with a Lead, including a disabled offer

Automated: `pnpm test -t "OFF-3|OFF-4|OFF-9|ID-3"`.

Manual: none beyond the cards it maps to.

Expected: all pass, and rows 16 to 23, 27 and 28 each have a test.

### TEST-3 Redelivered events and postbacks count once, two purchases count twice

Automated: `pnpm test -t "PB-5|TEST-3"`. Extra case owned by this card: `TEST-3 R-3 resending the same event stores it once`.

Manual: send the same `POST /api/events` body (one event) twice and compare the event count in `state`.

Expected: the count rises once.

### TEST-4 Malformed and unauthorised postbacks change nothing

Automated: `pnpm test -t "PB-3|PB-8"`.

Manual: none beyond the cards it maps to.

Expected: all pass, each with a before and after snapshot.

### TEST-5 The report matches expected results on test data

Automated: `pnpm test -t "AN-1|AN-5|AN-7"`.

Manual: none beyond the cards it maps to.

Expected: all pass on the shared fixture, and the fixture's expected numbers are the ones in AN-1.

## Non-functional requirements

Figures come from [nfr.md](../requirements/nfr.md) and are not repeated here. Several thresholds are still open there (buffer size, p95 latency, store size limit). Until they are set, a card records the measured value and compares it once the number exists. Load and fault drills run against staging, not `wrangler dev`, because local runs say nothing about Cloudflare limits. They cost money on the Workers Paid plan (Q-17), so each run is announced and its cost noted in the stage plan.

Extra provisional tooling for this section:

| Purpose | Tool | Fixed by |
|---|---|---|
| Load scripts | `load/peak.js`, `load/steady.js` (k6). Each iteration sends one event with a new `event_id` for one of many synthetic users. | MVP plan, P-7 |
| Simulated sink outage | `pnpm sink outage on`, `pnpm sink outage off`, each with an optional `--remote` for the deployed Worker. `on` writes the R2 key `control/loader-paused`; while it exists the loader skips its runs, so events pile up in `pending/` and the quiz path runs normally. `off` deletes the key. The demo detects the pause: it expects the funnel cells (visits, started, steps, completed) to stay 0 and every other check as in a normal run. | ADR 0005, ADR 0006, P-8 |
| Pipeline health | `GET /__test/health` answers a `PipelineHealth` object: `as_of`, `loader_paused`, `pending_files`, `pending_truncated`, `pending_oldest_age_ms`, `open_batches`, `last_load_at`, `events_newest_at`, `freshness_ms`. In production the same numbers go to the monitoring named in the metrics document. | ADR 0005, stage 4 metrics |

### NFR-1 Planned load of 12M events per month

Depends on: data model (event catalog), ADRs 0003 and 0005.

Automated: `pnpm test -t "NFR-1"`. Case: `NFR-1 one full visit produces nine events`.

Manual:
1. Reset, run the DEMO-2 block of the demo scenario, then `state $JAR | jq '.me.events | length'`.
2. Open the cost table in nfr.md and check that it uses the services chosen in ADRs 0003 and 0005.

Expected: 9 events for the visit (A-1). If the number differs, the arithmetic and the cost table in nfr.md are updated in the same commit.

### NFR-2 Peak of 200 events/s for 5 minutes

Depends on: ADRs 0003 and 0005, NFR-6 thresholds, P-7.

Automated: none, a load drill.

Manual:
1. `curl -s -X POST $BASE/__test/reset` against staging, then record `curl -s $BASE/__test/health`.
2. `k6 run -e BASE=$BASE --summary-export $TMP/peak.json load/peak.js` (constant arrival rate 200/s, 5 minutes).
3. Wait until `GET /__test/health` shows an empty buffer, then read the stored event count from `GET /__test/state`.
4. Look at the Cloudflare dashboard for the store and the queue during the run: errors, "overloaded" responses, rows written.
5. Optional, with cost agreed: repeat at 2x and 5x (P-7).

Expected: the number of events stored equals the number of 202 responses in `peak.json`. Error rate and p95 are within the NFR-6 thresholds. The store shows no overload errors (R-15). The result and the measured numbers go into nfr.md as evidence.

### NFR-3 Analytics freshness within 15 minutes

Depends on: ADR 0006, metrics document (freshness metric).

Automated: `pnpm test -t "NFR-3"`. Cases: `NFR-3 accepted event is counted in the report within the freshness window`, `NFR-3 the loader cron runs every minute`.

Manual:
1. Note the time, send one quiz step 1 event for a new jar.
2. Poll `curl -s $BASE/api/report | jq .started` every 30 seconds until it rises. Note the time.
3. Repeat step 1 and 2 while `load/peak.js` runs.
4. Read `freshness_ms` and `last_load_at` from `GET /__test/health`.

Expected: in both runs the event is counted within the freshness figure in nfr.md (NFR-3). The metric reports the same lag that was measured by hand.

### NFR-4 A sink outage does not block the quiz

Depends on: ADRs 0005 and 0006, P-8.

Automated: `pnpm test -t "NFR-4"`. Cases: `NFR-4 P-8 sink outage leaves entry, complete, transition and postback working`, `NFR-4 an event the Queue refuses is written to R2 pending/ and answers 202`, `NFR-4 entry and completion answer while the Queue refuses`, `NFR-4 the event answers 503 with Retry-After when the Queue and R2 both refuse`, `NFR-4 a paused loader skips the run and leaves the files`.

Manual:
1. `pnpm sink outage on --remote`.
2. `pnpm test:e2e --base $BASE`, the whole demo scenario while the loader is paused.
3. `curl -s $BASE/__test/health`.
4. `pnpm sink outage off --remote`, wait for the buffer to empty, read the report.

Expected: the HTTP answers and the facts cells in step 2 match a normal run, including the lead return; the funnel cells stay 0 until the loader runs. Step 3 shows a growing buffer and a growing freshness lag. After step 4 the report shows every demo event once.

### NFR-5 Guarantees, buffer limits and a long outage

Depends on: ADR 0005 (buffer capacity, hours of survival, behaviour when full), R-16, R-8.

Automated: `pnpm test -t "NFR-5"`. Cases: `NFR-5 buffer at capacity behaves as ADR 0005 says: a send refused with Storage Limit Exceeded goes to R2`; `NFR-5 R-16 events written while the loader is stopped are loaded once after it restarts`; `NFR-5 R-8 drained rows have no duplicate event ids`; `NFR-5 R-8 an event repeated in a later file is stored once`; `NFR-5 a run resumes an unfinished batch first and stores it once`; `NFR-5 two overlapping runs store each event once`; `NFR-5 an invalid row goes to rejected/ and the rest of the batch loads`; `NFR-5 a batch failing five loads goes to rejected/`; `NFR-5 an unreachable events database does not count as a load attempt`; `NFR-5 a run takes at most 9,000 files`; `NFR-5 a run stops after its batch limit`; `NFR-5 health shows pending files and the age of the oldest`.

Manual:
1. `pnpm sink outage on --remote`, then `k6 run -e BASE=$BASE load/steady.js` at the average rate from nfr.md for a fixed time.
2. Every few minutes record buffer depth and oldest event age from `GET /__test/health`.
3. Compare the growth per minute with the survival figures in ADR 0005. Project the time to full at the average rate and at 200 events/s.
4. `pnpm sink outage off --remote`. Record the time to drain, then compare the count of stored rows with the count of distinct event ids.

Expected: the measured growth matches ADR 0005 within the margin it states. Drain completes and the two counts are equal. The alert named in the metrics document fired during the outage.

### NFR-6 Target API latency and how it is measured

Depends on: metrics document (p95 targets, set in stage 4 per nfr.md), R-18.

Automated: `pnpm test -t "NFR-6"` covers the data points and the probe, not the p95 itself. Cases: `NFR-6 endpoint labels are fixed patterns, never the raw path`, `NFR-6 R-18 a request point has the endpoint as index, duration and status as doubles, country and colo as blobs`, `NFR-6 every request writes one data point`, `NFR-6 a handler that throws is recorded with status 500`, `NFR-6 a D1 overload that reaches the error handler is tagged on its point`, `NFR-6 a broken Analytics Engine binding never fails the request`, `NFR-6 probe answers 200 with the D1 time`, `NFR-6 probe writes nothing and sets no cookie`, `NFR-6 probe answers 500 when D1 fails`. The p95 measurement stays manual.

Manual:
1. `k6 run -e BASE=$BASE --summary-export $TMP/steady.json load/steady.js` at the average rate, covering `GET /p/demo`, `POST /api/complete`, `GET /go?prelander=demo` and `POST /api/events`.
2. Read p95 per endpoint from `steady.json`, and from the Workers analytics in the Cloudflare dashboard for the same window.
3. Read the p95 values from the `load/peak.js` run in NFR-2.
4. Note where k6 ran from. If the design names more than one region (NFR-7), run step 1 from each.

Expected: p95 per endpoint at or below the targets in nfr.md, at average and at peak. k6 and the dashboard agree within the margin the metrics document allows. The run location is recorded next to the numbers.

### NFR-7 Geography is an agreed assumption

Depends on: Q-2.

Automated: none, a document check.

Manual:
1. Read the status of Q-2 in open-questions.md.
2. Check that the design states the region next to the latency target, and that the store's location matches it (for D1, `wrangler d1 info <db>`).

Expected: Q-2 is answered or its default is stated in the design. The store sits in the stated region.

### NFR-8 Delayed messages and failures behave as designed

Depends on: ADRs 0005 and 0007, Q-11, Q-12.

Automated: `pnpm test -t "NFR-8|AN-5|PB-4|NFR-4|NFR-5"`. Extra case owned by this card: `NFR-8 R-3 events arriving out of order are all stored and leave D1 unchanged`, `NFR-8 R-3 the completion received last decides the stored answers`.

Manual:
1. Run the AN-5, NFR-4 and NFR-5 manual steps.
2. Send step 1 events with `seq` 2 and then `seq` 1 for the same visit (`answer $JAR gender women 2`, then `answer $JAR gender men 1`), wait up to 2 minutes for the Queue batch and the loader, then `state $JAR`. Then send two `complete` calls in turn and `state $JAR` again.
3. Check that the README section on known limitations lists these tests by name as the evidence.

Expected: all listed tests pass. In step 2 both events are stored and listed in arrival order, and `seq` orders them within the visit for analytics; D1 holds no answers until `complete`; after the two calls the one received last is current (seq orders events, not answers). The README shows how each behaviour was verified.

### A-4 Rule facts are visible to selection within seconds

Depends on: ADR 0003, Q-9.

Automated: `pnpm test -t "A-4"`. Cases: `A-4 Lead is used by the very next entry`, `A-4 Q-9 disabled offer is not selected once the change has taken effect`.

Manual:
1. Run the demo to the Lead. Right after the postback returns, send the DEMO-4 request.
2. `pnpm offer set-status 003 inactive`, then for a women + asia user call `complete` every 5 seconds until the result changes. Note the time. Restore 003.

Expected: step 1 gives the 302 on the first try. In step 2 the change takes effect within the Q-9 default.

### R-12 Email never appears in logs, errors or URLs

Depends on: DEMO-8, P-5.

Automated: `pnpm test -t "R-12"`. Cases: `R-12 malformed completion body with an email is rejected without logging the email`, `R-12 exception path redacts the request body`, `R-12 envelope has no email field: an event carrying one never reaches the Queue`, `R-12 test endpoints answer 404 in production`.

Manual:
1. Run the DEMO-8 manual steps.
2. With `wrangler tail` running, send a `POST /api/complete` with invalid JSON around `user2@example.com`, then a body that makes the handler throw. Then send one valid `complete` for `user2@example.com`, and one `POST /api/events` event with an extra `email` field holding the same address.
3. `grep -c "user2@example.com" $TMP/tail.log`. Scan the Queue messages, R2 files and events table as in DEMO-8 step 5.
4. `pnpm test -t "R-12 test endpoints answer 404"`. The deployed demo has `TEST_ROUTES` on, so the `404` is shown by this test with the flag off, not by a request to the demo.

Expected: step 3 prints 0 for the log and 0 for the Queue, R2 and events scan. Step 4 passes.

### R-14 Abusive clients are limited

Depends on: the rate limit chosen in the design.

Automated: `pnpm test -t "R-14"`. Cases: `R-14 client above the limit gets 429`, `R-14 normal client is unaffected`, `R-14 oversized payload gets 413`.

Manual: run `load/peak.js` from one client identity above the limit while a second jar runs the demo scenario.

Expected: the first client gets 429 above the limit. The demo scenario gives its usual output.

### R-17 The report does not scan the whole event store

Depends on: metrics document (MVP-5 size limit and signal).

Automated: `pnpm test -t "R-17"`. Case: `R-17 report rows read stays flat as events grow`.

Manual:
1. After the NFR-2 run, open the report and read the rows read for each query (D1 `meta.rows_read` in the Worker log, or the equivalent for the chosen store).
2. Run `load/peak.js` again and repeat.

Expected: rows read do not grow in proportion to the stored events, and stay under the threshold in the metrics document.

## Coverage matrix

One row per card. "Test names" is the prefix to filter on; "Waits on" is what has to exist before the card can run as written.

| ID | Card | Test names | Waits on |
|---|---|---|---|
| QZ-1 | [Step 1 asks for the desired partner's gender](#qz-1-step-1-asks-for-the-desired-partners-gender) | `QZ-1` | ADR 0005 |
| QZ-2 | [Step 2 asks for ethnicity, worded by the step 1 answer](#qz-2-step-2-asks-for-ethnicity-worded-by-the-step-1-answer) | `QZ-2` | ADR 0005 |
| QZ-3 | [Email does not affect the offer or create a Lead](#qz-3-email-does-not-affect-the-offer-or-create-a-lead) | `QZ-3` | ADR 0004 |
| QZ-4 | [Events link to transitions, and current answers are derived](#qz-4-events-link-to-transitions-and-current-answers-are-derived) | `QZ-4` | ADR 0005, data model |
| QZ-5 | [The current step is not stored separately](#qz-5-the-current-step-is-not-stored-separately) | `QZ-5` | data model |
| QZ-6 | [One quiz](#qz-6-one-quiz) | manual only | nothing |
| QZ-7 | [One page with the three steps](#qz-7-one-page-with-the-three-steps) | `QZ-7` | MVP plan (UI test tool) |
| ID-1 | [Users have a UserID and properties; events have an EventID](#id-1-users-have-a-userid-and-properties-events-have-an-eventid) | `ID-1` | ADR 0002, ADR 0005 |
| ID-2 | [The same user is recognised on a return visit](#id-2-the-same-user-is-recognised-on-a-return-visit) | `ID-2` | ADR 0002 |
| ID-3 | [An email alone does not confirm identity](#id-3-an-email-alone-does-not-confirm-identity) | `ID-3` | ADR 0002, ADR 0007 |
| ID-4 | [User properties and events are stored](#id-4-user-properties-and-events-are-stored) | `ID-4` | ADR 0002, data model |
| OFF-1 | [The synthetic catalog of 7 offers is seeded, all active](#off-1-the-synthetic-catalog-of-7-offers-is-seeded-all-active) | `OFF-1` | ADR 0003 |
| OFF-2 | [EPU is a configured constant](#off-2-epu-is-a-configured-constant) | `OFF-2` | ADR 0003 |
| OFF-3 | [A Lead for an active offer skips the quiz and beats EPU](#off-3-a-lead-for-an-active-offer-skips-the-quiz-and-beats-epu) | `OFF-3` | ADR 0004 |
| OFF-4 | [Several Leads](#off-4-several-leads) | `OFF-4` | ADR 0004 |
| OFF-5 | [Highest EPU among matching active specialised offers, ties to the lowest ID](#off-5-highest-epu-among-matching-active-specialised-offers-ties-to-the-lowest-id) | `OFF-5` | ADR 0004 |
| OFF-6 | [Fallback to the universal offer](#off-6-fallback-to-the-universal-offer) | `OFF-6` | ADR 0004 |
| OFF-7 | [The universal offer does not compete on EPU](#off-7-the-universal-offer-does-not-compete-on-epu) | `OFF-7` | ADR 0004 |
| OFF-8 | [No offer available](#off-8-no-offer-available) | `OFF-8` | ADR 0004 |
| OFF-9 | [A Lead for a disabled offer gives no redirect right](#off-9-a-lead-for-a-disabled-offer-gives-no-redirect-right) | `OFF-9` | ADR 0004 |
| OFF-10 | [Selection runs on the server and the demo shows name and URL](#off-10-selection-runs-on-the-server-and-the-demo-shows-name-and-url) | `OFF-10` | ADR 0004 |
| OFF-11 | [The redirect is checked without opening the partner site](#off-11-the-redirect-is-checked-without-opening-the-partner-site) | `OFF-11` | ADR 0004, ADR 0007 |
| OFF-12 | [The spec's worked examples hold](#off-12-the-specs-worked-examples-hold) | `OFF-12` | ADR 0004 |
| PB-1 | [Lead and Purchase are accepted](#pb-1-lead-and-purchase-are-accepted) | `PB-1` | ADR 0007 |
| PB-2 | [The postback contract](#pb-2-the-postback-contract) | `PB-2` | ADR 0007 |
| PB-3 | [Authenticity check](#pb-3-authenticity-check) | `PB-3` | ADR 0007 |
| PB-4 | [Correlation with click, user and offer](#pb-4-correlation-with-click-user-and-offer) | `PB-4` | ADR 0007 |
| PB-5 | [No double counting](#pb-5-no-double-counting) | `PB-5` | ADR 0007 |
| PB-6 | [A quiz email is not a Lead](#pb-6-a-quiz-email-is-not-a-lead) | `PB-6` | ADR 0007 |
| PB-7 | [Test requests can be sent without a partner](#pb-7-test-requests-can-be-sent-without-a-partner) | `PB-7` | ADR 0007 |
| PB-8 | [Malformed and unauthorised postbacks change nothing](#pb-8-malformed-and-unauthorised-postbacks-change-nothing) | `PB-8` | ADR 0007 |
| AN-1 | [Funnel metrics](#an-1-funnel-metrics) | `AN-1` | metrics document |
| AN-2 | [Breakdown by prelander, offer and period](#an-2-breakdown-by-prelander-offer-and-period) | `AN-2` | metrics document |
| AN-3 | [Conversion denominators](#an-3-conversion-denominators) | `AN-3` | metrics document |
| AN-4 | [Repeat visits](#an-4-repeat-visits) | `AN-4` | metrics document |
| AN-5 | [Late postbacks](#an-5-late-postbacks) | `AN-5` | metrics document, Q-12 |
| AN-6 | [The MVP report](#an-6-the-mvp-report) | `AN-6` | metrics document |
| AN-7 | [The report counts recorded events](#an-7-the-report-counts-recorded-events) | `AN-7` | metrics document |
| AN-8 | [The report uses the design's metric definitions](#an-8-the-report-uses-the-designs-metric-definitions) | `AN-8` | metrics document |
| BIZ-2 | [Visitor events are collected](#biz-2-visitor-events-are-collected) | `BIZ-2` | data model |
| BIZ-3 | [Selection uses properties and history on the server](#biz-3-selection-uses-properties-and-history-on-the-server) | OFF-3, OFF-10 | ADR 0004 |
| MVP-1 | [Deployed path from answer to event, offer and report](#mvp-1-deployed-path-from-answer-to-event-offer-and-report) | `test:e2e` | MVP plan |
| MVP-4 | [Analytics read Cloudflare storage, no BigQuery](#mvp-4-analytics-read-cloudflare-storage-no-bigquery) | manual only | ADR 0003 |
| DEMO-1 | [Reviewers can repeat the scenario from short instructions](#demo-1-reviewers-can-repeat-the-scenario-from-short-instructions) | manual only | README |
| DEMO-2 | [A new user gets the correct offer](#demo-2-a-new-user-gets-the-correct-offer) | `DEMO-2` | ADR 0004, ADR 0007 |
| DEMO-3 | [A test Lead for that user's transition](#demo-3-a-test-lead-for-that-users-transition) | `DEMO-3` | ADR 0004, ADR 0007 |
| DEMO-4 | [The same user returns without the quiz](#demo-4-the-same-user-returns-without-the-quiz) | `DEMO-4` | ADR 0004, ADR 0007 |
| DEMO-5 | [A Purchase changes the report](#demo-5-a-purchase-changes-the-report) | `DEMO-5` | ADR 0004, ADR 0007 |
| DEMO-6 | [Repeating a postback does not double the numbers](#demo-6-repeating-a-postback-does-not-double-the-numbers) | `DEMO-6` | ADR 0004, ADR 0007 |
| DEMO-7 | [Test data and expected results are included](#demo-7-test-data-and-expected-results-are-included) | manual only | README |
| DEMO-8 | [Synthetic emails only; email never in URLs or logs](#demo-8-synthetic-emails-only-email-never-in-urls-or-logs) | `DEMO-8` | data model (P-5) |
| DEMO-9 | [No real transitions to partners](#demo-9-no-real-transitions-to-partners) | manual only | README |
| TEST-1 | [Offer selection, highest EPU, fallback to 007](#test-1-offer-selection-highest-epu-fallback-to-007) | OFF-5..8, OFF-12 | ADR 0004 |
| TEST-2 | [Returning user with a Lead, including a disabled offer](#test-2-returning-user-with-a-lead-including-a-disabled-offer) | OFF-3, OFF-4, OFF-9, ID-3 | ADR 0004, ADR 0007 |
| TEST-3 | [Redelivered events and postbacks count once, two purchases count twice](#test-3-redelivered-events-and-postbacks-count-once-two-purchases-count-twice) | `TEST-3`, PB-5 | ADR 0005, ADR 0007 |
| TEST-4 | [Malformed and unauthorised postbacks change nothing](#test-4-malformed-and-unauthorised-postbacks-change-nothing) | PB-3, PB-8 | ADR 0007 |
| TEST-5 | [The report matches expected results on test data](#test-5-the-report-matches-expected-results-on-test-data) | AN-1, AN-5, AN-7 | metrics document |
| NFR-1 | [Planned load of 12M events per month](#nfr-1-planned-load-of-12m-events-per-month) | `NFR-1` | data model, ADR 0003, ADR 0005 |
| NFR-2 | [Peak of 200 events/s for 5 minutes](#nfr-2-peak-of-200-eventss-for-5-minutes) | manual only | ADR 0003, ADR 0005, NFR-6 targets |
| NFR-3 | [Analytics freshness within 15 minutes](#nfr-3-analytics-freshness-within-15-minutes) | `NFR-3` | ADR 0006, metrics document |
| NFR-4 | [A sink outage does not block the quiz](#nfr-4-a-sink-outage-does-not-block-the-quiz) | `NFR-4` | ADR 0005, ADR 0006 |
| NFR-5 | [Guarantees, buffer limits and a long outage](#nfr-5-guarantees-buffer-limits-and-a-long-outage) | `NFR-5` | ADR 0005 |
| NFR-6 | [Target API latency and how it is measured](#nfr-6-target-api-latency-and-how-it-is-measured) | manual only | metrics document |
| NFR-7 | [Geography is an agreed assumption](#nfr-7-geography-is-an-agreed-assumption) | manual only | Q-2 |
| NFR-8 | [Delayed messages and failures behave as designed](#nfr-8-delayed-messages-and-failures-behave-as-designed) | `NFR-8` | ADR 0005, ADR 0007 |
| A-4 | [Rule facts are visible to selection within seconds](#a-4-rule-facts-are-visible-to-selection-within-seconds) | `A-4` | ADR 0003 |
| R-12 | [Email never appears in logs, errors or URLs](#r-12-email-never-appears-in-logs-errors-or-urls) | `R-12` | data model (P-5) |
| R-14 | [Abusive clients are limited](#r-14-abusive-clients-are-limited) | `R-14` | design (rate limit) |
| R-17 | [The report does not scan the whole event store](#r-17-the-report-does-not-scan-the-whole-event-store) | `R-17` | metrics document |

## Not covered here

- PRC, DES and AI rows are document and process checks. Their verify steps are in the stages of [part1-design-document.md](../plans/part1-design-document.md), mainly stage 7.
- DLV rows are hand-over checks. They go into the Part 2 plan that stage 6 of the Part 1 plan writes.
- BIZ-1, BIZ-4, BIZ-5, MVP-2, MVP-3, MVP-5 and MVP-6 are checked against the design document in stage 5 and the final checklist in stage 7. MVP-5 also has a runtime check in R-17.
