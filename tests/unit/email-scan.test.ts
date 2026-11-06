/// <reference types="node" />
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eventsBucketName, readWranglerConfig } from "../../scripts/lib/wrangler-config.ts";

// Runs scripts/email-scan.sh in its three modes. The remote mode gets a fake `curl` and a fake `pnpm`
// first on the PATH, so nothing here reaches the network or a Cloudflare account (DEMO-8, R-12).
const root = path.join(import.meta.dirname, "..", "..");
const script = path.join(root, "scripts", "email-scan.sh");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "email-scan-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function tmpDir(...files: [string, string][]): string {
  const dir = fs.mkdtempSync(path.join(scratch, "case-"));
  for (const [name, content] of files) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

// The macOS bash 3.2 when there is one, because the script has to run on it; CI's /bin/bash is 5.
const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";

function scan(args: string[], env: Record<string, string> = {}) {
  return spawnSync(bash, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BASE: "", ...env },
    timeout: 30_000,
  });
}

// The fakes: curl answers the health route from $FAKE_DIR/health.seq (one pending_files value per call, the
// last one repeats) and the listing from $FAKE_DIR/files.json; pnpm answers an R2 get from $FAKE_DIR/<key with
// / as _> (a missing file is the "does not exist" error of wrangler, a <file>.fail marker is a login error),
// and a D1 dump from $FAKE_DIR/rows.json. Every call is appended to $FAKE_CALLS.
function remote(options: {
  files: string;
  r2?: Record<string, string>;
  rows?: unknown[];
  rowsText?: string;
  tail?: string;
  pending?: number[];
  path?: string;
}) {
  const dir = tmpDir(["tail.log", options.tail ?? '{"logs":[]}\n{"logs":[]}\n']);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "files.json"), options.files);
  fs.writeFileSync(path.join(dir, "health.seq"), `${(options.pending ?? [0]).join("\n")}\n`);
  fs.writeFileSync(
    path.join(dir, "rows.json"),
    options.rowsText ??
      JSON.stringify([{ results: options.rows ?? [{ event_id: "e0" }], success: true }]),
  );
  for (const [key, text] of Object.entries(options.r2 ?? {}))
    fs.writeFileSync(path.join(dir, key.replaceAll("/", "_")), text);
  fs.writeFileSync(
    path.join(bin, "curl"),
    [
      "#!/bin/bash",
      'echo "curl $*" >> "$FAKE_CALLS"',
      'case "$*" in',
      "  *__test/health*)",
      '    n="$(cat "$FAKE_DIR/health.count" 2>/dev/null || echo 0)"',
      '    echo $((n + 1)) > "$FAKE_DIR/health.count"',
      '    value="$(sed -n "$((n + 1))p" "$FAKE_DIR/health.seq")"',
      '    [ -n "$value" ] || value="$(tail -n 1 "$FAKE_DIR/health.seq")"',
      '    echo "{\\"pending_files\\":$value}" ;;',
      '  *) cat "$FAKE_DIR/files.json" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    [
      "#!/bin/bash",
      'echo "pnpm $*" >> "$FAKE_CALLS"',
      'case "$*" in',
      '  *"r2 object get"*) key="${7#*/}"; file="$FAKE_DIR/${key//\\//_}"',
      '    if [ -f "$file.fail" ]; then echo "You are not logged in." >&2; exit 1; fi',
      '    if [ -f "$file" ]; then cat "$file"; else echo "The specified key does not exist." >&2; exit 1; fi ;;',
      '  *"d1 execute"*) cat "$FAKE_DIR/rows.json" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const calls = path.join(dir, "calls.log");
  const run = scan(["--remote", path.join(dir, "tail.log"), "--since", "1762300000000"], {
    BASE: "https://worker.invalid",
    PATH: options.path ?? `${bin}:${process.env.PATH ?? ""}`,
    FAKE_DIR: dir,
    FAKE_CALLS: calls,
    EMAIL_SCAN_POLL_SECONDS: "1",
    EMAIL_SCAN_WAIT_SECONDS: "2",
  });
  return { run, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
}

const listing = (keys: string[], truncated = false) => JSON.stringify({ keys, truncated });

describe("email scan of a directory", () => {
  it("DEMO-8 R-12 email scan of a clean directory exits 0", () => {
    const dir = tmpDir(["a.json", '{"user_id":"u"}']);
    const run = scan(["--dir", dir]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("email-scan: clean (1 files)");
  });

  it("DEMO-8 R-12 email scan finds the address and its URL-encoded form", () => {
    for (const content of ["user1%40example.com", "user1@example.com"]) {
      const dir = tmpDir(["clean.json", "{}"], ["dirty.json", `{"x":"${content}"}`]);
      const run = scan(["--dir", dir]);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("email-scan: FOUND the address");
      expect(run.stdout).toContain("dirty.json");
      expect(run.stdout).not.toContain("clean.json");
    }
  });

  it("DEMO-8 an empty or missing directory is a usage error, because a scan over nothing proves nothing", () => {
    expect(scan(["--dir", tmpDir()]).status).toBe(2);
    expect(scan(["--dir", path.join(scratch, "missing")]).status).toBe(2);
    expect(scan(["--dir"]).status).toBe(2);
  });
});

describe("remote email scan", () => {
  it("DEMO-8 a remote scan without an https BASE or --since is a usage error", () => {
    const log = tmpDir(["x.log", "{}\n"]) + "/x.log";
    for (const [args, base] of [
      [["--remote", "x.log", "--since", "1"], ""],
      [["--remote", "x.log", "--since", "1"], "http://localhost:8787"],
      [["--remote", "x.log"], "https://demo.invalid"],
      [["--remote", log, "--since", "abc"], "https://demo.invalid"],
      [["--remote", log, "--since", "-1"], "https://demo.invalid"],
    ] as const) {
      const run = scan([...args], { BASE: base });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("usage");
    }
  });

  it("DEMO-8 the remote scan reads the bucket the Worker binds", () => {
    const line = fs
      .readFileSync(script, "utf8")
      .split("\n")
      .find((l) => l.startsWith("BUCKET="));
    const config = readWranglerConfig(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
    expect(line).toBe(`BUCKET="${eventsBucketName(config)}"`);
  });

  it("DEMO-8 R-12 a remote scan of clean files and rows prints the counts and exits 0", () => {
    const { run, calls } = remote({
      files: listing(["pending/a.ndjson", "loaded/b.ndjson"]),
      r2: { "pending/a.ndjson": '{"type":"step_viewed"}\n', "loaded/b.ndjson": "{}\n" },
      rows: [{ event_id: "e1" }, { event_id: "e2" }, { event_id: "e3" }],
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("email-scan: clean (tail 2 lines, 2 R2 files, 3 events rows)");
    expect(calls).toContain("curl");
    expect(calls.indexOf("/__test/health")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("/__test/health")).toBeLessThan(calls.indexOf("/__test/files"));
    expect(calls).toContain("/__test/files?since=1762300000000");
    expect(calls).not.toMatch(/curl .*(-L|--location)( |$)/);
    expect(calls).toContain("funnels-events/pending/a.ndjson --remote --pipe");
    expect(calls).toContain("d1 execute events --remote --json");
    expect(calls).toContain("received_at >= 1762300000000");
  });

  it("DEMO-8 R-12 a remote scan finds the address in an R2 file, and in a D1 row", () => {
    const inFile = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": '{"x":"user1%40example.com"}\n' },
    });
    expect(inFile.run.status).toBe(1);
    expect(inFile.run.stdout).toContain("email-scan: FOUND the address");
    expect(inFile.run.stdout).toContain("loaded_b.ndjson");

    const inRow = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n" },
      rows: [{ payload: "user1@example.com" }],
    });
    expect(inRow.run.status).toBe(1);
    expect(inRow.run.stdout).toContain("events.json");
  });

  it("DEMO-8 a remote scan that reads no R2 file, or only a truncated list, exits 2", () => {
    const none = remote({ files: listing([]) });
    expect(none.run.status).toBe(2);
    expect(none.run.stdout).not.toContain("clean");
    expect(none.calls).not.toContain("d1 execute");

    const truncated = remote({
      files: listing(["pending/a.ndjson"], true),
      r2: { "pending/a.ndjson": "{}\n" },
    });
    expect(truncated.run.status).toBe(2);
    expect(truncated.run.stdout).not.toContain("clean");
  });

  it("DEMO-8 a remote scan refuses a key outside the three event prefixes", () => {
    const run = remote({ files: listing(["../../etc/passwd"]) });
    expect(run.run.status).toBe(2);
    expect(run.calls).not.toContain("r2 object get");
  });

  it("DEMO-8 a remote scan waits for pending files to drain before it lists the keys", () => {
    const { run, calls } = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n" },
      pending: [3, 1, 0],
    });
    expect(run.status).toBe(0);
    expect(calls.match(/__test\/health/g)).toHaveLength(3);
    expect(calls.lastIndexOf("/__test/health")).toBeLessThan(calls.indexOf("/__test/files"));
  });

  it("DEMO-8 a remote scan that still sees pending files after the wait exits 2 and lists nothing", () => {
    const { run, calls } = remote({
      files: listing(["pending/a.ndjson"]),
      r2: { "pending/a.ndjson": "{}\n" },
      pending: [4],
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("pending/ still holds files");
    expect(run.stdout).not.toContain("clean");
    expect(calls).not.toContain("/__test/files");
    expect(calls).not.toContain("r2 object get");
  });

  it("DEMO-8 a remote scan skips a key that moved to loaded and counts the files it fetched", () => {
    const { run, calls } = remote({
      files: listing(["pending/gone.ndjson", "loaded/b.ndjson", "loaded/c.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n", "loaded/c.ndjson": "{}\n" },
    });
    expect(run.status).toBe(0);
    expect(calls).toContain("funnels-events/pending/gone.ndjson --remote --pipe");
    expect(run.stderr).toContain("pending/gone.ndjson is gone");
    expect(run.stdout).toContain("2 R2 files");
  });

  it("DEMO-8 a remote scan where every key is gone, or a get fails for another reason, exits 2", () => {
    const allGone = remote({ files: listing(["pending/gone.ndjson"]) });
    expect(allGone.run.status).toBe(2);
    expect(allGone.run.stdout).not.toContain("clean");
    expect(allGone.calls).not.toContain("d1 execute");

    const failing = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n", "loaded_b.ndjson.fail": "" },
    });
    expect(failing.run.status).toBe(2);
    expect(failing.run.stderr).toContain("cannot read loaded/b.ndjson");
  });

  it("DEMO-8 a remote scan with an empty tail log exits 2 and names the tail", () => {
    const { run } = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n" },
      tail: "",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("tail log has 0 lines");
    expect(run.stdout).not.toContain("clean");
  });

  it("DEMO-8 a remote scan with 0 events rows exits 2 and names the events query", () => {
    const { run } = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n" },
      rows: [],
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("events query returned 0 rows");
    expect(run.stdout).not.toContain("clean");
  });

  it("DEMO-8 a remote scan without jq, or with a d1 answer that is not JSON, exits 2 with a message", () => {
    const noJq = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n" },
      path: tmpDir(),
    });
    expect(noJq.run.status).toBe(2);
    expect(noJq.run.stderr).toContain("jq is required");

    const notJson = remote({
      files: listing(["loaded/b.ndjson"]),
      r2: { "loaded/b.ndjson": "{}\n" },
      rowsText: "wrangler is not logged in\n",
    });
    expect(notJson.run.status).toBe(2);
    expect(notJson.run.stderr).toContain("not the JSON");
    expect(notJson.run.stdout).not.toContain("clean");
  });

  it("DEMO-8 a remote scan with nothing after --remote is a usage error, not an unbound variable", () => {
    const run = scan(["--remote"], { BASE: "https://worker.invalid" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage");
    expect(run.stderr).not.toContain("unbound");
  });
});
