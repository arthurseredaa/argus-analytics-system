# Example 10: the transition without an offer id in the URL

- Date: 2026-11-05
- Stage: Part 2 stage 3, redirect, postbacks and the Lead return

## Task given to the AI

Write the stage 3 plan (`docs/plans/part2-stage-3-redirect-postbacks.md`): the transition to the partner at `/go`, the signed postback and the Lead return, as the design and ADR 0007 describe them.

## What the AI proposed

The design had `GET /go/{offer}?prelander=`. The result page put the offer id into the link, and the Worker checked only that the offer was still active before writing the click and answering `302`. While writing the plan, the AI noticed that a user could change `/go/003` to `/go/004` in the address bar and get a click, and later a Lead, on an offer `select()` never chose for them. It proposed keeping the path and recording this as a new accepted risk, since a user gains little from it.

## Decision

Arthur asked for the risk to be explained before deciding. Then he proposed removing it instead of accepting it (Ukrainian in the session): "На етапі показу go в D1 вже є всі потрібні дані для вибору потрібного офера, так? Тоді після того як юзер залишає імейл, від потрапляє на сторінку /offer, яка робить запит на бек, бек віддає їх офер та click_id, по суті в цьому випадку клієнту нічого не треба пам'ятати, після перезавантаження юзер отримуватиме ті ж дані з сервера по uid в кукі і він нічого не зламає в URL" ("When /go is shown, D1 already has all the data needed to choose the offer, right? Then after the user leaves the email they land on an /offer page that asks the back end, the back end returns their offer and click_id, so the client does not need to remember anything, after a reload the user gets the same data from the server by the uid in the cookie and cannot break anything in the URL").

The AI agreed with the core of it, `select()` on the server by the cookie, and changed one part. The click is written at the press, not when an `/offer` page is shown, because otherwise every reload adds a click and the "went to the offer" metric counts page views. Arthur asked for a second opinion ("порадься щодо цього питання ще з fable", "check this question with Fable too"). A Fable review was given the options and the code without the AI's recommendation, and it reached the same design on its own: `/go?prelander=&visit=` with no offer id, `select()` at the press, the click written before the `302`.

What changed as a result:

- A changed URL has nothing to swap.
- An offer disabled between showing and pressing needs no separate code, since `select()` reads the current catalog (R-9).
- The event `offer_selected` with moment `redirect` was dropped, so a visit stays at 9 events.
- A user with no `users` row is sent to the quiz (Q-30).

The cost, recorded in the plan: if the operator changes the catalog in the seconds between showing offer X and the press, the user goes to the new result instead of X.

## Verification

- `GET /go` in `src/routes/go.ts` reads the facts and the catalog, calls `select()` with moment `redirect`, and writes the click through `startTransition()` in `src/routes/transition.ts`.
- Tests in `tests/integration/go.test.ts`, among them `OFF-11 R-9 offer disabled after selection is re-selected at /go` and `OFF-11 click row exists before the 302`.
- `pnpm test -t "A-4|NFR-1|DEMO-3|DEMO-4|DEMO-6"`: 6 passed, among them `NFR-1 one full visit produces nine events`.
- `pnpm check`: 333 passed on branch `part2-stage-3`.
