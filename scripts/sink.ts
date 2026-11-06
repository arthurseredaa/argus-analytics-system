// Sink script: pauses or resumes the loader by putting or deleting control/loader-paused in R2.
// Usage: pnpm sink outage on|off [--remote]
// Default target is the local R2; --remote is the deployed demo. Implements ADR 0005 and ADR 0006; serves NFR-4, NFR-5, R-16.
// Run by Node 24 (types are stripped).
//
// While the flag exists the loader skips its runs, so events pile up in pending/ the way they would
// during a BigQuery outage. `off` twice is safe: deleting a missing key exits 0.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PAUSE_KEY, parseSinkArgs, sinkWranglerArgs } from "./lib/sink.ts";
import { eventsBucketName, readWranglerConfig } from "./lib/wrangler-config.ts";

const USAGE = "usage: pnpm sink outage on|off [--remote]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const parsed = parseSinkArgs(process.argv.slice(2));
if (parsed === null) fail(USAGE);
const { action, target } = parsed;

const root = path.join(import.meta.dirname, "..");
const bucket = eventsBucketName(
  readWranglerConfig(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8")),
);

const run = spawnSync("pnpm", sinkWranglerArgs(action, target, bucket), {
  cwd: root,
  encoding: "utf8",
  input: action === "on" ? `paused by pnpm sink at ${new Date().toISOString()}` : "",
  stdio: ["pipe", "inherit", "inherit"],
});
if (run.status !== 0) {
  fail(`wrangler r2 object ${action === "on" ? "put" : "delete"} failed (exit ${run.status})`);
}
console.log(
  action === "on"
    ? `loader paused (${target}): ${bucket}/${PAUSE_KEY}`
    : `loader resumed (${target})`,
);
