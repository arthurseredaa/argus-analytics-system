# Example 1: independent audit of the requirements breakdown

- Date: 2026-10-29
- Stage: 2, requirements breakdown

## Task given to the AI

The main agent wrote `docs/requirements/` from the Ukrainian spec. A separate subagent, which had not seen the main agent's reasoning, was given the PDF and the five files. It was asked to do three things and report findings only: check the spec sentence by sentence for anything missing or reinterpreted, derive the expected result of every decision-table row on its own before reading the "Expected" column, and list ambiguities that would change the design or the tests.

## What the AI proposed

- All 26 decision-table rows matched its own derivation.
- One rule contradicted the spec: an offer disabled between selection and redirect would still be used, but rules 1 and 2 only allow active offers.
- Several "not needed" statements in the spec had been turned into bans (no real BigQuery, no simulator server).
- An ID-3 test was stricter than the spec, and the `QZ-3` check conflicted with the default that email is mandatory.
- The spec's worked examples, the quiz page itself and the "store properties" requirement had no IDs.
- Three rows were missing from the decision table, and six questions were missing: return visits with a Lead, prelander attribution, a second Lead with a new transaction ID, a postback whose offer does not match its click, a step 1 change after step 2, and visit and drop-off definitions.
- The reading of Q-1 (returning user without a Lead sees the quiz again) was flagged as inconsistent with rule 3.

## Decision

Accepted all findings except one. For Q-1 the default stays as it was: the spec ties skipping the prelander to users registered with a partner. The question now spells out the alternative reading, so the company has to choose explicitly. The redirect rule was changed to re-check offer status. Q-21 to Q-26, OFF-12, QZ-7, ID-4 and rows 27 to 29 were added.

## Verification

A grep check confirmed that every wording fix was applied and that question IDs run from Q-1 to Q-26 without gaps. The decision table will become unit tests in Part 2 (P-9), which will check the expected results a second time.
