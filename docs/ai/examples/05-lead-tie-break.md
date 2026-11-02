# Example 5: the tie-break between two Leads

- Date: 2026-11-02, 16:36 to 17:03 UTC
- Stage: 1, ADR 0004 (offer selection semantics)

Quotes are copied verbatim from the session transcript. The conversation was in Ukrainian.

## Task given to the AI

Draft ADR 0004 and settle Q-10: a user with Leads for several active offers, which one wins. The spec asks us to propose this (OFF-4).

Arthur first read "most recent Lead" as the offer from the current quiz run and asked:

Arthur, 16:58:52 UTC:

> 1. Так, гуд
> 2. Що означає найсвіжіший? Той, який ми вивели з поточного проходження квіза користувачем?

After the explanation he accepted the rule:

Arthur, 16:59:39 UTC:

> Так, це найправильніша поведінка

Reading the summary of the written ADR, he changed the tie-break:

Arthur, 17:03:20 UTC:

> Q-10 Якщо час однаковий до мілісекунди, вибираємо менший ID офера
> Моя пропозиція вибирати вищий EPU, замість орієнтування на ID, це дозволить більше заробити, якщо буде такий кейс, хоча він нереалістичний досить

## What the AI proposed

The three options and the recommendation:

Claude, 16:36:01 UTC:

> ### 2. Кілька Lead на активні офери (Q-10)
>
> ТЗ просить запропонувати рішення самим (OFF-4). Lead на вимкнені офери відкидаємо одразу, а з тих, що лишилися:
>
> - **Найсвіжіший Lead** (за часом, коли ми прийняли постбек). Людина повертається туди, де зареєструвалась останньою, а це, найімовірніше, сервіс, яким вона зараз користується.
> - **Найбільший EPU.** Більше очікуваного доходу, але людину можна відправити в старий акаунт, який вона давно покинула.
> - **Найперший Lead.** Стабільно, але нові реєстрації ігноруються.
>
> Раджу найсвіжіший (рядок 22 таблиці вже так рахує).

The answer to Arthur's question about "most recent":

Claude, 16:59:00 UTC:

> Ні, квіз тут взагалі ні до чого. Людина з Lead на активний офер квіз не проходить: правило 1 спрацьовує на вході і відправляє її на офер ще до рендеру. Її відповіді при цьому ігноруються (рядок 27 таблиці рішень).
>
> «Найсвіжіший» означає Lead, постбек якого ми прийняли останнім. Приклад:
>
> | Дата | Що сталося | Lead у D1 |
> |---|---|---|
> | 1 жовтня | Реєстрація в 001, партнер надіслав постбек | 001 (1 жовтня) |
> | 5 жовтня | 001 вимкнули. Людина повернулась, за правилом 3 пішла на 003 і зареєструвалась там | 001 (1 жовтня), 003 (5 жовтня) |
> | 10 жовтня | 001 знову ввімкнули | обидва активні |
> | 12 жовтня | Людина повертається | ведемо на **003**, бо це найсвіжіший Lead |
>
> Логіка в тому, що остання реєстрація найкраще показує, яким сервісом людина зараз користується.
>
> Час беремо наш, тобто момент, коли ми прийняли постбек. Партнер теж може надіслати свій час реєстрації, але він може бути відсутнім або неточним, а наш час є завжди і рахується однаково для всіх партнерів.
>
> Беремо найсвіжіший?

The written ADR added a tie-break the conversation had not discussed, offer ID:

Claude, 17:00:51 UTC:

> - Q-10: перемагає найсвіжіший Lead за нашим часом прийому постбеку. Якщо час однаковий до мілісекунди, вибираємо менший ID офера.

## Decision

Most recent Lead wins, by the time we accepted its postback. Arthur rejected the lower offer ID as the tie-break for two Leads accepted at the same millisecond and chose the higher EPU in the current catalog version, the same direction rule 2 takes on revenue. The lower offer ID stays only as the last step when the EPU is equal too, so the result is always determined. Claude accepted the change:

Claude, 17:03:32 UTC:

> Прийняв і змінив. Якщо два Lead мають однаковий час, вибираємо більший EPU з поточної версії каталогу. Правило 2 так само розв'язує нічию на користь доходу. Якщо і EPU однаковий, вибираємо менший ID, щоб результат завжди був однозначний.
>
> Де змінено:
> - `docs/adr/0004-offer-selection-semantics.md`: рішення по Q-10, крок 2 функції `select` і новий тест `Q-10 leads accepted at the same time go to the higher EPU`. В ADR записано, що це твій вибір і чому.
> - `docs/requirements/open-questions.md`: дефолт Q-10.
>
> Тепер твоє пояснення демо-кроків. Для кожного кроку назви, що сервер читає і що пише і в якому сховищі:
> 1. Новий користувач заходить, проходить квіз, отримує офер і клікає.
> 2. Партнер надсилає Lead.
> 3. Користувач повертається.

The AI's own addition (a tie-break by ID) went into the ADR summary without being asked as a question; Arthur caught it on reading the summary.

## Verification

- `docs/adr/0004-offer-selection-semantics.md` states the rule in the Decision section and in step 2 of the `select` function, and names the test `Q-10 leads accepted at the same time go to the higher EPU`. Q-10 in `open-questions.md` carries the same default.
- The stage 1 checklist ran on 2026-11-02: every ADR section filled, 9 of 9 options in ADR 0004 with a "where it breaks" sentence, decision table rows 1, 3, 5, 6, 7, 8 and 16 matching the spec examples.
- The test itself is written with the selection function in Part 2.
- Commit: the stage 1 commit, `docs: ADRs for identity, operational store, selection semantics`.
