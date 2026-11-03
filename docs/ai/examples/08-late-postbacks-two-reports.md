# Example 8: where a late postback lands in the report

- Date: 2026-11-03
- Stage: 4, metrics and operations

## Task given to the AI

Stage 4 of the plan opens with three decisions for Arthur: the denominator of the funnel metrics and what counts as "started the quiz", how late postbacks affect reports, and the latency target with its measurement method. The AI had to present the options and recommend one of each.

## What the AI proposed

The first round named the options in design terms (cohort by click date with an "as of" time, by postback date, or both). Arthur answered all three with "поясни простіше" ("explain it more simply"). The second round used examples: Ivan with two visits in one day for the denominator, a New York user reaching a database in Europe for the latency. Arthur took the recommended option for the denominator (unique users per prelander and UTC day, start is step 1 shown) and for latency (p95 measured in the Worker, 50 ms for events, 300 ms for selection, a synthetic probe from the EU and the US at 500 ms).

For late postbacks he still asked: "ну мені вибірка за датою postback звучить логічно і чисто, де я помиляюся?" ("counting by postback date sounds logical and clean to me, where am I wrong?"). The AI answered with one table: 100 clicks on 3 November, 5 Leads accepted on 4 November and 3 on 5 November, all for the 3 November clicks. By click date the 3 November row shows 8 Leads and 8% conversion, but the figure grew over three days, so the report needs an "as of" time. By postback date the three rows show 0, 5 and 3, the past never changes, but the 5 Leads on 4 November stand next to the 4 November clicks they did not come from, so no conversion rate can be read from that view.

## Decision

Arthur: "ааа я поняв, ну тоді це буде два окремих звіта" ("ah, I get it, then it will be two separate reports"). The design has two reports over the same data: the funnel report keyed by the click date with the "as of" time printed on it, for the question "which funnel converts", and the finance report keyed by the time we accepted the postback, for the question "what came in this period". This is the default that `open-questions.md` already carried for Q-12 and proposal P-6; the session confirmed it with the owner understanding why, instead of inheriting it.

## Verification

- `docs/design/metrics-and-operations.md` carries the worked example and names the sort key of each report (`clicks.created_at` and the event's `received_at` for the funnel, `conversions.accepted_at` for finance).
- Acceptance check `AN-5` in `docs/testing/acceptance-checks.md` seeds a click dated yesterday, sends a Purchase today, and expects it on yesterday's cohort in `view=cohort` and on today in `view=postback`. The stage 6 report implements both views and that test.
