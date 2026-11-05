// Pure rules of the docs lint: dashes, email addresses and relative links in repository text.
// Serves the writing rules in CLAUDE.md (no em dashes, no real emails). No Node imports, so tests type-check it.

export type Finding = {
  file: string;
  line: number;
  rule: "dash" | "email" | "link";
  detail: string;
};

export function formatFinding(f: Finding): string {
  return `${f.file}:${f.line}: ${f.rule}: ${f.detail}`;
}

const EM_DASH = "—";
const EN_DASH = "–";
const FENCE = /^\s*```/;
const QUOTE = /^\s*>/;

// Lines that are not inside a fenced block, with 1-based numbers. A fence line itself is skipped.
function proseLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inFence = false;
  text.split("\n").forEach((raw, i) => {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) out.push({ line: i + 1, text: raw });
  });
  return out;
}

export function findDashes(file: string, text: string): Finding[] {
  const found: Finding[] = [];
  for (const { line, text: content } of proseLines(text)) {
    if (QUOTE.test(content)) continue;
    if (content.includes(EM_DASH)) {
      found.push({ file, line, rule: "dash", detail: "em dash in prose" });
      continue;
    }
    for (let i = content.indexOf(EN_DASH); i !== -1; i = content.indexOf(EN_DASH, i + 1)) {
      const range = /\d/.test(content[i - 1] ?? "") && /\d/.test(content[i + 1] ?? "");
      if (!range) {
        found.push({ file, line, rule: "dash", detail: "en dash outside a numeric range" });
        break;
      }
    }
  }
  return found;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function findEmails(file: string, text: string): Finding[] {
  const found: Finding[] = [];
  text.split("\n").forEach((content, i) => {
    for (const match of content.matchAll(EMAIL)) {
      const address = match[0].toLowerCase();
      if (address.endsWith("@example.com") || address === "git@github.com") continue;
      found.push({ file, line: i + 1, rule: "email", detail: `address ${match[0]}` });
    }
  });
  return found;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// POSIX join of a directory and a relative path, resolving "." and "..".
function resolveRelative(dir: string, target: string): string {
  const parts = dir === "" || dir === "." ? [] : dir.split("/");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export function findBrokenLinks(
  file: string,
  text: string,
  exists: (path: string) => boolean,
): Finding[] {
  const found: Finding[] = [];
  const slash = file.lastIndexOf("/");
  const dir = slash === -1 ? "" : file.slice(0, slash);
  for (const { line, text: content } of proseLines(text)) {
    for (const match of content.matchAll(LINK)) {
      const raw = match[1] ?? "";
      if (raw.startsWith("#") || raw.startsWith("<") || raw.startsWith("mailto:")) continue;
      if (SCHEME.test(raw)) continue;
      const withoutAnchor = raw.split("#")[0] ?? "";
      if (withoutAnchor === "") continue;
      const resolved = resolveRelative(dir, withoutAnchor);
      if (!exists(resolved)) {
        found.push({ file, line, rule: "link", detail: `missing target ${resolved}` });
      }
    }
  }
  return found;
}
