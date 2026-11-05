// Offer script: writes catalog version n+1 as a copy of the current version with one offer changed.
// Usage: pnpm offer set-status <id> active|inactive [--remote] | pnpm offer set-epu <id> <value> [--remote]
// Default target is the local D1; --remote is the deployed demo. Implements ADR 0003; serves OFF-1, OFF-2, Q-9.
// Run by Node 24 (types are stripped).
//
// The new version goes in through one `wrangler d1 execute --file`. Checked locally: a file whose
// last statement fails leaves nothing behind, not even an earlier CREATE TABLE, so a run is all
// or nothing. The remote path was not probed. There is one operator in the MVP, and the
// catalog_history.version primary key makes a parallel second run fail instead of overwriting.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogChangeStatements, type CatalogChange } from "../src/db/catalog-change.ts";
import { renderSql } from "../src/db/seed.ts";

const USAGE =
  "usage: pnpm offer set-status <id> active|inactive [--remote] | pnpm offer set-epu <id> <value> [--remote]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const flags = process.argv.slice(2);
const remote = flags.includes("--remote");
const args = flags.filter((a) => a !== "--remote" && a !== "--local");
if (args.some((a) => a.startsWith("--"))) fail(USAGE);
const target = remote ? "remote" : "local";

let change: CatalogChange;
if (
  args[0] === "set-status" &&
  args.length === 3 &&
  (args[2] === "active" || args[2] === "inactive")
) {
  change = { kind: "status", offerId: args[1]!, active: args[2] === "active" };
} else if (args[0] === "set-epu" && args.length === 3) {
  const epu = Number(args[2]);
  if (args[2]!.trim() === "" || !Number.isFinite(epu) || epu <= 0)
    fail(`${USAGE}\nEPU must be a positive number`);
  change = { kind: "epu", offerId: args[1]!, epu };
} else {
  fail(USAGE);
}

const root = path.join(import.meta.dirname, "..");

function wrangler(extra: string[], stdio: "pipe" | "inherit") {
  return spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "facts", `--${target}`, ...extra],
    { cwd: root, encoding: "utf8", stdio: ["ignore", stdio, "inherit"] },
  );
}

function query(sql: string): Record<string, unknown>[] {
  const run = wrangler(["--json", "--command", sql], "pipe");
  if (run.status !== 0) fail(`wrangler d1 execute failed (exit ${run.status})`);
  const parsed = JSON.parse(run.stdout) as { results: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

const current = query("SELECT MAX(version) AS v FROM catalog_history")[0]?.["v"];
if (typeof current !== "number") fail("the catalog is empty: run pnpm seed first");
const ids = query(`SELECT id FROM offers WHERE version = ${current}`).map((r) => r["id"]);
if (!ids.includes(change.offerId))
  fail(`offer ${change.offerId} is not in catalog version ${current}`);

const statements = catalogChangeStatements(current, change, Date.now());
const dir = fs.mkdtempSync(os.tmpdir() + "/offer-");
let status: number | null;
try {
  const sqlPath = path.join(dir, "offer.sql");
  fs.writeFileSync(sqlPath, renderSql(statements), { mode: 0o600 });
  status = wrangler(["--file", sqlPath], "inherit").status;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
if (status !== 0) fail(`wrangler d1 execute failed (exit ${status})`);
console.log(`catalog version ${current + 1}: ${statements[0]!.params[2] as string}`);
