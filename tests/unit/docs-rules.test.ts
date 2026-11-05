import { describe, expect, it } from "vitest";
import {
  findBrokenLinks,
  findDashes,
  findEmails,
  formatFinding,
} from "../../scripts/lib/docs-rules.ts";

// The offending addresses are assembled from this constant so that lint-docs, which also reads
// this test file, does not flag them.
const AT = "@";

describe("lint-docs dashes", () => {
  it("lint-docs an em dash in prose is a finding", () => {
    const found = findDashes("a.md", "line one\na — b\nline three");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "a.md", line: 2, rule: "dash" });
  });

  it("lint-docs an en dash between digits is allowed", () => {
    expect(findDashes("a.md", "30–40 hours")).toEqual([]);
  });

  it("lint-docs an en dash between words is a finding", () => {
    expect(findDashes("a.md", "fast – slow")).toHaveLength(1);
  });

  it("lint-docs a quoted line and a fenced block are skipped", () => {
    expect(findDashes("a.md", "> a — b")).toEqual([]);
    expect(findDashes("a.md", "  > a — b")).toEqual([]);
    expect(findDashes("a.md", "```\na — b\n```")).toEqual([]);
  });

  it("lint-docs a line after a closed fence is checked again", () => {
    const found = findDashes("a.md", "```\nx\n```\na — b");
    expect(found.map((f) => f.line)).toEqual([4]);
  });
});

describe("lint-docs emails", () => {
  it("lint-docs an address outside example.com is a finding", () => {
    const address = `user${AT}gmail.com`;
    const found = findEmails("a.md", `contact ${address} now`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "email", line: 1 });
    expect(found[0]?.detail).toContain(address);
  });

  it("lint-docs example.com, .example hosts and git@github.com pass", () => {
    const text = "user1@example.com https://asia-connect.example git@github.com USER2@EXAMPLE.COM";
    expect(findEmails("a.md", text)).toEqual([]);
  });

  it("lint-docs an address inside a JSON string is a finding", () => {
    const text = `{"email":"a${AT}b.co"}`;
    expect(findEmails("a.json", text)).toHaveLength(1);
  });

  it("lint-docs a host that only ends in example.com is a finding", () => {
    const text = `user${AT}notexample.com`;
    expect(findEmails("a.md", text)).toHaveLength(1);
  });
});

describe("lint-docs links", () => {
  it("lint-docs a missing relative target is a finding", () => {
    const found = findBrokenLinks("docs/design/a.md", "see [x](../adr/0099.md)", () => false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "link", line: 1 });
    expect(found[0]?.detail).toContain("docs/adr/0099.md");
  });

  it("lint-docs anchors, absolute URLs, mailto and code blocks are skipped", () => {
    const text = "[a](#top) [b](https://x.y) [c](mailto:u@example.com)\n```\n[d](nope.md)\n```";
    expect(findBrokenLinks("a.md", text, () => false)).toEqual([]);
  });

  it("lint-docs an anchor on an existing file resolves the file", () => {
    const seen: string[] = [];
    const found = findBrokenLinks("docs/a.md", "[x](design.md#10-how)", (p) => {
      seen.push(p);
      return true;
    });
    expect(found).toEqual([]);
    expect(seen).toEqual(["docs/design.md"]);
  });

  it("lint-docs templates and spaced targets are skipped, images are checked", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return false;
    };
    expect(findBrokenLinks("a.md", "[x](<my file.md>) [y](a b.md)", exists)).toEqual([]);
    expect(findBrokenLinks("a.md", "![img](pic.png)", exists)).toHaveLength(1);
    expect(seen).toEqual(["pic.png"]);
  });
});

describe("lint-docs format", () => {
  it("lint-docs a finding prints as file:line: rule: detail", () => {
    expect(formatFinding({ file: "a.md", line: 3, rule: "dash", detail: "em dash" })).toBe(
      "a.md:3: dash: em dash",
    );
  });
});
