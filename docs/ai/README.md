# AI work log

The spec asks for evidence of AI-assisted work: the agent instructions, the initial plan, the significant changes to it, and two or three real examples. This page says where each one is.

## Agent instructions

- [CLAUDE.md](../../CLAUDE.md): the project rules for the agent. "How a Part 2 stage runs" describes how the MVP was built.
- [.claude/rules/](../../.claude/rules/): path-scoped rules for ADRs, requirements and this log. They load when those files are touched.
- [.claude/skills/](../../.claude/skills/): the project skills `close-stage`, `humanizer` and `security-audit`.
- [.claude/hooks/session-brief.sh](../../.claude/hooks/session-brief.sh): prints the next stage, the last plan change and the open questions at the start of every session.
- [docs/plans/\_subagent-brief.md](../plans/_subagent-brief.md): the brief every subagent reads before its task.

## Plan and its changes

- [plan-history.md](plan-history.md) opens with the initial plan of 2026-10-29. After it come all the significant changes, each with its date and reason.
- The stage plans are in [docs/plans/](../plans/). [part2-mvp-stages.md](../plans/part2-mvp-stages.md) is the stage list for the MVP.
- The status of each stage is in [docs/state/progress.json](../state/progress.json).

## Examples

Each example has four parts: the task given to the AI, what it proposed, what was decided, and how the result was checked.

1. [The transition without an offer id in the URL](examples/10-go-without-offer-id.md). The AI found a hole and proposed accepting it. Arthur proposed a server-side design instead. The AI changed one part of it, and an independent review reached the same design.
2. [A latency target missed under load](examples/11-latency-target-missed.md). The AI offered to raise a target the load test had missed. Arthur asked for the cause first. The evidence pointed to the platform, and the target stayed as it was, with the miss recorded.
3. [A hand-drawn diagram that found gaps in two ADRs](examples/06-diagram-explain-back.md). Arthur drew the event and postback paths himself. Checking the drawing against the ADRs showed that ADR 0005 contradicted itself and that ADR 0006 had two gaps.

The other files in [examples/](examples/) are drafts collected along the way. They were not picked for the hand-in.
