# Part 2 stage 1: identity, selection and the quiz, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a new user opens `/p/demo` on the deployed Worker, answers the three quiz steps and gets the right offer from the server; `select()` passes every row of the decision table.

**Architecture:** `select()` and the quiz flow functions are pure modules in `src/domain/`, tested in plain Node against the decision table and the catalog that `offer-selection.md` holds, read at test time. Routes in `src/routes/` take the UserID from a first-party cookie (ADR 0002), read and write facts in one D1 batch through `src/db/facts.ts`, and call `select()`. The quiz page is server-rendered HTML from `config/prelanders/demo.json`, with a small inline script that only shows steps and posts the completion.

**Tech Stack:** as stage 0 (TypeScript 5.9, Hono 4, Zod 4, wrangler 4.157, vitest 4 with `@cloudflare/vitest-plugin` 1.5.1), plus `@types/node` for the seed script. WebCrypto (AES-GCM, HMAC-SHA256) in both the Worker and Node 24.

**Spec:** [part2-mvp-stages.md](part2-mvp-stages.md), section "Stage 1". Read with it: [ADR 0002](../adr/0002-user-identity.md) (Decision), [ADR 0004](../adr/0004-offer-selection-semantics.md) (Decision, Shape of the selection code), [offer-selection.md](../requirements/offer-selection.md) (whole), [data-model.md](../design/data-model.md) ("Quiz completion", "Personal data", tables `users`, `user_answers`, `partners`, `catalog_history`, `offers`), and the cards named in each task in [acceptance-checks.md](../testing/acceptance-checks.md).

## Decisions by Arthur

1. Test routes on the deployed Worker: on for the demo (Arthur, 2026-11-04). There is one environment, so the deployed Worker is both production and the demo, and the demo script starts with `POST $BASE/__test/reset`; the stage 4 report totals (`{"lead":1,"purchase":1}`) only hold after a reset. `TEST_ROUTES` is `off` in `wrangler.jsonc` and CI deploys the demo with `--var TEST_ROUTES:on`; the R-12 `404` is proven by an integration test with the flag off, and the README says a production deploy drops the flag. Anyone can reset the demo, which holds synthetic data only. Rejected: off everywhere (stage 4 would have to filter the report to the demo user), and a token header from a third secret (reviewers would need the token).
2. Language of the quiz page: English throughout (Arthur, 2026-11-04), including the no-offer text, which is `No offer available`, the wording the decision table in offer-selection.md already uses. The spec gives that string in Ukrainian («Немає доступного офера») only because the spec is written in Ukrainian; the stage notes record the translation.

Settled here, each reversible: test partners are `partnerA` (offers 001 to 003, as in data-model.md's trace) and `partnerB` (004 to 007); the cookie is host-only (no `Domain`), because `workers.dev` is a public suffix and browsers reject a cookie scoped to it; `POST /api/complete` requires `prelander_id`, and the card helper `complete()` is updated to send it; local and remote use different keys (`.dev.vars` and `.dev.vars.remote`, both gitignored); the decision table is read through Vite's `?raw` import, so no test needs file system access.

## Global Constraints

- Everything committed is in English, the quiz page included. The no-offer text is `No offer available` (decision 2).
- No secrets, tokens, account ids, real emails or other personal data in any committed file. Tests use `user1@example.com`, `user2@example.com` and other `@example.com` addresses only. `.dev.vars.example` holds variable names and how to generate a value, never a value.
- The email never appears in a URL, a log line, an error response or `GET /__test/state`; the UserID never appears in a URL or a log line. Log lines are one JSON object each and name fields, never values from the request body.
- `MASTER_KEY` and `EMAIL_HASH_KEY` are Worker secrets: base64 of 32 random bytes (`openssl rand -base64 32`). Never in `wrangler.jsonc` or source. Tests get fixed test-only values through the vitest config bindings.
- Test names start with the requirement id, then any R-/Q- id, then plain words: `OFF-5 OFF-12 row 1 women+asia gives 003`. Unit tests (pure functions, plain Node) go in `tests/unit/`, integration tests (Workers runtime, `SELF.fetch` or `createApp(...).fetch`, local D1) in `tests/integration/`, shared helpers and parsers in `tests/fixtures/`.
- `select()` tests read their rows from the decision table in `offer-selection.md` at test time (P-9). No row is copied into a test file.
- Each file under a folder of `src/` (`src/domain/`, `src/db/`, `src/routes/`, `src/pages/`) opens with a comment of two or three lines naming the component, the ADR it implements and the requirement ids it serves.
- Raw SQL, no ORM; SQL strings live in `src/db/` only. Times are Unix milliseconds in UTC. A D1 batch is one transaction.
- No EPU value, offer name or offer URL in `src/` (OFF-2): catalog data lives in `config/catalog-v1.json`. No catalog data and no selection logic in the page's script (OFF-10).
- `Env` comes from `wrangler types`. Two hand-written augmentations of `Cloudflare.Env` are allowed: `src/secrets.d.ts` (the two secrets) and `tests/env.d.ts` (test-only bindings).
- Files imported by `scripts/` use erasable TypeScript only (no enums, no parameter properties, no namespaces) and import each other with explicit `.ts` extensions, because Node 24 runs the scripts by stripping types.
- No new runtime dependency. One new dev dependency: `@types/node`, latest 24.x at install time, pinned exactly.
- Run wrangler as `pnpm exec wrangler ...`.
- Work happens on branch `part2-stage-1`. Each task commits there. Nothing is pushed until Arthur approves the stage.

## Known setup traps

From stage 0, still true: the test package is `@cloudflare/vitest-plugin` (`cloudflareTest()`, `readD1Migrations()`, types at `@cloudflare/vitest-plugin/types`); `compatibility_date` stays `2026-11-03`; test-only bindings are declared by augmenting `Cloudflare.Env`; vitest includes only `tests/**/*.test.ts`; `wrangler types` needs `--strict-vars=false`.

New for this stage:
- `wrangler types` reads `.dev.vars`, so locally `Env` has the secrets and in CI it does not. Declaring them in `src/secrets.d.ts` keeps `pnpm typecheck` green in CI; identical duplicate declarations merge without error.
- workerd forbids `eval` and `new Function`, and V8's `JSON.parse` error message quotes part of the input. A body that fails to parse must be answered without logging `err.message`, or the email lands in the logs.
- Whether D1 state is shared between integration test files is not verified for plugin 1.5.1. Tests must not depend on it: each test makes its own user (a fresh `uid` cookie), never asserts global row counts, and a test that adds a catalog version adds one more that restores version 1's content before it ends.
- Two requests in a row inside workerd can see the same `Date.now()`. A test that needs a later `received_at` waits first (`await new Promise((r) => setTimeout(r, 5))`).
- `pnpm test -- -t "X"` may forward the `--` to vitest. Task 1 checks that the filter works in that form; if it does not, every command in this plan is run as `pnpm test -t "X"` and the stage notes say so.
- curl sends `Secure` cookies to `http://localhost` (since curl 7.79), so the card helpers work against `wrangler dev`.

## Review Focus

- A hostile completion body (not JSON, an extra `user_id`, an email of 300 characters) must get `400` or have the extra field ignored, write nothing under any other user, and never echo the email in the response or the logs. Task 4 tests all three.
- A missing or malformed `MASTER_KEY` or `EMAIL_HASH_KEY` on the deployed Worker must answer `500 {"error":"config_error"}`, write nothing and log the secret's name only, never store the email in plain text. Task 4 tests it with an env whose `MASTER_KEY` is `"not-base64"`.
- An unknown prelander, in the path or in the completion body, must give `404` or `400` and write nothing. Task 4 (body) and Task 5 (path) test it.
- An empty catalog (the remote database not seeded yet) must give `no_offer` with `catalog_version: null` and a logged configuration error, not a crash. Task 1 tests `select()` and `parseCatalog()` with no rows.
- A completion sent twice (retry, second tab) must leave one `users` row with the first `created_at`, and the answers and email of the later request. Task 4 tests it.

---

### Task 1: test projects, the decision table fixture and `select()`

**Files:**
- Create: `src/domain/catalog.ts`, `src/domain/select.ts`, `config/catalog-v1.json`, `tests/fixtures/decision-table.ts`, `tests/unit/select.test.ts`, `tests/unit/catalog.test.ts`
- Modify: `vitest.config.ts` (two projects), `tests/env.d.ts` (`*.md?raw` module), `tsconfig.json` (`resolveJsonModule: true`, `erasableSyntaxOnly: true`)

**Interfaces:**
- Produces, `src/domain/catalog.ts`:
  - `type Offer = { id: string; partnerId: string; name: string; ethnicity: string; genders: readonly string[]; epu: number; url: string; kind: "specialised" | "universal"; active: boolean }`
  - `type Catalog = { version: number | null; offers: readonly Offer[] }`
  - `type OfferRow = { id: string; partner_id: string; name: string; ethnicity: string; genders: string; epu: number; url: string; kind: string; active: number }` (the D1 row; `genders` is JSON text)
  - `type CatalogError = { offerId: string; problem: string }`
  - `parseCatalog(version: number | null, rows: readonly OfferRow[]): { catalog: Catalog; errors: CatalogError[] }`. A row is excluded and reported when `ethnicity` is not one of `asia`, `europe`, `latam`, `any`, `genders` is not a non-empty JSON array of `women`/`men`, `kind` is unknown, `epu` is not a finite number ≥ 0, or `url` does not start with `https://`.
- Produces, `src/domain/select.ts`:
  - `type Moment = "entry" | "completion" | "redirect"`
  - `type Facts = { answers: Readonly<Record<string, unknown>>; leads: readonly { offerId: string; acceptedAt: number }[]; purchases: readonly { offerId: string }[] }`
  - `type Reason = "lead_return" | "best_epu" | "fallback_universal" | "no_offer" | "quiz_needed"`
  - `type Selection = { action: "redirect" | "quiz" | "no_offer"; offerId: string | null; reason: Reason; catalogVersion: number | null }`
  - `select(facts: Facts, catalog: Catalog, moment: Moment): Selection`
- Produces, `config/catalog-v1.json`: `{ "version": 1, "note": string, "partners": [{ "id", "name" }], "offers": [{ "id", "partner_id", "name", "ethnicity", "genders": string[], "epu", "url", "kind", "active": true }] }` with the seven offers of the catalog table in offer-selection.md, `partnerA` owning 001 to 003 and `partnerB` 004 to 007.
- Produces, `tests/fixtures/decision-table.ts`: `parseCatalogTable(md: string): SpecOffer[]`, `parseDecisionTable(md: string): DecisionRow[]`, `applyChanges(catalog: Catalog, changes: readonly CatalogChange[]): Catalog`, `catalogV1(): Catalog` (from `config/catalog-v1.json`).

- [ ] **Step 1: Split vitest into two projects in `vitest.config.ts`.** `test.projects`: `{ test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } }` and `{ plugins: [cloudflareTest(...as today)], test: { name: "integration", include: ["tests/integration/**/*.test.ts"], setupFiles: ["./tests/setup.ts"], fileParallelism: false } }`. Integration files run one after another because Task 5's `/__test/reset` empties tables that other files may share. If the plugin does not load inside an inline project, move each into `vitest.unit.config.ts` and `vitest.integration.config.ts` and list both paths in `test.projects`; either way one `vitest run` runs both. Run `pnpm test`. Expected: the 6 stage 0 tests pass under project `integration`.
- [ ] **Step 2: Write the parser in `tests/fixtures/decision-table.ts`.** Parsing contract, so a reworded table fails loudly instead of passing silently:
  - Tables are found by heading: `## Catalog (from the spec)` and `## Decision table (expected results)`. The header row must equal `| ID | Name | Partner ethnicity | Partner gender | EPU, USD | URL | Kind |` and `| # | Answers | Lead | Catalog change | Expected | Reason | Source |`; otherwise throw.
  - Answers: the part before the first `, ` is `none`, `<g> only` or `<g> + <e>`, where `women`/`men` go to `gender` and `asia`/`europe`/`latam` to `ethnicity`. After it, `at entry` sets the moment to entry and ``email `x` `` sets `email` (row 26). Anything else throws.
  - Lead: `none`, `<id>` or `<id> then <id>`; Leads get `acceptedAt` 1000, 2000 in order.
  - Catalog change: `none`, `<id>[ and <id>] disabled`, `<id> removed`, `<id> EPU set to <decimal>`. Anything else throws.
  - Expected: a leading three-digit id gives `{ action: "redirect", offerId }`; `No offer available` gives `{ action: "no_offer", offerId: null }`; a cell starting with `quiz` gives `{ action: "quiz", offerId: null }`.
  - Reason: the first comma-separated token if it is `lead_return`, `best_epu`, `fallback_universal` or `no_offer`; `quiz_needed` when Expected is a quiz; otherwise throw.
  - Moments: rows with a Lead run at both `entry` and `completion`; rows with `at entry`, and row 24 (no answers, no Lead), run at `entry`; all others at `completion`.
  - Test name: `<card ids> row <n> <answers before the first comma, " + " as "+", other spaces as "-"> gives <offerId | quiz | no_offer>`, with ` at entry` or ` at completion` appended for rows that run at both moments.
- [ ] **Step 3: Write the failing tests.** `tests/unit/select.test.ts` imports the markdown with `import md from "../../docs/requirements/offer-selection.md?raw"` and holds the card map, the only per-row data in a test file:

```ts
const CARDS: Record<number, string[]> = {
  1: ["OFF-5", "OFF-12"], 2: ["OFF-5"], 3: ["OFF-5", "OFF-12"], 4: ["OFF-5"], 5: ["OFF-6", "OFF-12"],
  6: ["OFF-5", "OFF-12"], 7: ["OFF-6", "OFF-12"], 8: ["OFF-6", "OFF-12"], 9: ["OFF-8"], 10: ["OFF-5"],
  11: ["OFF-5"], 12: ["OFF-5"], 13: ["OFF-6"], 14: ["OFF-5"], 15: ["OFF-7"], 16: ["OFF-3", "OFF-12"],
  17: ["OFF-3"], 18: ["OFF-9"], 19: ["OFF-9"], 20: ["OFF-9"], 21: ["OFF-8", "OFF-9"], 22: ["OFF-4"],
  23: ["OFF-4"], 24: ["QZ-5"], 25: ["QZ-5"], 26: ["QZ-3"], 27: ["OFF-3"], 28: ["OFF-9"], 29: ["OFF-5"],
};
// for each parsed row and moment:
//   expect(select({ answers, leads, purchases: [] }, applyChanges(catalogV1(), change), moment))
//     .toEqual({ ...expected, catalogVersion: 1 });
```

Plus these cases:
  - `TEST-1 every decision table row is mapped to a card`: parsed row numbers equal `1..29` and the keys of `CARDS`; rows 1 to 15 and 29 map to one of OFF-5, OFF-6, OFF-7, OFF-8, OFF-12; rows 16 to 23, 27, 28 to one of OFF-3, OFF-4, OFF-9.
  - `OFF-4 Q-10 leads accepted at the same time go to the higher EPU`: Leads 001 and 004 both at 1000 give 004 `lead_return`; `OFF-4 Q-10 equal time and equal EPU go to the lower offer id`: with 001's EPU set to 1.10, give 001.
  - `OFF-12 select is pure`: deep-frozen inputs, two calls, equal results; and `select.ts` read with `?raw` has no import line other than `import type`.
  - `OFF-8 empty catalog gives no_offer with no version`: `select(women+asia, { version: null, offers: [] }, "completion")` equals `{ action: "no_offer", offerId: null, reason: "no_offer", catalogVersion: null }`.

`tests/unit/catalog.test.ts`:
  - `OFF-1 seed catalog equals the spec catalog`: `parseCatalogTable(md)` has 7 rows and equals `config/catalog-v1.json` offers on id, name, ethnicity, genders, epu, url, kind; all seven `active: true`.
  - `OFF-6 incomplete offer row is excluded and reported`: rows of version 1 with 006's `ethnicity` set to `""` give a catalog of six offers and `errors` equal to `[{ offerId: "006", problem: <any string> }]`; the row with `ethnicity` `"any"` and `kind` `"universal"` is kept.
  - `OFF-8 no rows give an empty catalog and no errors`: `parseCatalog(null, [])` gives `{ catalog: { version: null, offers: [] }, errors: [] }`.
- [ ] **Step 4: Run `pnpm test`.** Expected: the unit project fails, `src/domain/select.ts` cannot be resolved.
- [ ] **Step 5: Write `src/domain/catalog.ts` and `src/domain/select.ts`.** `select()` runs the seven steps of ADR 0004 "Shape of the selection code" in order. Pinned details: step 1 is an empty filter with a comment naming DES-5 and Q-20; Leads are kept when their offer is in the catalog and active, then ordered by `acceptedAt` descending, current EPU descending, offer id ascending; answers are sufficient when `gender` and `ethnicity` are both strings; a match is `kind === "specialised"`, `ethnicity` equal to the answer and `genders` containing the answer; the universal offer is the active offer with `kind === "universal"` (the lowest id if Q-7 ever allows several). Every result carries `catalog.version`.
- [ ] **Step 6: Run `pnpm test`, then `pnpm test -- -t "OFF-12"`.** Expected: all pass; the filtered run reports 9 tests (rows 1, 3, 5, 6, 7, 8 once, row 16 at both moments, and `OFF-12 select is pure`) and nothing else. If the filter does not apply, use `pnpm test -t "OFF-12"` and note it (Known setup traps).
- [ ] **Step 7: Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: exit 0.
- [ ] **Step 8: Commit** `feat: offer selection read from the decision table`.

### Task 2: quiz flow config

**Files:**
- Create: `src/domain/flow.ts`, `src/domain/prelanders.ts`, `config/prelanders/demo.json`, `tests/fixtures/flows/four-steps.json`, `tests/unit/flow.test.ts`

**Interfaces:**
- Produces, `src/domain/flow.ts`:
  - `type Condition = { if: string } | { some: readonly Condition[] } | { not: Condition }`, evaluated against the answer of the step that holds it
  - `type Next = string | null | { branches: readonly { when: Condition; goto: string }[]; otherwise: string | null }`
  - `type Step = { key: string; kind: "choice" | "email"; wording: string; options?: readonly { value: string; label: string }[]; next: Next }`
  - `type Flow = { prelander: string; first: string; steps: readonly Step[] }`
  - `parseFlow(json: unknown): Flow`: Zod schema plus checks: step keys unique, `first` and every `next`/`goto` name an existing step, choice steps have at least one option, exactly one email step and its `next` is `null`, no cycle. Throws an `Error` naming the path of the problem.
  - `evaluateCondition(condition: Condition, value: string): boolean`
  - `resolveNext(step: Step, value: string | undefined): string | null`
  - `nextStep(flow: Flow, answers: Readonly<Record<string, string>>): string | null`: the first step on the path from `first` without an answer in `answers`, or `null` at the end. The email step is never in `answers`, so after the choice steps it returns `"email"`.
  - `wording(step: Step, answers: Readonly<Record<string, string>>): string`: replaces `{key}` with the answer's value; an unknown placeholder stays as is.
  - `validateAnswers(flow: Flow, answers: Readonly<Record<string, unknown>>): { ok: true; answers: Record<string, string> } | { ok: false; fields: string[] }`: walks the path; every choice step on it needs a string answer among its option values, and any key not on the path is an error. Field names are `answers.<key>`.
- Produces, `src/domain/prelanders.ts`: `prelanderFlows: ReadonlyMap<string, Flow>`, built at module load with `parseFlow` from each JSON under `config/prelanders/`, keyed by `prelander`. A second prelander is a new JSON and one import line here.
- Produces, `config/prelanders/demo.json`: prelander `demo`, first `gender`. Step `gender`: wording `Who would you like to meet?`, options `women` (`Women`), `men` (`Men`), next `ethnicity`. Step `ethnicity`: wording `Where should the {gender} you meet come from?`, options `asia` (`Asia`), `europe` (`Europe`), `latam` (`Latin America`), next `email`. Step `email`: kind `email`, wording `Your email address`, next `null`.
- Produces, `tests/fixtures/flows/four-steps.json`: the demo flow with prelander `four` and a step `age` (options `18-29`, `30-44`, `45+`) between `ethnicity` and `email`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/flow.test.ts`, on the parsed `demo.json`:
  - `QZ-1 step 1 asks for the partner's gender with women and men`: step `gender` options are exactly `["women", "men"]` and its wording does not contain `your gender`.
  - `QZ-2 wording after women`: `wording(ethnicity, { gender: "women" })` is `Where should the women you meet come from?`; `QZ-2 wording after men` gives the `men` sentence; `QZ-2 step 2 wording follows the step 1 answer`: the two differ.
  - `QZ-2 accepts asia, europe and latam` and `QZ-2 rejects africa`: `validateAnswers` with `{ gender: "women", ethnicity: "africa" }` gives `{ ok: false, fields: ["answers.ethnicity"] }`.
  - `QZ-1 rejects other values`: `gender: "robots"` gives `fields: ["answers.gender"]`; `QZ-1 rejects an unknown key`: an extra `colour` gives `fields: ["answers.colour"]`; a missing `ethnicity` gives `fields: ["answers.ethnicity"]`.
  - `QZ-7 nextStep walks the flow`: `{}` gives `gender`, `{ gender: "men" }` gives `ethnicity`, both answers give `email`.
  - `QZ-7 evaluateCondition handles if, some and not`: `{ if: "asia" }` on `asia` true; `{ some: [{ if: "asia" }, { if: "europe" }] }` on `latam` false; `{ not: { if: "asia" } }` on `latam` true.
  - `QZ-7 a branch on the step's own answer picks the next step`: a flow whose `gender` step has `branches: [{ when: { if: "men" }, goto: "email" }], otherwise: "ethnicity"`; `nextStep` with `{ gender: "men" }` gives `email`, and `validateAnswers` with only `gender: "men"` is ok.
  - `QZ-7 a fourth step in the flow config is required and validated`: the parsed `four-steps.json` makes `age` required and rejects `age: "99"`.
  - `QZ-7 a flow whose next names a missing step is rejected`, `QZ-7 a flow with a cycle is rejected`: `parseFlow` throws.
- [ ] **Step 2: Run `pnpm test -- -t "QZ-"`.** Expected: FAIL, `src/domain/flow.ts` cannot be resolved.
- [ ] **Step 3: Write `src/domain/flow.ts`, `src/domain/prelanders.ts` and the two JSON files.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0.
- [ ] **Step 5: Commit** `feat: quiz flow as data`.

### Task 3: crypto, secrets and the seed

**Files:**
- Create: `src/domain/crypto.ts`, `src/secrets.d.ts`, `src/db/seed.ts`, `scripts/seed.ts`, `tsconfig.scripts.json`, `tests/fixtures/facts.ts`, `tests/unit/crypto.test.ts`, `tests/unit/seed.test.ts`, `tests/integration/seed.test.ts`
- Modify: `package.json` (script `seed`: `node scripts/seed.ts`; `typecheck` appends `&& tsc --noEmit -p tsconfig.scripts.json`; `lint` covers `scripts`; dev dependency `@types/node`), `tsconfig.json` (`allowImportingTsExtensions: true`), `vitest.config.ts` (bindings), `tests/env.d.ts`, `tests/setup.ts`, `.dev.vars.example`

**Interfaces:**
- Produces, `src/domain/crypto.ts` (WebCrypto only, so it runs in the Worker and in Node):
  - `class ConfigError extends Error` (its message names the variable, never its value)
  - `importAesKey(base64: string, name: string): Promise<CryptoKey>` and `importHmacKey(base64: string, name: string): Promise<CryptoKey>`: throw `ConfigError` unless the value decodes to exactly 32 bytes
  - `encrypt(key: CryptoKey, plaintext: string): Promise<string>`: AES-GCM, random 12-byte IV, returns `v1:<iv base64>:<ciphertext base64>`
  - `decrypt(key: CryptoKey, token: string): Promise<string>`
  - `emailHash(key: CryptoKey, email: string): Promise<string>`: 64 lower-case hex chars of HMAC-SHA256 over `email.trim().toLowerCase()`
- Produces, `src/db/seed.ts`:
  - `type CatalogFile` (the shape of `config/catalog-v1.json`), `type Statement = { sql: string; params: (string | number | null)[] }`
  - `seedStatements(file: CatalogFile, partnerSecretsEnc: ReadonlyMap<string, string>, now: number): Statement[]`: partners, then `catalog_history` (`changed_by` `seed`), then offers; every insert `ON CONFLICT DO NOTHING`, so seeding twice changes nothing
  - `renderSql(statements: readonly Statement[]): string`: one SQL file with values inlined (strings single-quoted with `'` doubled, numbers as is, `null` as `NULL`)
- Produces, `tests/fixtures/facts.ts`: `TEST_PARTNER_SECRETS: ReadonlyMap<string, string>` (`partnerA` → `test-partner-a-secret`, `partnerB` → `test-partner-b-secret`), `seedFacts(db: D1Database): Promise<void>`.
- Produces: `src/secrets.d.ts` augments `Cloudflare.Env` with `MASTER_KEY: string` and `EMAIL_HASH_KEY: string`. `vitest.config.ts` adds bindings `MASTER_KEY: btoa("test-only-master-key-32-bytes!!!")`, `EMAIL_HASH_KEY: btoa("test-only-email-hash-key-32byte!")`, `TEST_ROUTES: "on"`. `tests/setup.ts` calls `seedFacts(env.FACTS)` after the migrations.
- `.dev.vars.example` lists `MASTER_KEY`, `EMAIL_HASH_KEY`, `PARTNER_SECRET_PARTNERA`, `PARTNER_SECRET_PARTNERB` and `TEST_ROUTES=on`, each secret with the comment `# openssl rand -base64 32` and an empty value.

- [ ] **Step 1: Write the failing tests.** `tests/unit/crypto.test.ts`:
  - `DEMO-8 P-5 email encrypts to v1 ciphertext and decrypts back`: `encrypt(k, "user1@example.com")` matches `/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/`, does not contain `user1`, and `decrypt` returns the input.
  - `DEMO-8 P-5 two encryptions of one email differ`.
  - `DEMO-8 P-5 ciphertext under another key does not decrypt`: rejects.
  - `DEMO-8 P-5 email hash ignores case and surrounding spaces`: `emailHash(h, " User1@Example.com ")` equals `emailHash(h, "user1@example.com")` and matches `/^[0-9a-f]{64}$/`.
  - `DEMO-8 a key that is not 32 bytes is a config error that does not show the value`: `importAesKey("not-base64", "MASTER_KEY")` rejects with a `ConfigError` whose message contains `MASTER_KEY` and not `not-base64`.

  `tests/unit/seed.test.ts`:
  - `OFF-1 seed statements insert one catalog version and the seven offers`: 2 partner, 1 `catalog_history` and 7 offer statements; every `sql` contains `ON CONFLICT`; the offer params carry the JSON's values with `genders` as JSON text and `active` as `1`.
  - `OFF-1 rendered seed SQL quotes strings and holds no plain partner secret`: `renderSql` of a statement with param `O'Brien` contains `'O''Brien'`; the rendered seed contains neither `test-partner-a-secret` nor `test-partner-b-secret`.

  `tests/integration/seed.test.ts`:
  - `OFF-1 seeded catalog version 1 has the seven offers, all active`: `SELECT id, epu, active FROM offers WHERE version = 1 ORDER BY id` gives ids `001`..`007`, EPUs `0.8, 0.65, 0.95, 1.1, 0.7, 0.6, 0.5`, all `active = 1`.
  - `OFF-1 seeding twice changes nothing`: `seedFacts` again; counts of `partners`, `catalog_history`, `offers` unchanged.
  - `PB-3 partner secrets are stored encrypted`: both `secret_current_enc` start with `v1:` and decrypt under `env.MASTER_KEY` to the test secrets.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL, `src/domain/crypto.ts` cannot be resolved.
- [ ] **Step 3: Write `src/domain/crypto.ts`, `src/db/seed.ts`, `src/secrets.d.ts`, `tests/fixtures/facts.ts`, the binding and setup changes.** Run `pnpm test`. Expected: all pass.
- [ ] **Step 4: Write `scripts/seed.ts` and `tsconfig.scripts.json`.** `tsconfig.scripts.json` extends the root config with `types: ["node"]` and `include: ["scripts"]`. The script takes exactly one of `--local` or `--remote`, loads `.dev.vars` or `.dev.vars.remote` with `process.loadEnvFile`, and exits 1 naming the first missing variable (`MASTER_KEY`, `PARTNER_SECRET_<PARTNER ID IN UPPER CASE>` per partner of the JSON). It encrypts the partner secrets, writes `renderSql(...)` to a file in a fresh `fs.mkdtempSync(os.tmpdir() + "/seed-")` directory, runs `pnpm exec wrangler d1 execute facts --local|--remote --file <path>`, deletes the directory in `finally`, and prints the offer count of version 1. It imports `../src/domain/crypto.ts` and `../src/db/seed.ts` with the extension, and reads `config/catalog-v1.json` with `fs.readFileSync` and `JSON.parse`, never with `import` (Node 24 refuses a JSON import without `with { type: "json" }`).
- [ ] **Step 5: Check the seed locally.** Create a gitignored `.dev.vars` from the example with fresh `openssl rand -base64 32` values, then `pnpm migrate:local`, `pnpm seed --local` twice, and `pnpm exec wrangler d1 execute facts --local --command "SELECT version, COUNT(*) AS n, SUM(active) AS active FROM offers GROUP BY version"`. Expected: both seed runs exit 0 and print 7; the query prints one row `1 | 7 | 7`. `git status` does not list `.dev.vars`.
- [ ] **Step 6: Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm test`.** Expected: exit 0, all pass. Then `mv .dev.vars /tmp/devvars.bak && pnpm typecheck; mv /tmp/devvars.bak .dev.vars`. Expected: typecheck still passes without `.dev.vars`, as in CI.
- [ ] **Step 7: Commit** `feat: email and partner secret encryption, catalog seed`.

### Task 4: identity cookie, facts and `POST /api/complete`

**Files:**
- Create: `src/app.ts`, `src/routes/identity.ts`, `src/routes/complete.ts`, `src/db/facts.ts`, `tests/fixtures/http.ts`, `tests/integration/identity.test.ts`, `tests/integration/complete.test.ts`, `tests/integration/catalog-version.test.ts`
- Modify: `src/index.ts` (`export const app = createApp(prelanderFlows)`; the default export keeps `fetch: app.fetch`, `queue`, `scheduled`)

**Interfaces:**
- Consumes: `select`, `parseCatalog`, `Catalog`, `Facts` (Task 1); `validateAnswers`, `prelanderFlows`, `Flow` (Task 2); `importAesKey`, `importHmacKey`, `encrypt`, `emailHash`, `ConfigError` (Task 3); `seedStatements`, `seedFacts` (Task 3).
- Produces, `src/app.ts`: `type AppEnv = { Bindings: Env; Variables: { userId: string; returning: boolean } }` and `createApp(flows: ReadonlyMap<string, Flow>): Hono<AppEnv>`, which mounts `/healthz`, the identity middleware on `/p/*`, `/api/*` and `/__test/*`, and the routes. `app.onError` logs `{"msg":"unhandled","name":err.name}` only and answers `500 {"error":"internal"}`.
- Produces, `src/routes/identity.ts`: `identity(): MiddlewareHandler<AppEnv>`. Cookie name `uid`. A value matching `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/` is kept (`returning: true`); anything else is replaced by `crypto.randomUUID()`. Before `next()`, every response gets `Set-Cookie` with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=34560000`, no `Domain`.
- Produces, `src/db/facts.ts`:
  - `type FactsRead = { facts: Facts; catalog: Catalog; catalogErrors: CatalogError[]; userExists: boolean }`
  - `readFacts(db: D1Database, userId: string): Promise<FactsRead>`: one `db.batch` of the user, answers, Leads (the data-model query), Purchases and the current catalog (`MAX(version)` of `catalog_history`)
  - `completeQuiz(db: D1Database, w: { userId: string; emailEnc: string; emailHash: string; answers: Readonly<Record<string, string>>; receivedAt: number }): Promise<FactsRead>`: one `db.batch` that upserts `users` and one `user_answers` row per answer with the statements of data-model.md (values stored as `JSON.stringify(value)`), then runs the same reads. `select()` runs on the answers read back, so a request that lost the `received_at` race selects on the stored answers.
- Produces, `POST /api/complete` in `src/routes/complete.ts`. Body: `{ prelander_id: string, visit_id?: string, answers: Record<string, unknown>, email: string }`; unknown fields are stripped (a body `user_id` is ignored). Order: read the body as text and `JSON.parse` it in a `try` that logs nothing about the error; Zod; flow lookup; `validateAnswers`; email check (`trim()`, length 3 to 254, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`); keys; encrypt and hash; `completeQuiz` with `receivedAt = Date.now()`; log each catalog error as `{"msg":"catalog_config_error","offer_id","problem"}` and an empty catalog as `{"msg":"catalog_empty"}`; `select(..., "completion")`.
  - `200 {"offer_id","name","url","reason","catalog_version"}`; for `no_offer` and `quiz_needed`, `offer_id`, `name` and `url` are `null`.
  - `400 {"error":"invalid_body","fields":[...]}` for bad JSON (`fields: []`), schema, answers or email (`fields: ["email"]`), with a log line `{"msg":"complete_rejected","fields":[...]}`. `400 {"error":"unknown_prelander"}`. `500 {"error":"config_error"}` with `{"msg":"config_error","name":"MASTER_KEY"}` on a `ConfigError`. None of these writes to D1.
- Produces, `tests/fixtures/http.ts`: `newCookie(): string` (`uid=<random uuid>`), `cookieFrom(res: Response): string`, `postComplete(body: unknown, cookie?: string, app?: Hono<AppEnv>, envOverride?: Partial<Env>): Promise<Response>`; with `app`, it calls `app.fetch(req, { ...env, ...envOverride }, createExecutionContext())`, otherwise `SELF.fetch`.

- [ ] **Step 1: Write the failing tests.** The default body is `{ prelander_id: "demo", answers: { gender: "women", ethnicity: "asia" }, email: "user1@example.com" }`.

  `tests/integration/identity.test.ts` (on `POST /api/complete` here; Task 5 repeats the first three on `GET /p/demo`):
  - `ID-2 cookie is HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=34560000`: `Set-Cookie` matches `/^uid=<the UUID regex>;/` and contains each attribute; it has no `Domain`.
  - `ID-2 second visit with the same cookie keeps the user id`, `ID-2 R-1 visit without the cookie creates a new user`, `ID-2 malformed cookie value is replaced` (`uid=not-a-uuid` gets a new valid id).
  - `ID-2 user id in the completion body is ignored`: body with `user_id` set to another UUID gives `200`; `users` has the cookie's id and not the body's.
  - `ID-1 complete creates the users row`: one row for the cookie's id with `created_at = last_completed_at`.

  `tests/integration/complete.test.ts`:
  - `DEMO-2 new user gets 003 for women+asia`: body equals `{ offer_id: "003", name: "Asia Connect", url: "https://asia-connect.example", reason: "best_epu", catalog_version: <number> }`.
  - `OFF-10 complete returns name and url of the chosen offer`: men+europe gives `{ offer_id: "005", name: "Europe Connect", url: "https://europe-connect.example" }` and no other keys besides `reason` and `catalog_version`.
  - `QZ-1 accepts women`, `QZ-1 accepts men`: `user_answers` holds `gender` = `"\"women\""` / `"\"men\""`.
  - `QZ-1 rejects other values and stores nothing`: `gender: "robots"` gives `400` with `fields: ["answers.gender"]` and no `users` row for the cookie.
  - `QZ-2 accepts asia, europe and latam`: three users, `ethnicity` stored as `"\"asia\""`, `"\"europe\""`, `"\"latam\""`. `QZ-2 rejects africa`: `400`, nothing stored.
  - `QZ-3 same answers with different emails give the same offer`: `user1@example.com` and `user2@example.com` both get 003 `best_epu`; the two `email_hash` values differ.
  - `QZ-3 row 26 email creates no Lead`: after completion, the Leads query for the user returns no rows and `conversions` gained nothing for the user's clicks.
  - `DEMO-8 email is stored encrypted`: `email_enc` starts with `v1:`, does not contain `user1`, and decrypts to `user1@example.com`; `email_hash` is `emailHash` of it.
  - `QZ-4 Q-4 latest completion received wins`: women+asia, wait 5 ms, men+asia with `user2@example.com`; `gender` is `"\"men\""`, `email_enc` decrypts to `user2@example.com`, `created_at` is unchanged and `last_completed_at` grew; one `users` row.
  - `QZ-1 unknown prelander in the body is rejected`: `prelander_id: "nope"` gives `400 {"error":"unknown_prelander"}` and no row.
  - `QZ-1 an email of 300 characters is rejected`: `400` with `fields: ["email"]`.
  - `R-12 malformed completion body with an email is rejected without logging the email`: with `vi.spyOn` on `console.log`, `console.error`, `console.warn`, send through `createApp(prelanderFlows)` the raw text `{"answers":{"gender":"women"},"email":"user2@example.com"` (cut short), then a body with `email: "user2@example"`; both answer `400`, neither response text nor any captured call argument contains `user2@example`, and no captured call contains the cookie's UUID.
  - `R-12 exception path redacts the request body`: with `envOverride: { MASTER_KEY: "not-base64" }`, a valid body answers `500 {"error":"config_error"}`, captured logs contain `MASTER_KEY` and not `user1@example.com`, and no `users` row exists for the cookie.

  `tests/integration/catalog-version.test.ts`:
  - `OFF-2 EPU change takes effect without deploy`: insert version `v+1` (where `v` is the current max) as a copy of version 1 with 001's EPU at 0.95, through `seedStatements` on a modified `CatalogFile`; women+asia gives `001` `best_epu` with `catalog_version: v+1` (row 14). Then insert `v+2` equal to version 1; women+asia gives `003`.
- [ ] **Step 2: Run `pnpm test -- -t "ID-|QZ-|OFF-2|OFF-10|DEMO-2|DEMO-8|R-12"`.** Expected: the new integration tests FAIL with `404`.
- [ ] **Step 3: Write `src/app.ts`, `src/routes/identity.ts`, `src/db/facts.ts`, `src/routes/complete.ts`; switch `src/index.ts` to `createApp`.**
- [ ] **Step 4: Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`.** Expected: all pass, exit 0; `DLV-1 healthz returns the commit sha` still passes.
- [ ] **Step 5: Commit** `feat: identity cookie and quiz completion with selection`.

### Task 5: the prelander page, test routes and the DEMO-2 path

**Files:**
- Create: `src/routes/prelander.ts`, `src/routes/test.ts`, `src/pages/quiz.ts`, `tests/integration/prelander.test.ts`, `tests/integration/test-routes.test.ts`
- Modify: `src/app.ts` (mount both routes), `wrangler.jsonc` (`vars.TEST_ROUTES: "off"` with a comment naming R-12 and decision 1, test routes on for the demo), `.github/workflows/ci.yml` (deploy step adds `--var TEST_ROUTES:on`, with a comment that this is the demo deployment), `docs/testing/acceptance-checks.md` (the `complete()` helper and the completion row of the endpoints table send `"prelander_id":"demo"`; card OFF-8 expects the page text `No offer available`; card ID-2 says `Secure` on the deployed Worker instead of "on staging"; the test state row of the conventions table and card R-12 say the test routes answer `404` unless `TEST_ROUTES` is `on`, the deployed demo has it on (decision 1), and R-12 manual step 4 becomes `pnpm test -- -t "R-12 test endpoints answer 404"`), `docs/requirements/offer-selection.md` (last paragraph: the UI text for `no_offer` is `No offer available`, the English rendering of the spec's «Немає доступного офера», decision 2), `docs/adr/0002-user-identity.md` (status stays `proposed`; one sentence added to Decision option 1: on `workers.dev`, a public suffix, the cookie is host-only with no `Domain`, and the registrable-domain cookie applies once prelanders run on our own domain)

**Interfaces:**
- Consumes: `createApp`, `AppEnv`, `identity` (Task 4); `readFacts` (Task 4); `select` (Task 1); `Flow`, `resolveNext`, `parseFlow` (Task 2); `seedFacts` (Task 3).
- Produces, `GET /p/:prelander` in `src/routes/prelander.ts`: unknown prelander gives `404` text `Not found`. A request without a valid cookie touches no D1 table. With a valid cookie, `readFacts` and `select(..., "entry")`. A `redirect` result is logged as `{"msg":"entry_redirect_deferred","reason"}` and the quiz is rendered, with a comment that stage 3 writes the click and answers `302` here. Answers `200`, `content-type: text/html; charset=utf-8`, `cache-control: no-store`.
- Produces, `src/pages/quiz.ts`: `renderQuizPage(flow: Flow, prelanderId: string): string`. One `<section data-step="<key>">` per step, all but `first` `hidden`. Each choice option is a `<button data-value="<value>" data-next="<resolveNext(step, value) or empty>">`; `{key}` in a wording becomes `<span data-answer="<key>"></span>`; every config string is HTML-escaped. A result section shows the offer name and URL as text with a link `/go/<offer_id>?prelander=<prelanderId>`, and a no-offer section holds `No offer available`. The inline script (no build, no framework) records the answer, fills `[data-answer]` spans with `textContent`, shows the `data-next` step, and on the email step sends one `POST /api/complete` with `{ prelander_id, answers, email }`. It holds no catalog, EPU or selection logic.
- Produces, `src/routes/test.ts`: when `c.env.TEST_ROUTES !== "on"`, both routes answer `404`. `GET /__test/state` answers `{ me: { user_id, user: { created_at, last_completed_at, email_hash } | null, answers: Record<string, unknown> }, catalog: { version, offers: number }, counts: { users, clicks, conversions }, partner_secrets_ok: boolean }`; never `email_enc` and never a secret. `partner_secrets_ok` is `true` when there is at least one partner and every `secret_current_enc` decrypts under `MASTER_KEY`, `false` otherwise (a failed decrypt or a `ConfigError` gives `false`, not `500`). It catches a `.dev.vars.remote` whose `MASTER_KEY` differs from the Worker secret before stage 3 signs postbacks. `POST /__test/reset` deletes from `conversions`, `clicks`, `quarantine`, `users` (answers cascade) and `events` in the `EVENTS` database, keeps `partners`, `catalog_history` and `offers`, answers `{"ok":true}`.

- [ ] **Step 1: Write the failing tests.** `tests/integration/prelander.test.ts`:
  - `ID-1 first visit sets a user id cookie and writes no D1 row`: `GET /p/demo` gives `200` and a `uid` cookie; `users` has no row for it.
  - `ID-2 cookie is HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=34560000 on the page`, `ID-2 second visit with the same cookie keeps the user id`, `ID-2 malformed cookie value is replaced`, on `GET /p/demo`.
  - `QZ-7 the demo page holds the three steps and posts once to /api/complete`: three `data-step=` sections (`gender`, `ethnicity`, `email`), `/api/complete` appears once, `cache-control` is `no-store`.
  - `QZ-1 step 1 offers women and men`: `data-value="women"` and `data-value="men"` in the `gender` section.
  - `QZ-2 step 2 wording on the page is filled from the step 1 answer`: the `ethnicity` section contains `<span data-answer="gender"></span>`.
  - `OFF-8 page shows the no-offer text`: the HTML contains `No offer available`.
  - `OFF-10 page script holds no catalog or selection logic`: the HTML contains no offer name and no offer URL from `config/catalog-v1.json`, and not `epu` in any letter case.
  - `QZ-1 unknown prelander gives 404`: `GET /p/nope` is `404`.
  - `QZ-5 Q-1 entry after completion without a Lead shows an empty quiz`: complete as women+asia, then `GET /p/demo` with the same cookie gives `200` with the `gender` section visible and no `selected` or `checked` attribute.
  - `QZ-7 a fourth step added to the flow config renders and is validated without a code change`: `app = createApp(new Map([["four", parseFlow(fourSteps)]]))`; `GET /p/four` has four `data-step` sections including `age` with `18-29`, `30-44`, `45+`; completion with `age: "30-44"` gives `200` and `user_answers` holds `age` = `"\"30-44\""`; without `age` gives `400` with `fields: ["answers.age"]`.
  - `DEMO-2 new user takes the quiz and gets 003`: `GET /p/demo`, then completion with the page's cookie and women+asia gives `{ offer_id: "003", reason: "best_epu" }`.

  `tests/integration/test-routes.test.ts`:
  - `ID-1 test state shows the caller's user id and no users row before completion`.
  - `R-12 test state never shows the email or its ciphertext`: after completion, the state text contains neither `user1@example.com` nor `v1:`.
  - `R-12 test endpoints answer 404 in production`: through `createApp` with `TEST_ROUTES: "off"`, `GET /__test/state` and `POST /__test/reset` give `404`.
  - `PB-3 test state confirms partner secrets decrypt under the worker key`: after the seed, `partner_secrets_ok` is `true`; through `createApp` with `envOverride: { MASTER_KEY: btoa("another-test-only-key-32-bytes!!") }` it is `false` and the answer is `200`.
  - `DEMO-2 reset clears users and keeps the catalog`: after completion and reset, the user's row is gone and `catalog.offers` is still 7.
- [ ] **Step 2: Run `pnpm test -- -t "ID-1|QZ-|OFF-8|OFF-10|DEMO-2|R-12"`.** Expected: the new tests FAIL with `404`.
- [ ] **Step 3: Write `src/pages/quiz.ts`, `src/routes/prelander.ts`, `src/routes/test.ts`; mount them; change `wrangler.jsonc`, `ci.yml`, acceptance-checks.md, offer-selection.md and ADR 0002 as listed under Files.** Then `grep -n "Немає" docs/testing/acceptance-checks.md src config` and `grep -n "on staging\|production url" docs/testing/acceptance-checks.md` print nothing.
- [ ] **Step 4: Run the gate:** `pnpm typecheck && pnpm lint && pnpm fmt:check && pnpm test`. Expected: exit 0, all pass.
- [ ] **Step 5: Check the page against `wrangler dev`.** With `.dev.vars` from Task 3 and the local seed, run `pnpm dev`, then from acceptance-checks.md "Environment" and helpers: `curl -s -c $JAR -b $JAR -o /dev/null -w '%{http_code}\n' $BASE/p/demo` and `complete $JAR women asia user1@example.com | jq -c '{offer_id,reason}'`. Expected: `200`, then `{"offer_id":"003","reason":"best_epu"}`. Open `$BASE/p/demo` in a browser, answer women, read step 2, answer asia and the email. Expected: step 2 reads `Where should the women you meet come from?`, the page shows `Asia Connect` and `https://asia-connect.example`, the network tab shows one page load and one `POST /api/complete`.
- [ ] **Step 6: Run the stage checks.** `pnpm test -- -t "OFF-5|OFF-6|OFF-7|OFF-8|OFF-12"` (TEST-1); `pnpm test -- -t "QZ-|ID-1|ID-2|OFF-1|OFF-2|OFF-10|DEMO-2|R-12"`; `grep -rnE "0\.(95|80|65|70|60|50)|1\.10" src/` (OFF-2); `grep -rnE "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}" src tests config scripts | grep -v "@example\.com"`; `for f in src/*/*.ts; do head -3 "$f" | grep -q "ADR" || echo "$f"; done`. Expected: both test runs pass and the first includes a test for each of rows 1 to 15 and 29; the three commands print nothing.
- [ ] **Step 7: Commit** `feat: quiz page, entry selection and test routes`.

### After the tasks: Arthur's part and closing

- [ ] Remote secrets, before the merge so the first deploy can complete a quiz. Why: the deployed Worker needs its own keys for the email and partner secrets, and they must never be committed or shared with local runs. What: `openssl rand -base64 32` twice, then `pnpm exec wrangler secret put MASTER_KEY` and `pnpm exec wrangler secret put EMAIL_HASH_KEY`, pasting each value at the prompt. Verify: `pnpm exec wrangler secret list` shows both names.
- [ ] `.dev.vars.remote`. Why: `pnpm seed --remote` encrypts the partner secrets under the remote `MASTER_KEY`, and stage 3's `pnpm postback` signs with the same partner secrets. What: a file with the same `MASTER_KEY` as above and two fresh `PARTNER_SECRET_PARTNERA` and `PARTNER_SECRET_PARTNERB` values. Verify: `git status --ignored` lists it as ignored, never as untracked; after the remote seed below, `state $JAR` against `BASE` shows `"partner_secrets_ok": true`. If it shows `false`, the two `MASTER_KEY` values differ: put the Worker's value into the file and seed again.
- [ ] Explain back: Arthur walks decision table rows 5 and 7 through `select()`, and says what changes in the repository when a fourth question is added (one step object in `demo.json`, no migration, `select()` only if the answer takes part in selection).
- [ ] Approval. Squash-merge `part2-stage-1` into `main` as `feat: identity, offer selection and the quiz`, with `docs/state/progress.json` (stage 1 done, stage 2 next, decisions 1 and 2 and the English no-offer text in `notes`), the "What to show at the review" row for stage 1 checked against what was built, the Outcome of ADR 0002 (the date, the host-only cookie on `workers.dev`, the ID-2 tests that passed), and a `docs/ai/plan-history.md` entry if decision 1 or 2 changed the plan; push.
- [ ] After CI deploys: `pnpm seed --remote`, then `pnpm exec wrangler d1 execute facts --remote --command "SELECT version, COUNT(*) AS n, SUM(active) AS active FROM offers GROUP BY version"`. Expected: one row `1 | 7 | 7`.
- [ ] DEMO-2 against `BASE` (the workers.dev URL): `curl -s $BASE/healthz` prints the merge commit's sha; `curl -s -c $JAR -b $JAR -o /dev/null -w '%{http_code}\n' $BASE/p/demo` prints `200`; `complete $JAR women asia user1@example.com | jq -c '{offer_id,reason}'` prints `{"offer_id":"003","reason":"best_epu"}`. The block's `answer` lines need `POST /api/events` and wait for stage 2. `state $JAR` shows the user with `email_hash`, no email, and `"partner_secrets_ok": true`. Paste the outputs into the stage notes.
