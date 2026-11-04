// Domain: the quiz flow of each prelander, parsed once at module load.
// Implements the "Quiz flow" decision of docs/plans/part2-mvp-stages.md (no ADR: reversible); serves QZ-1, QZ-2, QZ-7.
// A second prelander is a new JSON under config/prelanders/ and one import line here.
import demo from "../../config/prelanders/demo.json";
import { type Flow, parseFlow } from "./flow.ts";

const flows = [parseFlow(demo)];

export const prelanderFlows: ReadonlyMap<string, Flow> = new Map(
  flows.map((flow) => [flow.prelander, flow]),
);
