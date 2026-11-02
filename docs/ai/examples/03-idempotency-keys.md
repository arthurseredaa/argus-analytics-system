# Example 3: idempotency keys for funnel events and postbacks

- Date: 2026-11-02, 14:34 to 14:38 UTC
- Stage: 0, platform limits (Arthur's block 0 self-check, the Queues answer)

Quotes are copied verbatim from the session transcript. The conversation was in Ukrainian.

## Task given to the AI

Claude had suggested ending Arthur's Queues sentence with "duplicates are dropped by event_id". Arthur asked what event_id means for postbacks, then proposed two alternatives: a standard `Idempotency-Key` header, and deduplicating funnel events by fields (partner_id, event, click_id) with database unique constraints, the same way as postbacks.

Arthur, 14:34:21 UTC:

> а що таке event_id в нашому випадку?
> партнер надсилає лише partner_id, event, click_id

Arthur, 14:35:21 UTC:

> в нашому випадку event_id це як idempotancy key?

Arthur, 14:38:06 UTC:

> а чи не стандартніше буде генерувати idempotency key і щоб клієнт ставив його в хедер? чи ніби стандартна практика
> і я не розумію чому ми не можемо фільтрувати івенти з воронок так само як івенти від партнерів по partner_id, event та click_id і юзати unique constraints бази, як і для івентів партнера, тоді в нас однакові правила з обох сторін, що спрощує використання, по суті в кампаніях ми можемо прокидати partner_id чи це вже несекьюрно?

## What the AI proposed

Claude, 14:34:43 UTC:

> event_id потрібен тільки для подій з браузера. Для постбеків ключ інший.
>
> ### Події з браузера
>
> Коли браузер створює подію («відповів на крок 1», «клікнув на офер»), він одразу генерує для неї випадковий id, наприклад UUID. Якщо мережа глюкнула і браузер надіслав подію вдруге, id буде той самий, і сервер побачить, що такий запис уже є. Саме це в `glossary.md` називається EventID (ID-1, R-3).
>
> ### Постбеки
>
> Наш event_id партнер не знає, тому для постбеків ключ складається з того, що надсилає він сам. У P-4 записано: партнер + тип + transaction_id.
>
> Щодо «партнер надсилає лише partner_id, event, click_id»: ТЗ полів не задає. Там сказано «запропонуйте контракт постбека», тож набір полів пропонуємо ми. І з одними цими трьома полями ми не виконаємо пряму вимогу ТЗ: «повторне повідомлення та друга справжня покупка — різні випадки».
>
> Ось чому. click_id каже, до якого кліку, користувача й офера належить постбек. Але на один клік можуть прийти Lead і дві справжні покупки. Для Lead цього вистачає, бо Lead на один клік буває лише один. А от дві покупки з однаковими partner_id, event=Purchase і click_id виглядатимуть точно так само, як одна покупка, надіслана двічі. Відрізнити їх можна тільки за id самої транзакції в системі партнера, тобто за transaction_id.
>
> Тому в контракті вимагаємо transaction_id. Якщо партнер його не надсилає, запасний варіант — хеш тіла запиту, але тоді дві покупки на однакову суму можуть злитися в одну (R-5). Що реально вміють надсилати партнери, записано у відкритому питанні Q-6, і воно піде в супровідний лист.
>
> ### Для речення про черги
>
> Замість «дублі відсікаю за event_id» напиши «дублі відсікаю за ключем ідемпотентності: event_id для подій з браузера, partner + тип + transaction_id для постбеків».

Claude, 14:35:25 UTC:

> Так. Ключ ідемпотентності — це id, завдяки якому повторний запит нічого не змінює: перший раз запис створюється, а на повтор сервер бачить, що такий id уже є, і нічого не робить. Для подій з браузера цю роль виконує event_id. Для постбеків її виконує трійка партнер + тип + transaction_id.
>
> Відрізняє event_id лише те, що це ще й «паспорт» події. Він живе разом з подією далі: за ним прибираємо дублі в BigQuery (R-8) і перевіряємо, що жодна подія не загубилася дорогою.

Claude, 14:38:33 UTC:

> Обидві думки слушні, і друга якраз приводить до одного правила для обох сторін, тільки ключ у ньому інший.
>
> ### 1. Idempotency-Key у заголовку
>
> Так, це стандартна практика: Stripe так робить для платежів, і є чернетка стандарту IETF. Але вона розрахована на випадок «один запит = одна операція». У нас з цим дві проблеми:
>
> - Браузер надсилає кілька подій одним запитом. `nfr.md` показує, що пачки по 10 подій знижують ціну черг з $14 до $1 на місяць. Один заголовок на запит не скаже, яка з десяти подій дубль, якщо браузер повторно відправить пачку в іншому складі.
> - Ключ має йти за подією далі: у чергу, у файл, у BigQuery, де за ним прибирають дублі. Заголовок лишається на вході в Worker, а тіло події доходить до кінця.
>
> Плюс практична дрібниця: `navigator.sendBeacon`, яким зручно надсилати подію, коли користувач закриває вкладку, не дає ставити власні заголовки.
>
> Суть від цього не міняється: ключ так само генерує клієнт, і так само працює unique constraint. Різниця тільки в тому, що ключ свій у кожної події і лежить у тілі.
>
> ### 2. Чому не фільтрувати події воронки за полями, як постбеки
>
> Ключ із полів працює, тільки коли така комбінація реально може статися один раз. Для подій воронки це не так. Користувач відповів на крок 1, повернувся назад і змінив відповідь: це дві справжні події «відповів на крок 1». Він прийшов удруге (ТЗ рахує 2 візити на користувача) або двічі клікнув на офер. Ключ із полів злив би справжній повтор з дублем. Це та сама проблема, що з двома покупками.
>
> Подивись на це так. Відрізнити «те саме повідомлення ще раз» від «нова подія» може тільки той, хто подію створив. Для постбеку це партнер, і його id події — transaction_id. Для події з воронки це браузер, і його id — event_id. Тож правило справді однакове з обох боків: унікальний ключ (джерело, id події від джерела) з unique constraint у базі. Для браузера джерело — `browser` з event_id, для постбеку — партнер з transaction_id. Ти хотів одне правило, і воно в нас є.
>
> click_id у постбеку потрібен для іншого. Він каже, до якого кліку, користувача й офера належить подія. Правило «один Lead на клік» окреме, це бізнес-правило (Q-23), а не захист від дублів.
>
> ### 3. Чи безпечно прокидати partner_id
>
> Так. partner_id — це ідентифікатор, щось на зразок логіна, і секретом він не є. Безпека постбеків тримається на підписі секретом партнера (HMAC або токен, ADR 0007). Якщо хтось знає partner_id і click_id, без секрету він все одно не підробить Lead.
>
> Важливо інше: не довіряти полям, які прийшли з браузера. Браузер може надіслати будь-що, тому сервер визначає партнера й офер за власним записом кліку. У URL ніколи не потрапляють email (ТЗ забороняє прямо), UserID і секрети. click_id у редіректі ми передаємо свідомо, він випадковий і нічого не розкриває (P-2).

## Decision

- The idempotency key for funnel events is a client-generated EventID per event, carried in the event body. An `Idempotency-Key` header per request was set aside: the browser batches events, the key has to travel with each event to the queue and BigQuery, and `navigator.sendBeacon` cannot set custom headers.
- Deduplicating funnel events by their fields was rejected: a changed answer, a second visit and a second offer click are real repeats with the same fields.
- Arthur's goal of one rule for both sides was kept in a different form: the unique key is (source, the source's own event id), that is EventID for browser events and (partner, type, transaction ID) for postbacks. This matches P-4.
- The postback contract requires a transaction ID, because without it a redelivered Purchase and a second real Purchase on the same click look the same (spec: they are different cases; R-5, Q-6).
- partner_id may appear in URLs: it is an identifier, and postback authenticity rests on the partner's secret (ADR 0007).

## Verification

- The spec was re-read (`pdftotext requirements.pdf`): it asks us to propose the postback contract and does not fix its fields, and it states that a redelivered message and a second real purchase are different cases.
- `docs/requirements/proposals.md` P-4 and `docs/requirements/risks.md` R-4, R-5 already state the same keys, so no requirement file changed.
- The automated checks come with the implementation: TEST-3 in `requirements.md` (same postback twice counts once, two purchases count twice).
- Commit: `fbd3e73`, the first commit of the repository.
