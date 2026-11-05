// Docs lint: runs the dash, email and link rules from scripts/lib/docs-rules.ts over tracked files.
// Usage: pnpm lint:docs. Part of pnpm check, so CI and the pre-commit hook enforce the writing rules.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  findBrokenLinks,
  findDashes,
  findEmails,
  formatFinding,
  type Finding,
} from "./lib/docs-rules.ts";

const root = path.join(import.meta.dirname, "..");
const EMAIL_EXTENSIONS = new Set([
  "md",
  "ts",
  "js",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "yml",
  "yaml",
  "sh",
  "sql",
  "toml",
  "txt",
]);

// Installed third-party skills are not ours to rewrite: the humanizer text quotes dashes as
// examples, and the security-audit files come from a pinned upstream (see skills-lock.json).
const VENDORED = [".agents/skills/", ".claude/skills/humanizer/"];

const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "" && !VENDORED.some((prefix) => f.startsWith(prefix)))
  .filter((f) => fs.statSync(path.join(root, f), { throwIfNoEntry: false })?.isFile());

const decoder = new TextDecoder("utf-8", { fatal: true });

function readText(file: string): string | null {
  const bytes = fs.readFileSync(path.join(root, file));
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function wantsEmailCheck(file: string): boolean {
  const base = path.posix.basename(file);
  if (base === "pnpm-lock.yaml") return false;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return true;
  return EMAIL_EXTENSIONS.has(base.slice(dot + 1));
}

const exists = (p: string) => fs.existsSync(path.join(root, p));

const findings: Finding[] = [];
let checked = 0;
for (const file of files) {
  const isMarkdown = file.endsWith(".md");
  const emails = wantsEmailCheck(file);
  if (!isMarkdown && !emails) continue;
  const text = readText(file);
  if (text === null) continue;
  checked += 1;
  if (isMarkdown) {
    findings.push(...findDashes(file, text), ...findBrokenLinks(file, text, exists));
  }
  if (emails) findings.push(...findEmails(file, text));
}

if (findings.length > 0) {
  for (const f of findings) console.log(formatFinding(f));
  console.log(`lint-docs: ${findings.length} findings`);
  process.exit(1);
}
console.log(`lint-docs: clean (${checked} files)`);
