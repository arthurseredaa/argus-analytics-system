import { describe, expect, it } from "vitest";
import demoJson from "../../config/prelanders/demo.json";
import {
  evaluateCondition,
  nextStep,
  parseFlow,
  validateAnswers,
  wording,
} from "../../src/domain/flow.ts";
import { prelanderFlows } from "../../src/domain/prelanders.ts";
import fourJson from "../fixtures/flows/four-steps.json";

const demo = parseFlow(demoJson);
const four = parseFlow(fourJson);
const step = (key: string) => {
  const found = demo.steps.find((s) => s.key === key);
  if (!found) throw new Error(`no step ${key}`);
  return found;
};
const withStep = (key: string, patch: Record<string, unknown>) => ({
  ...demoJson,
  steps: demoJson.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)),
});

const branch = (when: unknown) =>
  withStep("gender", { next: { branches: [{ when, goto: "email" }], otherwise: "ethnicity" } });

describe("quiz flow", () => {
  it("QZ-1 step 1 asks for the partner's gender with women and men", () => {
    const gender = step("gender");
    expect(gender.options?.map((o) => o.value)).toEqual(["women", "men"]);
    expect(gender.wording).not.toContain("your gender");
  });

  it("QZ-2 wording after women", () => {
    expect(wording(step("ethnicity"), { gender: "women" })).toBe(
      "Where should the women you meet come from?",
    );
  });
  it("QZ-2 wording after men", () => {
    expect(wording(step("ethnicity"), { gender: "men" })).toBe(
      "Where should the men you meet come from?",
    );
  });
  it("QZ-2 step 2 wording follows the step 1 answer", () => {
    expect(wording(step("ethnicity"), { gender: "women" })).not.toBe(
      wording(step("ethnicity"), { gender: "men" }),
    );
  });
  it("QZ-2 an unknown placeholder stays as is", () => {
    expect(wording(step("ethnicity"), {})).toBe("Where should the {gender} you meet come from?");
  });

  it("QZ-2 accepts asia, europe and latam", () => {
    for (const ethnicity of ["asia", "europe", "latam"]) {
      expect(validateAnswers(demo, { gender: "women", ethnicity })).toEqual({
        ok: true,
        answers: { gender: "women", ethnicity },
      });
    }
  });
  it("QZ-2 rejects africa", () => {
    expect(validateAnswers(demo, { gender: "women", ethnicity: "africa" })).toEqual({
      ok: false,
      fields: ["answers.ethnicity"],
    });
  });

  it("QZ-1 rejects other values", () => {
    expect(validateAnswers(demo, { gender: "robots", ethnicity: "asia" })).toEqual({
      ok: false,
      fields: ["answers.gender"],
    });
  });
  it("QZ-1 rejects an unknown key", () => {
    expect(validateAnswers(demo, { gender: "men", ethnicity: "asia", colour: "red" })).toEqual({
      ok: false,
      fields: ["answers.colour"],
    });
  });
  it("QZ-1 rejects a missing answer and a non-string answer", () => {
    expect(validateAnswers(demo, { gender: "men" })).toEqual({
      ok: false,
      fields: ["answers.ethnicity"],
    });
    expect(validateAnswers(demo, { gender: "men", ethnicity: 3 })).toEqual({
      ok: false,
      fields: ["answers.ethnicity"],
    });
  });

  it("QZ-7 nextStep walks the flow", () => {
    expect(nextStep(demo, {})).toBe("gender");
    expect(nextStep(demo, { gender: "men" })).toBe("ethnicity");
    expect(nextStep(demo, { gender: "men", ethnicity: "asia" })).toBe("email");
  });

  it("QZ-7 evaluateCondition handles if, some and not", () => {
    expect(evaluateCondition({ if: "asia" }, "asia")).toBe(true);
    expect(evaluateCondition({ some: [{ if: "asia" }, { if: "europe" }] }, "latam")).toBe(false);
    expect(evaluateCondition({ not: { if: "asia" } }, "latam")).toBe(true);
  });

  it("QZ-7 a branch on the step's own answer picks the next step", () => {
    const branching = parseFlow(
      withStep("gender", {
        next: { branches: [{ when: { if: "men" }, goto: "email" }], otherwise: "ethnicity" },
      }),
    );
    expect(nextStep(branching, { gender: "men" })).toBe("email");
    expect(nextStep(branching, { gender: "women" })).toBe("ethnicity");
    expect(validateAnswers(branching, { gender: "men" })).toEqual({
      ok: true,
      answers: { gender: "men" },
    });
  });

  it("QZ-7 a fourth step in the flow config is required and validated", () => {
    expect(nextStep(four, { gender: "men", ethnicity: "asia" })).toBe("age");
    expect(validateAnswers(four, { gender: "men", ethnicity: "asia" })).toEqual({
      ok: false,
      fields: ["answers.age"],
    });
    expect(validateAnswers(four, { gender: "men", ethnicity: "asia", age: "99" })).toEqual({
      ok: false,
      fields: ["answers.age"],
    });
    expect(validateAnswers(four, { gender: "men", ethnicity: "asia", age: "45+" }).ok).toBe(true);
  });

  it("QZ-7 a flow whose next names a missing step is rejected", () => {
    expect(() => parseFlow(withStep("gender", { next: "nowhere" }))).toThrow(/steps\[0\]\.next/);
  });
  it("QZ-7 a flow with a cycle is rejected", () => {
    const looping = withStep("ethnicity", {
      next: { branches: [{ when: { if: "asia" }, goto: "gender" }], otherwise: "email" },
    });
    expect(() => parseFlow(looping)).toThrow(/cycle/);
  });
  it("QZ-7 a flow needs one email step ending the flow, options on choice steps, unique keys", () => {
    const emailStep = demoJson.steps.find((s) => s.kind === "email");
    if (!emailStep) throw new Error("demo has no email step");
    const secondEmail = { ...emailStep, key: "email2" };
    const twoEmails = demoJson.steps.map((s) =>
      s.key === "ethnicity" ? { ...s, next: "email" } : s,
    );
    expect(() => parseFlow({ ...demoJson, steps: [...twoEmails, secondEmail] })).toThrow(
      /exactly one email step/,
    );
    const noEmail = demoJson.steps
      .filter((s) => s.kind !== "email")
      .map((s) => ({ ...s, next: null }));
    expect(() => parseFlow({ ...demoJson, steps: noEmail })).toThrow(
      /steps\[0\]\.next: a choice step must lead on to the email step/,
    );
    expect(() => parseFlow(withStep("gender", { options: [] }))).toThrow(/options/);
    expect(() => parseFlow({ ...demoJson, steps: [...demoJson.steps, demoJson.steps[0]] })).toThrow(
      /unique/,
    );
  });

  it("QZ-7 a flow whose choice step ends without the email step is rejected", () => {
    expect(() => parseFlow(withStep("ethnicity", { next: null }))).toThrow(/steps\[1\]\.next/);
    expect(() =>
      parseFlow(
        withStep("gender", {
          next: { branches: [{ when: { if: "men" }, goto: "email" }], otherwise: null },
        }),
      ),
    ).toThrow(/steps\[0\]\.next/);
  });
  it("QZ-7 a flow whose email step is unreachable is rejected", () => {
    expect(() => parseFlow(withStep("ethnicity", { next: "gender" }))).toThrow(/unreachable/);
  });

  it("QZ-7 a branch on a value the step does not offer is rejected", () => {
    expect(() => parseFlow(branch({ if: "robots" }))).toThrow(/steps\[0\]\.next.*"robots"/);
    expect(() => parseFlow(branch({ some: [{ if: "men" }, { if: "robots" }] }))).toThrow(
      /"robots"/,
    );
    expect(() => parseFlow(branch({ not: { if: "robots" } }))).toThrow(/"robots"/);
    expect(() =>
      parseFlow(branch({ some: [{ if: "men" }, { not: { if: "women" } }] })),
    ).not.toThrow();
  });
  it("QZ-7 a step unreachable from first is rejected even without a cycle", () => {
    const orphan = {
      key: "orphan",
      kind: "choice",
      wording: "Never asked",
      options: [{ value: "x", label: "X" }],
      next: "email",
    };
    expect(() => parseFlow({ ...demoJson, steps: [...demoJson.steps, orphan] })).toThrow(
      /"orphan" is unreachable/,
    );
  });

  it("QZ-7 prelanderFlows holds the demo flow", () => {
    expect(prelanderFlows.get("demo")?.first).toBe("gender");
  });
});
