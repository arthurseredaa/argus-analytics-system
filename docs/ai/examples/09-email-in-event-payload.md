# Example 9: an email inside an event payload

- Date: 2026-11-05
- Stage: Part 2 stage 2, events

## Task given to the AI

Write the stage 2 plan (`docs/plans/part2-stage-2-events.md`): event ingestion through the Queue, with the rule from the data model that an email never reaches an event.

## What the AI proposed

The AI found a gap while writing the plan. The envelope is strict and has no email field, and the payloads of the two browser types the Worker knows are checked against the quiz config. The payload of an unknown type or an unknown `schema_version` is stored as sent (ADR 0005), so a future client release could put an email into it, for example a page URL with `?email=` added by an ad network. The AI recommended answering `400` for an event whose payload holds an email, so that a bug in our own page fails a test instead of passing quietly.

## Decision

Arthur first questioned the premise (Ukrainian in the session): "Ну перш за все це відповідальність фронта, ми працюємо лише з тими полями, які ми знаємо, поле email в пейлоаді ми чіпати не будемо, тож поясни мені, чому це проблема? Чи ти переживаєш саме про поле payload яке довільно записується?" ("First of all this is the front end's responsibility, we work only with the fields we know, we will not touch an email field in the payload, so explain why this is a problem. Or are you worried about the payload field, which is written freely?"). The AI answered that it was the free payload: the guarantee in the data model would rest on a convention in the browser code.

Arthur then chose a smaller fix than the rejection: "Додамо на бекенді якийсь sanitizePayload метод, який буде прибирати звідти email поле, та й все" ("We'll add a sanitizePayload method on the backend that removes the email field from there, and that's it"). The event is accepted and the key is removed.

The AI's plan text then also replaced email-shaped substrings inside string values with a placeholder. Arthur asked what that meant, and after the explanation dropped it: "давай стрінги не чіпати, поточний рівень захисті від полей email достатній" ("let's not touch strings, the current level of protection against email fields is enough"). An email inside a string of an unknown type was recorded as the accepted risk R-23 in `risks.md`, and the stage 2 text of `part2-mvp-stages.md`, which had said no content filter was needed, was corrected.

## Verification

- `sanitizePayload()` in `src/events/sanitize.ts` is called from `sendEvent()` in `src/events/producer.ts`, the one place that sends to the Queue, so browser and server events both pass through it.
- Unit tests: `R-23 R-12 a key named email is removed at any depth`, `R-23 string values are left unchanged`, `R-23 the demo's step payloads are unchanged`, `R-23 sanitizing does not change its input`.
- Route test: `R-23 R-12 an email field in the payload of an unknown type is removed before the Queue`.
- `pnpm test`: 217 passed on branch `part2-stage-2` (PR #3).
