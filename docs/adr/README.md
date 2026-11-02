# Architecture decision records

One decision per file, numbered in order, written from `0000-template.md`. An accepted ADR is never edited; a later ADR supersedes it. Rules for writing them are in `.claude/rules/adr.md`.

| ADR | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions as ADRs | accepted | 2026-10-29 |
| [0002](0002-user-identity.md) | Identify users with a server-set first-party cookie | proposed | 2026-11-02 |
| [0003](0003-operational-store.md) | Keep the facts the rules need in one D1 database | proposed | 2026-11-02 |
| [0004](0004-offer-selection-semantics.md) | Offer selection: quiz again without a Lead, most recent Lead wins, one pure selection function | proposed | 2026-11-02 |
| [0005](0005-event-ingestion-and-buffering.md) | Ingest events through a Queue into files in R2 | proposed | 2026-11-02 |
| [0006](0006-bigquery-delivery.md) | Load event files from R2 into BigQuery with load jobs every 5 minutes | proposed | 2026-11-02 |
| [0007](0007-postback-contract-and-auth.md) | Accept postbacks only as POST requests signed with HMAC over a timestamp and the body | proposed | 2026-11-02 |
