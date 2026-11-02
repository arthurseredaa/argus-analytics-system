# Example 6: a hand-drawn diagram that found gaps in two ADRs

- Date: 2026-11-02, 18:13 to 19:06 UTC
- Stage: 2, explain-back for ADRs 0005 to 0007 (events, BigQuery delivery, postbacks)

Quotes are copied verbatim from the session transcript. The conversation was in Ukrainian.

## Task given to the AI

To close stage 2, Arthur had to explain the event and postback paths back in his own words. Claude offered to draw the diagram together; Arthur drew it himself in Obsidian and asked Claude to check it against the ADRs.

Arthur, 18:13:57 UTC:

> я сам намалюю в obsidian bruh

## What the AI proposed

Checking Arthur's arrow from the Queue to the dead letter queue, Claude found that its own ADR 0005 contradicted itself:

Claude, 18:33:24 UTC:

> Ти підписав стрілку Queue → DLQ «if consumer is failure», і це змусило мене перевірити логіку. У ADR написано дві речі, які не узгоджуються:
> - при збої R2 події лежать у черзі 14 днів;
> - після 10 невдалих спроб пачка йде в DLQ.
>
> Якщо R2 лежить годинами, consumer падає на кожній спробі, і після 10 спроб повідомлення переходять у DLQ. Тобто вони не лежать у черзі 14 днів. Дані не губляться, бо DLQ теж черга з 14 днями зберігання, але повернути їх звідти треба окремим кроком.

A later check of the `rejected/` folder found two more gaps in ADR 0006: no retention for the folder, and no limit on load job attempts, so one batch BigQuery kept rejecting would have used up the daily 1,500 jobs.

Claude then pointed out a detail on the diagram, the fallback note "save each event", and claimed the Worker writes one file per request with possibly several events. Arthur asked how the Worker would join events:

Arthur, 19:03:11 UTC:

> але як воркер буде склеювати івенти? Він ж не може тримати їх в своїй власній черзі, а тримати в пам'яті ризиковано

Claude agreed that the Worker cannot join events across requests, said the browser would be the one to join them, and proposed leaving the sending rule open for block 3:

Claude, 19:03:22 UTC:

> Скільки подій буде в одному запиті, у нас ще не вирішено: ADR каже тільки «one or more». На візит припадає 9 подій, і між кроками квізу минають секунди, тож якщо браузер відправляє події одразу, у більшості запитів буде одна-дві. Отже, твоє «each event» майже правильне. Точніше буде «one file per request (usually 1–2 events)».

## Decision

Arthur closed the open point himself:

Arthur, 19:04:03 UTC:

> в одному запиті точно буде лише 1 подія, клієнт буде надсилати подію на кожному продуктовому етапі, так само партнер, надсилає lead і окремо надсилає purchase

Claude laid out what this costs before writing it down:

Claude, 19:04:24 UTC:

> 1. **Вартість.** У `nfr.md` є дві колонки: «no batching» (одна подія на запит) і «10 events per request». Твоє рішення означає першу колонку. При 18M подій це **$28.60 на місяць замість $6.76**. Різниця майже вся в Queue: 54M операцій ($21.20) і 18M запитів до Worker ($2.40). Сума невелика, але це в 4 рази більше, і рецензент може про це спитати.

Arthur accepted it, together with the fixes for the dead letter queue and `rejected/`:

Arthur, 19:06:01 UTC:

> Вносимо і записуємо ці кейси, тоді мій малюнок коректний? чекни ще раз

In his second version of the diagram Arthur had set the `rejected/` alert at 1% of events. Claude argued for alerting on any rejected file, since the Worker already rejects malformed events and anything in `rejected/` means a bug; the third version says "+raise alert" with no threshold.

What was written:

- ADR 0005: one event per request, with Arthur's reasons and the cost; consumer retries with delays growing from 1 minute to 1 hour, about 5 hours in total; a dead letter queue with no consumer and a redrive script, with messages sent as `json` so the HTTP pull API can read them.
- ADR 0006: envelope types checked before loading; at most five failed jobs per batch before it goes to `rejected/`, with BigQuery outages not counted; 30-day retention for `rejected/` and a recovery step; at most 9,000 files per run, so one-event files from a Queue outage cannot exceed the Worker's subrequest limit.
- `nfr.md`: the unbatched column is the design cost; NFR-5 rows for the 5 hours of retries and the drain rate after a Queue outage.

The diagram caught a contradiction the ADR review had missed, and Arthur's question corrected Claude's claim that the Worker joins events.

## Verification

- Retry delays up to 24 hours, the dead letter queue behaviour, the pull consumer's `v8` limitation, R2 deletes of up to 1,000 keys per call and the 10,000 subrequests per invocation were checked on the Cloudflare docs on 2026-11-02; the links are in the References of ADRs 0005 and 0006.
- The retry schedule adds up to 303 minutes (1 + 2 + 4 + 8 + 16 + 32 + 4 × 60), the figure in `nfr.md`.
- The tests named in the ADRs (`consumer write failure is retried with growing delays and goes to the dead letter queue after 10 retries`, `load job failing five times moves the batch to rejected`, `BigQuery unavailable does not count as a load attempt`, `a run takes at most 9,000 files`) are written with the implementation in Part 2.
- The diagram itself: `docs/ai/examples/06-diagram.png` (third revision, after the fixes above).
- Commit: the stage 2 closing commit.
