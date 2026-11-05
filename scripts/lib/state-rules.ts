// Pure rules for docs/state/progress.json: the validator and the stage closer.
// Serves .claude/rules/state.md (one record of stage status, closed only through verification). No Node imports, so tests type-check it.

export type Stage = {
  id: number;
  title: string;
  status: "pending" | "next" | "in_progress" | "done" | "skipped";
  verified?: string;
  commit?: string;
  closed?: string;
  notes?: string;
};

export type Progress = { plan: string; updated: string; stages: Stage[] };

const STATUSES: readonly string[] = ["pending", "next", "in_progress", "done", "skipped"];
// $schema is the editor pointer the file itself carries; it is not part of the data.
const TOP_KEYS = ["$schema", "plan", "updated", "stages"];
const STAGE_KEYS = ["id", "title", "status", "verified", "commit", "closed", "notes"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkStage(raw: unknown, index: number, errors: string[]): void {
  const where = `stages[${index}]`;
  if (!isObject(raw)) {
    errors.push(`${where} is not an object`);
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!STAGE_KEYS.includes(key)) errors.push(`${where} has unknown key "${key}"`);
  }
  if (!Number.isInteger(raw.id) || (raw.id as number) < 0) {
    errors.push(`${where}.id must be a non-negative integer`);
  }
  if (typeof raw.title !== "string" || raw.title === "") {
    errors.push(`${where}.title must be a non-empty string`);
  }
  if (typeof raw.status !== "string" || !STATUSES.includes(raw.status)) {
    errors.push(`${where}.status "${String(raw.status)}" is not one of ${STATUSES.join(", ")}`);
  }
  for (const key of ["verified", "notes"]) {
    if (key in raw && typeof raw[key] !== "string") errors.push(`${where}.${key} must be a string`);
  }
  if ("commit" in raw && (typeof raw.commit !== "string" || !COMMIT.test(raw.commit))) {
    errors.push(`${where}.commit must match ${COMMIT}`);
  }
  if ("closed" in raw && (typeof raw.closed !== "string" || !DATE.test(raw.closed))) {
    errors.push(`${where}.closed must match ${DATE}`);
  }
  if (raw.status === "done") {
    if (!("closed" in raw)) errors.push(`${where} is done but has no closed date`);
    if (!("verified" in raw)) errors.push(`${where} is done but has no verified text`);
  }
}

// An empty array means the document is valid. Never throws, whatever the input is.
export function checkProgress(doc: unknown): string[] {
  if (!isObject(doc)) return ["the document is not an object"];
  const errors: string[] = [];
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.includes(key)) errors.push(`unknown top-level key "${key}"`);
  }
  if ("$schema" in doc && typeof doc.$schema !== "string") errors.push("$schema must be a string");
  if (typeof doc.plan !== "string") errors.push("plan must be a string");
  if (typeof doc.updated !== "string" || !DATE.test(doc.updated)) {
    errors.push(`updated must match ${DATE}`);
  }
  if (!Array.isArray(doc.stages) || doc.stages.length === 0) {
    errors.push("stages must be a non-empty array");
    return errors;
  }
  doc.stages.forEach((stage, i) => checkStage(stage, i, errors));

  const stages = doc.stages.filter(isObject);
  const seen = new Set<unknown>();
  for (const stage of stages) {
    if (seen.has(stage.id)) errors.push(`duplicate stage id ${String(stage.id)}`);
    seen.add(stage.id);
  }
  const active = stages.filter((s) => s.status === "next" || s.status === "in_progress");
  const finished = stages.every((s) => s.status === "done" || s.status === "skipped");
  if (active.length > 1 || (active.length === 0 && !finished)) {
    errors.push(
      `exactly one stage must be next or in_progress (found ${active.length}), unless every stage is done or skipped`,
    );
  }
  return errors;
}

// Returns a new document; the input is not changed. Throws when the stage cannot be closed.
export function closeStage(
  doc: Progress,
  id: number,
  close: { verified: string; notes?: string; date: string },
): Progress {
  const out = structuredClone(doc);
  const stage = out.stages.find((s) => s.id === id);
  if (!stage) throw new Error(`stage ${id} not found`);
  if (stage.status !== "next" && stage.status !== "in_progress") {
    throw new Error(
      `stage ${id} is ${stage.status}, only a next or in_progress stage can be closed`,
    );
  }
  stage.status = "done";
  stage.closed = close.date;
  stage.verified = close.verified;
  if (close.notes !== undefined) stage.notes = close.notes;
  out.updated = close.date;
  const following = out.stages
    .slice(out.stages.indexOf(stage) + 1)
    .find((s) => s.status === "pending");
  if (following) following.status = "next";
  return out;
}
