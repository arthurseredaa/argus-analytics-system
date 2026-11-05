/// <reference types="node" />
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Runs a copy of the demo script in a directory without .dev.vars.remote, so the result does not
// depend on the files of the machine that runs the test.
const root = path.join(import.meta.dirname, "..", "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "demo-script-"));
fs.mkdirSync(path.join(sandbox, "scripts", "lib"), { recursive: true });
for (const file of ["scripts/demo.sh", "scripts/acceptance.sh", "scripts/lib/dev-server.sh"])
  fs.copyFileSync(path.join(root, file), path.join(sandbox, file));

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe("demo script", () => {
  it("MVP-1 a remote run without .dev.vars.remote stops with a FAIL line before the reset", () => {
    // The host does not resolve, so reaching the reset would print "FAIL reset", not "FAIL preflight".
    const run = spawnSync("bash", ["scripts/demo.sh", "--base", "https://demo.invalid"], {
      cwd: sandbox,
      encoding: "utf8",
      env: { ...process.env, BASE: "" },
      timeout: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL preflight: expected .dev.vars.remote");
    expect(run.stdout).not.toContain("FAIL reset");
  });
});
