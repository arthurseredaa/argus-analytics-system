# 0001. Record architecture decisions as ADRs

- Status: accepted
- Date: 2026-10-29

## Context

The spec asks for a design document that covers architecture and alternatives, and the design will be discussed with the reviewers before implementation. Their questions will mostly be about why one option was picked over another. Most of the design and code is written with an AI agent, so the reasoning has to live in the repo, where both the agent and the reviewers can read it.

## Options considered

1. Keep all reasoning inside the design document. One file to read, but the reasons for a single choice get buried, and a decision that changes later overwrites the old reasoning.
2. Separate ADRs (Michael Nygard's format) next to the design document. The design document stays short and links to the ADRs.

## Decision

Option 2. ADRs live in `docs/adr/`, use the template in `0000-template.md`, and are numbered sequentially. The template adds "Options considered" and "Verification" sections to Nygard's original.

## Consequences

Each decision can be reviewed and linked on its own, and a changed decision leaves a visible trail. The cost is keeping the design document and the ADRs consistent.

## Verification

During the design review, every question of the form "why X and not Y" should be answerable by pointing to an ADR.
