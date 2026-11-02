---
paths:
  - "docs/requirements/**"
---

# Requirements rules

- A new edge case, failure mode or ambiguity gets an id and a table row on the spot: `R-` in `risks.md` for things that break correctness, cost or delivery; `Q-` in `open-questions.md` for behaviour the spec leaves open; `A-` for an assumption nobody needs to confirm. Ids are never reused.
- Every `R-` row has a "How we check" cell that names a concrete test or measurement. Every `Q-` row has a default we design for, so the question never blocks work.
- When the company answers a question, change its status to `answered: <one line>` and, in the same commit, update the ADR or design section that depended on the default.
- Tests that cover a risk or question carry the id in their name, for example `R-4 same postback twice leaves counts unchanged`.
- A term that means something specific in this project (Lead, click, visit, transition, universal offer, prelander) is defined in `glossary.md` the first time it is used in a document. Use the glossary term everywhere afterwards; do not introduce synonyms.
- Numbers about load, latency, freshness, retention and cost go to `nfr.md` with their source (spec page or assumption id). Other documents refer to `nfr.md` instead of repeating the number.
- Never settle an ambiguity in code or in the design text alone. It goes here first.
