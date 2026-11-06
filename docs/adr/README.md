# Architecture decision records

One decision per file, numbered in order, written from `0000-template.md`. An accepted ADR is never edited; a later ADR supersedes it. Rules for writing them are in `.claude/rules/adr.md`.

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions as ADRs | accepted | 2026-10-29 |
| [0002](0002-user-identity.md) | Identify users with a server-set first-party cookie | accepted (2026-11-04, Part 2 stage 1) | 2026-11-02 |
| [0003](0003-operational-store.md) | Keep the facts the rules need in one D1 database | accepted (2026-11-04, Part 2 stages 0 and 1) | 2026-11-02 |
| [0004](0004-offer-selection-semantics.md) | Offer selection: quiz again without a Lead, most recent Lead wins, one pure selection function | accepted (2026-11-04, Part 2 stage 1) | 2026-11-02 |
| [0005](0005-event-ingestion-and-buffering.md) | Ingest events through a Queue into files in R2 | accepted (2026-11-06, Part 2 stages 2 and 5) | 2026-11-02 |
| [0006](0006-bigquery-delivery.md) | Load event files from R2 into BigQuery with load jobs every 5 minutes | accepted (2026-11-06, Part 2 stage 5, D1 standing in for BigQuery) | 2026-11-02 |
| [0007](0007-postback-contract-and-auth.md) | Accept postbacks only as POST requests signed with HMAC over a timestamp and the body | accepted (2026-11-05, Part 2 stage 3) | 2026-11-02 |
