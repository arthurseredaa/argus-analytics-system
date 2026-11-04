// Domain: the quiz flow as data, with its parser and pure walking functions.
// Implements the "Quiz flow" decision of docs/plans/part2-mvp-stages.md (no ADR: reversible); serves QZ-1, QZ-2, QZ-7.
import { z } from "zod";

export type Condition = { if: string } | { some: readonly Condition[] } | { not: Condition };

export type Next =
  | string
  | null
  | {
      branches: readonly { when: Condition; goto: string }[];
      otherwise: string | null;
    };

export type Step = {
  key: string;
  kind: "choice" | "email";
  wording: string;
  options?: readonly { value: string; label: string }[];
  next: Next;
};

export type Flow = { prelander: string; first: string; steps: readonly Step[] };

const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ if: z.string() }),
    z.strictObject({ some: z.array(conditionSchema).min(1) }),
    z.strictObject({ not: conditionSchema }),
  ]),
);

const nextSchema = z.union([
  z.string(),
  z.null(),
  z.strictObject({
    branches: z.array(z.strictObject({ when: conditionSchema, goto: z.string() })),
    otherwise: z.string().nullable(),
  }),
]);

const stepSchema = z.strictObject({
  key: z.string().min(1),
  kind: z.enum(["choice", "email"]),
  wording: z.string().min(1),
  options: z
    .array(z.strictObject({ value: z.string().min(1), label: z.string().min(1) }))
    .optional(),
  next: nextSchema,
});

const flowSchema = z.strictObject({
  prelander: z.string().min(1),
  first: z.string().min(1),
  steps: z.array(stepSchema).min(1),
});

function targets(next: Next): string[] {
  if (next === null || typeof next === "string") return next === null ? [] : [next];
  const out = next.branches.map((b) => b.goto);
  if (next.otherwise !== null) out.push(next.otherwise);
  return out;
}

export function parseFlow(json: unknown): Flow {
  const parsed = flowSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "flow";
    throw new Error(`invalid flow at ${path}: ${issue?.message ?? "invalid"}`);
  }
  const flow = parsed.data as Flow;
  const fail = (path: string, message: string): never => {
    throw new Error(`invalid flow at ${path}: ${message}`);
  };

  const keys = new Set<string>();
  flow.steps.forEach((step, i) => {
    if (keys.has(step.key))
      fail(`steps[${i}].key`, `step keys must be unique, "${step.key}" repeats`);
    keys.add(step.key);
  });
  if (!keys.has(flow.first)) fail("first", `names a missing step "${flow.first}"`);

  flow.steps.forEach((step, i) => {
    if (step.kind === "choice" && (step.options?.length ?? 0) === 0) {
      fail(`steps[${i}].options`, "a choice step needs at least one option");
    }
    const ends =
      step.next === null || (typeof step.next === "object" && step.next.otherwise === null);
    if (step.kind === "choice" && ends) {
      fail(`steps[${i}].next`, "a choice step must lead on to the email step, not end the flow");
    }
    targets(step.next).forEach((target) => {
      if (!keys.has(target)) fail(`steps[${i}].next`, `names a missing step "${target}"`);
    });
  });

  const emailSteps = flow.steps.filter((s) => s.kind === "email");
  if (emailSteps.length !== 1) fail("steps", "exactly one email step is required");
  const emailIndex = flow.steps.findIndex((s) => s.kind === "email");
  if (flow.steps[emailIndex]?.next !== null) {
    fail(`steps[${emailIndex}].next`, "the email step must end the flow with null");
  }

  const byKey = new Map(flow.steps.map((s) => [s.key, s]));
  const reached = new Set<string>([flow.first]);
  const queue = [flow.first];
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    for (const target of targets((byKey.get(key) as Step).next)) {
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  const email = emailSteps[0] as Step;
  if (!reached.has(email.key)) {
    fail("steps", `the email step "${email.key}" is unreachable from first`);
  }

  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): void => {
    const seen = state.get(key);
    if (seen === "done") return;
    if (seen === "visiting") fail("steps", `cycle through step "${key}"`);
    state.set(key, "visiting");
    const step = byKey.get(key) as Step;
    targets(step.next).forEach(visit);
    state.set(key, "done");
  };
  visit(flow.first);

  return flow;
}

export function evaluateCondition(condition: Condition, value: string): boolean {
  if ("if" in condition) return condition.if === value;
  if ("some" in condition) return condition.some.some((c) => evaluateCondition(c, value));
  return !evaluateCondition(condition.not, value);
}

export function resolveNext(step: Step, value: string | undefined): string | null {
  const next = step.next;
  if (next === null || typeof next === "string") return next;
  if (value !== undefined) {
    for (const branch of next.branches) {
      if (evaluateCondition(branch.when, value)) return branch.goto;
    }
  }
  return next.otherwise;
}

function stepByKey(flow: Flow, key: string): Step {
  const step = flow.steps.find((s) => s.key === key);
  if (!step) throw new Error(`unknown step "${key}"`);
  return step;
}

export function nextStep(flow: Flow, answers: Readonly<Record<string, string>>): string | null {
  let key: string | null = flow.first;
  while (key !== null) {
    const step = stepByKey(flow, key);
    const answer = Object.hasOwn(answers, key) ? answers[key] : undefined;
    if (answer === undefined) return key;
    key = resolveNext(step, answer);
  }
  return null;
}

export function wording(step: Step, answers: Readonly<Record<string, string>>): string {
  return step.wording.replace(/\{([^{}]+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(answers, key) ? (answers[key] ?? placeholder) : placeholder,
  );
}

export function validateAnswers(
  flow: Flow,
  answers: Readonly<Record<string, unknown>>,
): { ok: true; answers: Record<string, string> } | { ok: false; fields: string[] } {
  const clean: Record<string, string> = {};
  const fields: string[] = [];
  const onPath = new Set<string>();

  let key: string | null = flow.first;
  while (key !== null) {
    const step = stepByKey(flow, key);
    onPath.add(key);
    if (step.kind === "email") break;
    const answer = Object.hasOwn(answers, key) ? answers[key] : undefined;
    if (typeof answer !== "string" || !step.options?.some((o) => o.value === answer)) {
      fields.push(`answers.${key}`);
      break;
    }
    clean[key] = answer;
    key = resolveNext(step, answer);
  }

  // After a bad answer the rest of the path is unknown, so only keys no step owns are extra.
  const pathKnown = fields.length === 0;
  for (const extra of Object.keys(answers)) {
    if (!pathKnown && flow.steps.some((s) => s.key === extra && s.kind === "choice")) continue;
    if (!onPath.has(extra) || stepByKey(flow, extra).kind === "email")
      fields.push(`answers.${extra}`);
  }

  return fields.length > 0 ? { ok: false, fields } : { ok: true, answers: clean };
}
