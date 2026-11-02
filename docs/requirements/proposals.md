# Proposals

Ideas beyond the letter of the spec that would make the design easier to defend. Each one still needs a decision; the ones we keep become ADRs or design sections.

| ID | Proposal | Why | Cost |
|---|---|---|---|
| P-1 | Keep two stores apart: a small operational store with the facts the rules need (current answers, Leads, offer status), and an append-only event log that feeds analytics and BigQuery. | Offer selection must not depend on BigQuery (NFR-4) and needs fresh Leads within seconds (A-4). | Two write paths to keep consistent. |
| P-2 | Generate a random click ID for every offer click, pass it to the partner as a sub-ID in the redirect URL, and require it back in the postback. | Correlates a postback with click, user and offer without exposing the UserID or the email. | Partners must support a sub-ID parameter (Q-6). |
| P-3 | Store the selection reason (`lead_return`, `best_epu`, `fallback_universal`, `no_offer`) and the catalog version in the offer-selected event. | Every redirect can be explained later; EPU from real data and debugging get easier. | A few bytes per event. |
| P-4 | Idempotency keys everywhere: EventID for client events, (partner, type, transaction ID) for postbacks, plus one counted Lead per user and offer (Q-23). | Covers PB-5 and R-3 with database constraints instead of application logic. | Needs unique indexes. |
| P-5 | Store email encrypted (key in a Worker secret) plus a keyed hash for lookups; send only the hash, if anything, to analytics. | Email never leaks in plain text to logs or BigQuery (R-12). | Key management. |
| P-6 | Two report views: by click date (cohort, "as of" time shown) and by postback date. | Late postbacks change past cohorts in an expected way (AN-5, R-7). | Two queries instead of one. |
| P-7 | A load test with k6 against a staging deployment at 200 events/s for 5 minutes, then 2x and 5x. | Proves NFR-2 instead of claiming it. | Possible Cloudflare cost (Q-17). |
| P-8 | A fault test for the BigQuery outage: block delivery, keep the quiz running, restore delivery, compare counts. | Proves NFR-4 and NFR-5. In the MVP the sink is Cloudflare storage, so the test simulates the outage. | Test harness work. |
| P-9 | Use the decision table in `offer-selection.md` as a shared fixture for unit tests and the demo instructions. | One source of expected results (DEMO-7, TEST-1). | None. |
| P-10 | A demo helper that prints the click ID after the redirect and a script that sends a signed Lead or Purchase for it. | Reviewers can follow the demo without forging signatures by hand (PB-7). | Small script. |
| P-11 | A log-scanning test: run the demo with a known synthetic email and assert it never appears in captured logs or URLs. | Proves DEMO-8 instead of claiming it. | Small test. |
