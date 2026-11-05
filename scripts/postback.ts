// Postback script: sends a signed Lead or Purchase postback to a local or deployed Worker.
// Usage: pnpm postback lead|purchase --click <id> --txn <id> [--partner partnerA] [--payout 25.00]
// [--currency USD] [--base <url>]. Implements ADR 0007; serves PB-7, DEMO-3, DEMO-6.
// Run by Node 24 (types are stripped). The secret is read from .dev.vars for a localhost base and
// from .dev.vars.remote otherwise, never from the shell environment. A redirect is never followed.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { buildPostbackRequest } from "./lib/postback-request.ts";

const USAGE =
  "usage: pnpm postback lead|purchase --click <id> --txn <id> [--partner partnerA] [--payout 25.00] [--currency USD] [--base <url>]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      click: { type: "string" },
      txn: { type: "string" },
      partner: { type: "string" },
      payout: { type: "string" },
      currency: { type: "string" },
      base: { type: "string" },
    },
  });
} catch {
  fail(USAGE);
}
const { values, positionals } = parsed;
const type = positionals[0];
if (positionals.length !== 1 || (type !== "lead" && type !== "purchase")) fail(USAGE);
const click = values["click"] as string | undefined;
const txn = values["txn"] as string | undefined;
if (!click || !txn) fail(USAGE);

const partner = (values["partner"] as string | undefined) ?? "partnerA";
const base =
  (values["base"] as string | undefined) ?? process.env["BASE"] ?? "http://localhost:8787";
let baseUrl: URL;
try {
  baseUrl = new URL(base);
} catch {
  fail(`${USAGE}\nthe base is not a URL`);
}

const local = baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1";
const varsName = local ? ".dev.vars" : ".dev.vars.remote";
const secretName = `PARTNER_SECRET_${partner.toUpperCase()}`;
const root = path.join(import.meta.dirname, "..");
let vars: Record<string, string | undefined>;
try {
  vars = parseEnv(fs.readFileSync(path.join(root, varsName), "utf8"));
} catch {
  fail(`cannot read ${varsName}`);
}
const secret = vars[secretName];
if (!secret) fail(`missing variable ${secretName} in ${varsName}`);

const { url, init } = await buildPostbackRequest({
  base,
  partner,
  type,
  clickId: click,
  transactionId: txn,
  secret,
  nowMs: Date.now(),
  ...(values["payout"] === undefined ? {} : { payout: values["payout"] as string }),
  ...(values["currency"] === undefined ? {} : { currency: values["currency"] as string }),
});
const res = await fetch(url, init);
console.log(`${res.status} ${await res.text()}`);
