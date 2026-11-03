# Request flow

The demo scenario as a sequence of requests: a new user on day 1, a Lead from the partner, the same user returning on day 2, a Purchase. The components are the ones on [architecture.png](architecture.png); the tables and events each step touches are traced in [data-model.md, Trace of the demo](data-model.md#trace-of-the-demo). Email and IDs are synthetic.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant W as Worker
    participant D1 as D1 facts
    participant Q as Queue
    participant P as Partner

    note over B, Q: Day 1: new user
    B->>W: GET /p/P1 (no cookie)
    W-->>B: 200 page, Set-Cookie user_id=U1, visit V1
    W-)Q: prelander_viewed (quiz)
    B-)W: POST /api/events (step_viewed 1, step_answered, ... one per request)
    W-)Q: each event, 202 to the browser
    B->>W: POST /api/complete {answers, email}
    W->>D1: one batch: upsert users and user_answers, read Leads and the current catalog
    D1-->>W: facts
    W->>W: select(facts, catalog, completion) = 003, best_epu
    W-)Q: quiz_completed, offer_selected
    W-->>B: 200 {offer_id 003, name, url, reason, catalog_version}
    B->>W: GET /go/003
    W->>D1: read offer 003 status and the user's Leads, then write click c_8f3a
    W-)Q: offer_click
    W-->>B: 302 https://asia-connect.example/?click_id=c_8f3a
    B->>P: lands on the offer with click_id

    note over W, P: Partner reports a registration
    P->>W: POST /postback/v1/partnerA {type lead, click_id c_8f3a, transaction_id T-123}, X-Signature
    W->>W: verify HMAC and timestamp
    W->>D1: find click c_8f3a, insert conversions (unique partner, type, transaction_id)
    W-)Q: lead
    W-->>P: 202
    P->>W: the same postback again
    W->>D1: insert hits the unique key, nothing written
    W-->>P: 200 duplicate

    note over B, Q: Day 2: Lead return
    B->>W: GET /p/P1 (cookie U1)
    W->>D1: one batch: users, user_answers, Leads joined with clicks, current catalog
    D1-->>W: Lead on 003, 003 active
    W->>W: select(facts, catalog, entry) = 003, lead_return
    W->>D1: write click c_91bb
    W-)Q: prelander_viewed (lead_return), offer_selected, offer_click
    W-->>B: 302 https://asia-connect.example/?click_id=c_91bb (quiz skipped)
    P->>W: POST /postback/v1/partnerA {type purchase, click_id c_91bb, transaction_id T-124, payout 25.00 USD}
    W->>D1: find click c_91bb, insert conversions
    W-)Q: purchase
    W-->>P: 202
```

Solid arrows are synchronous; open arrows (`-)`) are fire-and-forget sends to the Queue, from where events go to R2 and BigQuery without the browser or the partner waiting. The step events in step 4 never touch D1; the answers reach D1 only in step 6. Every write to `clicks` happens before the `302` that carries the click ID (R-6). The report after step 24 shows one Lead and one Purchase on offer 003 for prelander P1.
