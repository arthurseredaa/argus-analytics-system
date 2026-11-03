# Example 7: how the quiz email reaches D1 without reaching analytics

- Date: 2026-11-03
- Stage: 3, data model

## Task given to the AI

Decide how the quiz email reaches D1 encrypted without reaching analytics. The email is typed at step 3, and the event path (Worker, Queue, R2, BigQuery) must not carry it.

## What the AI proposed

Three options. The recommendation was to keep one event path for all three steps: the browser sends the same answer event for step 3, and the Worker strips the value when `question_key = email` before the event goes to the Queue. The Worker would write the encrypted email to D1 itself. A log-scan test would back it by checking that the address appears nowhere downstream.

## Decision

Arthur rejected the stripping. His words (Ukrainian in the session): "це звучить трохи як костиль" ("that sounds a bit like a hack"). The objection is that it is a special case that breaks silently: one forgotten branch or a renamed key and the address flows into the Queue and BigQuery with no error. He chose a separate endpoint for the email.

He then went further: "А якщо відправляти відповіді юзера вкінці воронки з email? Типу навіщо нам квіз юзера зберігати, якщо він не пройшов квіз і не залишив email?" ("What if we send the user's answers at the end of the funnel together with the email? Why store a user's quiz if they did not finish it and left no email?"). So all answers go together with the email at completion. The browser calls `POST /api/complete` with `{"answers":{...},"email":"..."}` once, after the email step. Step events stay analytics only and never write D1. That removed two things the first design needed: ordering of per-step answers (the latest accepted answer is the completion request received last) and the per-step D1 writes. The event envelope has no email field. A user who stops before the email step has no rows in D1.

## Verification

- The data model's trace table follows the email through the system: it appears only in the `/api/complete` body and in `users.email_enc` and `users.email_hash`.
- The event envelope (`event_id`, `schema_version`, `type`, `client_time`, `visit_id`, `seq`, `prelander_id`, `payload`) has no field that can hold it.
- The log-scan check was extended: `DEMO-8` and `R-12` in `docs/testing/acceptance-checks.md` now assert the address is absent from Queue messages, R2 files and the events table, as well as from logs and URLs.
- The acceptance cards that used `POST /api/select` or per-step storage were rewritten to the new flow.
