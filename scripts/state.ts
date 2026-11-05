// Validates docs/state/progress.json and closes a stage in it.
// Serves .claude/rules/state.md: pnpm state:check runs in pnpm check, pnpm stage:close is the only way to close a stage.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkProgress, closeStage, type Progress } from "./lib/state-rules.ts";

const USAGE =
  "usage: node scripts/state.ts check | close <id> --verified <text> [--notes <text> | --notes-file <path>]";
const file = path.join(import.meta.dirname, "..", "docs", "state", "progress.json");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function load(): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fail(`cannot read ${file}: ${(error as Error).message}`);
  }
}

function checked(doc: unknown): Progress {
  const errors = checkProgress(doc);
  if (errors.length > 0) fail(errors.join("\n"));
  return doc as Progress;
}

function summary(doc: Progress): string {
  const active = doc.stages.find((s) => s.status === "next" || s.status === "in_progress");
  const next = active ? `${active.id} ${active.title}` : "none";
  return `state: ok (${doc.stages.length} stages, next: ${next})`;
}

const [command, ...rest] = process.argv.slice(2);

if (command === "check") {
  console.log(summary(checked(load())));
} else if (command === "close") {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        verified: { type: "string" },
        notes: { type: "string" },
        "notes-file": { type: "string" },
      },
    });
  } catch (error) {
    fail(`${(error as Error).message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const id = Number(positionals[0]);
  if (positionals.length !== 1 || !Number.isInteger(id) || id < 0 || !values.verified) {
    fail(USAGE);
  }
  if (values.notes !== undefined && values["notes-file"] !== undefined) {
    fail(`--notes and --notes-file cannot be used together\n${USAGE}`);
  }
  let notes = values.notes;
  if (values["notes-file"] !== undefined) {
    try {
      notes = fs.readFileSync(values["notes-file"], "utf8").replace(/\n$/, "");
    } catch (error) {
      fail(`cannot read notes file: ${(error as Error).message}`);
    }
  }
  const before = checked(load());
  let after: Progress;
  try {
    after = closeStage(before, id, {
      verified: values.verified,
      ...(notes === undefined ? {} : { notes }),
      date: new Date().toISOString().slice(0, 10),
    });
  } catch (error) {
    fail((error as Error).message);
  }
  checked(after);
  fs.writeFileSync(file, JSON.stringify(after, null, 2) + "\n");
  console.log(summary(after));
} else {
  fail(USAGE);
}
