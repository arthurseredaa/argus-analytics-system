# Example 2: Durable Objects, localStorage and Postgres for the operational store

- Date: 2026-11-02, 14:07 to 14:14 UTC
- Stage: 0, platform limits (Arthur's block 0 self-check before ADR 0003)

Quotes are copied verbatim from the session transcript. The conversation was in Ukrainian.

## Task given to the AI

Arthur was checking his one-line answers on when to use D1, Durable Objects, Queues and BigQuery. Claude had explained Durable Objects with the example "one object per user". Arthur pushed back twice: first with browser storage instead of a server-side object, then with a plain Postgres.

Arthur, 14:07:16 UTC:

> 2. Тобто під кожного юзера буде свій сервер? Звучить трохи як оверінженіринг, можемо відповіді користувача зберігати в localstorage, і читати звідти тоді в двох вкладках буде видно однаковий вибір (або sessionStorage)

Arthur, 14:11:46 UTC:

> 2. так а в чому сенс durable objects? чому проста база postgres не підійде? там будемо тримати інфу про юзерів, використовувати її для правил

Arthur, 14:14:09 UTC:

> Окей, і також треба буде записати що ми розглянули postgresql і чому відкинули і план міграції якщо вийдемо за межі D1

## What the AI proposed

Claude, 14:08:08 UTC:

> ### 2. Сервер під кожного юзера?
>
> Сумнів слушний, і для нашого випадку Durable Objects, найімовірніше, справді зайві. Але одне уточнення про «сервер». Ти нічого не запускаєш і не тримаєш. Cloudflare створює об'єкт у момент першого запиту, присипляє, коли запитів немає, і бере гроші тільки за запити й час роботи. Мільйон таких об'єктів не означає мільйон серверів, які треба адмініструвати.
>
> Тепер про localStorage. Для інтерфейсу ідея хороша: після перезавантаження сторінки квіз продовжиться з того кроку, де користувач зупинився. Але сховищем для правил він бути не може, і ось чому:
>
> - Lead нам повідомляє партнер постбеком, тобто запитом зі свого сервера на наш (PB-1, PB-4). Браузер користувача про цей Lead взагалі не дізнається, тож покласти його в localStorage просто нікому.
> - Офер обирає сервер. Дані з браузера користувач може підмінити, а правило «є Lead, отже йдемо на цей офер» на підмінених даних ламається.
> - localStorage прив'язаний до одного браузера. Зайде людина з телефону, і там буде порожньо.
> - sessionStorage свій у кожної вкладки, тому з ним дві вкладки якраз бачитимуть різне.
>
> Тож відповіді й Lead однаково треба тримати на сервері. Дві вкладки з D1 теж нормально уживуться: запис іде з унікальним ключем по користувачу і кроку, і пізніша відповідь просто замінює попередню. Остаточно це вирішуємо в ADR 0003, і варіант «тільки D1» там зараз найпростіший.

Claude, 14:12:10 UTC:

> Postgres тут цілком підійшов би, і ти по суті описав D1. D1 і є «проста SQL-база з інфою про юзерів для правил», тільки зроблена на SQLite і вбудована в Cloudflare. Тож питання не «Postgres чи Durable Objects», а «Postgres чи D1».
>
> ### Чому D1, а не Postgres
>
> Мова SQL, таблиці й ключі в обох однакові. Різниця в тому, де база живе.
>
> MVP деплоїться на Cloudflare, а Cloudflare не хостить Postgres. Його довелося б брати в іншого провайдера (Neon, Supabase, RDS) і підключати до Worker через мережу. Тоді з'являється ще один акаунт, ще один рахунок, ще одна річ, яку треба моніторити, і на кожному запиті мережевий стрибок до регіону, де стоїть база. Рев'юер прямо сказав, що цінує систему з малою кількістю сервісів, яку легко підтримувати. D1 підключається до Worker одним рядком конфігу, і жодного окремого сервісу.
>
> Де Postgres сильніший: він нормально тримає багато одночасних записів, і в нього немає межі 10 GB на базу. Якщо колись D1 стане тісною, Postgres буде реальним кандидатом на переїзд. Його варто внести рядком у таблицю варіантів ADR 0003 разом з ціною: окремий сервіс плюс мережева затримка. Рев'юер побачить, що варіант ми розглянули і відкинули з причиною.
>
> ### Тоді навіщо взагалі Durable Objects
>
> Вони закривають дві речі, яких одна база не дає.
>
> Перша: багато маленьких баз замість однієї. Одна база D1 пише в один потік і вміщує 10 GB. Durable Object має власну SQLite-базу до 10 GB і свій потік, тож тисяча об'єктів означає тисячу незалежних баз. Навантаження розходиться між ними саме, без ручного шардування.
>
> Друга: координація. Коли для одного id в кожен момент має відбуватися щось одне. Класичні приклади: чат-кімната, де всі повідомлення йдуть через один об'єкт у правильному порядку; лічильник лімітів; спільний документ, який редагують двоє. Об'єкт ще й може тримати дані в пам'яті між запитами, і з базою йому для цього ходити не треба.
>
> ### Що це означає для нас
>
> Факти для правил займають мало місця і пишуться рідко: відповіді, Lead, статус офера. Великий потік дають тільки події, і їх ми виносимо в BigQuery. Тому одна база D1, найімовірніше, впорається, і Durable Objects нам не знадобляться. В ADR вони будуть варіантом, який ми розглянули і відклали, з умовою, коли до нього повертатися: якщо одна база D1 перестане встигати з записами або наблизиться до 10 GB.
>
> Отже, для речення в блоці 0 можна взяти таку думку: «Durable Objects беру, коли одній базі стає тісно або коли для одного id треба строгий порядок операцій. У нас поки ні те, ні інше».

## Decision

- localStorage and sessionStorage as the store for rule facts: rejected. A Lead arrives as a server-to-server postback, so the browser never learns it; browser data can be forged; localStorage is tied to one browser; sessionStorage is per tab, so it would make two tabs disagree. localStorage stays possible for UI convenience only (resuming the quiz).
- Durable Objects: kept out for now. Arthur's "this sounds like overengineering" was accepted. One D1 database is expected to carry the rule facts, and Durable Objects become an option to return to when D1 stops keeping up with writes or approaches 10 GB.
- Postgres: Arthur asked to record it as a considered option and to write down why it was set aside and how we would migrate. Claude added it to the plan as a fourth option in ADR 0003 (one more provider to pay for and monitor, a network round trip on every request) with a migration section: the D1 numbers that trigger a move, the target (Postgres or Durable Objects) and the steps. The stage 4 alert thresholds for MVP-5 are tied to the same numbers.

## Verification

- `grep -c -i postgres docs/plans/part1-design-document.md` returns 1: the stage 1 line for ADR 0003 lists the Postgres option and the migration section.
- `docs/ai/plan-history.md` has the entry "2026-11-02: Postgres option and a migration path in ADR 0003".
- ADR 0003 itself is not written yet (block 1). This example is complete once the ADR contains the option row and the migration section.
- Commit: `fbd3e73`, the first commit of the repository.
