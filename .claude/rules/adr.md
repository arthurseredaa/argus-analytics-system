---
paths:
  - "docs/adr/**"
---

# ADR rules

- Write an ADR before the implementation, and only for a decision that is expensive to reverse: storage, queue, user identity, postback auth, delivery to BigQuery, data layout. A decision that can be swapped in an afternoon goes into the stage plan as a line, not an ADR.
- Copy `docs/adr/0000-template.md`, take the next number, fill every section. "Verification" names a test, a metric or a limit, never "we will see".
- "Options considered" lists at least two, each with where it breaks. If there is only one option, there is no decision to record.
- Link the ADR to the requirement, question or risk that forces it (`R-`, `Q-`, `A-` ids from `docs/requirements/`). If an open question is answered later, update that ADR in the same commit.
- An accepted ADR is not edited. Write a new one and set the old status to `superseded by NNNN`.
- "Outcome" stays empty until the stage that implements the decision has passed its verification. Then fill it with the date and what actually happened.
- Add a line to the index in `docs/adr/README.md` when the file exists; create the index on the first ADR after 0001.
