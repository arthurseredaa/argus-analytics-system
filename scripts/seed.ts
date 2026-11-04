// Seed script: loads config/catalog-v1.json into the local or remote D1 database.
// Usage: pnpm seed --local | pnpm seed --remote. Run by Node 24 (types are stripped).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { renderSql, seedStatements, type CatalogFile } from "../src/db/seed.ts";
import { ConfigError, encrypt, importAesKey } from "../src/domain/crypto.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 1 || (args[0] !== "--local" && args[0] !== "--remote")) {
  fail("usage: pnpm seed --local | pnpm seed --remote");
}
const target = args[0] === "--local" ? "local" : "remote";

const root = path.join(import.meta.dirname, "..");
const varsName = target === "local" ? ".dev.vars" : ".dev.vars.remote";
// Values come from this file only, never from the shell environment.
let vars: Record<string, string | undefined>;
try {
  vars = parseEnv(fs.readFileSync(path.join(root, varsName), "utf8"));
} catch {
  fail(`cannot read ${varsName}`);
}

const file = JSON.parse(
  fs.readFileSync(path.join(root, "config", "catalog-v1.json"), "utf8"),
) as CatalogFile;

const required = [
  "MASTER_KEY",
  ...file.partners.map((p) => `PARTNER_SECRET_${p.id.toUpperCase()}`),
];
for (const name of required) {
  if (!vars[name]) fail(`missing variable ${name} in ${varsName}`);
}

let encrypted: Map<string, string>;
try {
  const key = await importAesKey(vars["MASTER_KEY"]!, "MASTER_KEY");
  encrypted = new Map<string, string>();
  for (const p of file.partners) {
    const secret = vars[`PARTNER_SECRET_${p.id.toUpperCase()}`]!;
    encrypted.set(p.id, await encrypt(key, secret));
  }
} catch (e) {
  fail(e instanceof ConfigError ? `${e.message} (in ${varsName})` : "encryption failed");
}
const sql = renderSql(seedStatements(file, encrypted, Date.now()));

const dir = fs.mkdtempSync(os.tmpdir() + "/seed-");
let status: number | null;
try {
  const sqlPath = path.join(dir, "seed.sql");
  fs.writeFileSync(sqlPath, sql, { mode: 0o600 });
  const run = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "facts", `--${target}`, "--file", sqlPath],
    { cwd: root, stdio: "inherit" },
  );
  status = run.status;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
if (status !== 0) fail(`wrangler d1 execute failed (exit ${status})`);
console.log(`seeded catalog version ${file.version}: ${file.offers.length} offers`);
