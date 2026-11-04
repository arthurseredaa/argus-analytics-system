// Test fixture: reads the catalog table and the decision table out of offer-selection.md,
// so no row is copied into a test file (P-9). A reworded table makes the parser throw.
import catalogJson from "../../config/catalog-v1.json";
import type { Catalog, Offer } from "../../src/domain/catalog.ts";
import type { Moment, Reason, Selection } from "../../src/domain/select.ts";

export type SpecOffer = {
  id: string;
  name: string;
  ethnicity: string;
  genders: string[];
  epu: number;
  url: string;
  kind: string;
};

export type CatalogChange =
  | { type: "disable"; offerId: string }
  | { type: "remove"; offerId: string }
  | { type: "epu"; offerId: string; epu: number };

export type DecisionRow = {
  n: number;
  answers: { gender?: string; ethnicity?: string; email?: string };
  answersLabel: string;
  leads: { offerId: string; acceptedAt: number }[];
  change: CatalogChange[];
  expected: Pick<Selection, "action" | "offerId">;
  reason: Reason;
  moments: Moment[];
  bothMoments: boolean;
};

const CATALOG_HEADER = "| ID | Name | Partner ethnicity | Partner gender | EPU, USD | URL | Kind |";
const DECISION_HEADER = "| # | Answers | Lead | Catalog change | Expected | Reason | Source |";
const REASONS = ["lead_return", "best_epu", "fallback_universal", "no_offer"];

function tableRows(md: string, heading: string, header: string): string[][] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const headerAt = lines.findIndex((l, i) => i > start && l.trim().startsWith("|"));
  if (headerAt < 0 || lines[headerAt]?.trim() !== header)
    throw new Error(`table header under "${heading}" is not: ${header}`);
  const rows: string[][] = [];
  for (let i = headerAt + 2; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  }
  return rows;
}

export function parseCatalogTable(md: string): SpecOffer[] {
  return tableRows(md, "## Catalog (from the spec)", CATALOG_HEADER).map((c) => {
    const [id, name, ethnicity, gender, epu, url, kind] = c;
    if (!id || !name || !ethnicity || !gender || !epu || !url || !kind)
      throw new Error(`catalog row is incomplete: ${c.join("|")}`);
    return {
      id,
      name,
      ethnicity,
      genders: gender.split(",").map((g) => g.trim()),
      epu: Number(epu),
      url,
      kind,
    };
  });
}

function parseAnswers(cell: string, n: number) {
  const parts = cell.split(", ");
  const head = parts[0] ?? "";
  const answers: DecisionRow["answers"] = {};
  let atEntry = false;
  if (head !== "none") {
    const only = /^(women|men) only$/.exec(head);
    const both = /^(women|men) \+ (asia|europe|latam)$/.exec(head);
    if (only) answers.gender = only[1]!;
    else if (both) {
      answers.gender = both[1]!;
      answers.ethnicity = both[2]!;
    } else throw new Error(`row ${n}: unknown answers: ${head}`);
  }
  for (const extra of parts.slice(1)) {
    const email = /^email `([^`]+)`$/.exec(extra);
    if (extra === "at entry") atEntry = true;
    else if (email) answers.email = email[1]!;
    else throw new Error(`row ${n}: unknown answers part: ${extra}`);
  }
  return { answers, atEntry, label: head.replace(/ \+ /g, "+").replace(/ /g, "-") };
}

function parseLeads(cell: string, n: number) {
  if (cell === "none") return [];
  const ids = cell.split(" then ");
  if (!ids.every((id) => /^\d{3}$/.test(id))) throw new Error(`row ${n}: unknown lead: ${cell}`);
  return ids.map((offerId, i) => ({ offerId, acceptedAt: (i + 1) * 1000 }));
}

function parseChange(cell: string, n: number): CatalogChange[] {
  if (cell === "none") return [];
  let m = /^(\d{3})(?: and (\d{3}))? disabled$/.exec(cell);
  if (m)
    return [m[1]!, m[2]].flatMap((id) => (id ? [{ type: "disable" as const, offerId: id }] : []));
  m = /^(\d{3}) removed$/.exec(cell);
  if (m) return [{ type: "remove", offerId: m[1]! }];
  m = /^(\d{3}) EPU set to (\d+\.\d+)$/.exec(cell);
  if (m) return [{ type: "epu", offerId: m[1]!, epu: Number(m[2]) }];
  throw new Error(`row ${n}: unknown catalog change: ${cell}`);
}

function parseExpected(cell: string, n: number): Pick<Selection, "action" | "offerId"> {
  const id = /^(\d{3})\b/.exec(cell);
  if (id) return { action: "redirect", offerId: id[1]! };
  if (cell === "No offer available") return { action: "no_offer", offerId: null };
  if (cell.startsWith("quiz")) return { action: "quiz", offerId: null };
  throw new Error(`row ${n}: unknown expected: ${cell}`);
}

export function parseDecisionTable(md: string): DecisionRow[] {
  return tableRows(md, "## Decision table (expected results)", DECISION_HEADER).map((c) => {
    const [num, ans, lead, change, exp, reasonCell] = c;
    const n = Number(num);
    if (
      !Number.isInteger(n) ||
      ans === undefined ||
      lead === undefined ||
      change === undefined ||
      exp === undefined ||
      reasonCell === undefined
    )
      throw new Error(`bad decision row: ${c.join("|")}`);
    const a = parseAnswers(ans, n);
    const leads = parseLeads(lead, n);
    const expected = parseExpected(exp, n);
    const token = (reasonCell.split(",")[0] ?? "").trim();
    let reason: Reason;
    if (expected.action === "quiz") reason = "quiz_needed";
    else if (REASONS.includes(token)) reason = token as Reason;
    else throw new Error(`row ${n}: unknown reason: ${reasonCell}`);
    const bothMoments = leads.length > 0;
    const moments: Moment[] = bothMoments
      ? ["entry", "completion"]
      : a.atEntry || n === 24
        ? ["entry"]
        : ["completion"];
    return {
      n,
      answers: a.answers,
      answersLabel: a.label,
      leads,
      change: parseChange(change, n),
      expected,
      reason,
      moments,
      bothMoments,
    };
  });
}

export function applyChanges(catalog: Catalog, changes: readonly CatalogChange[]): Catalog {
  let offers: Offer[] = [...catalog.offers];
  for (const ch of changes) {
    if (ch.type === "remove") offers = offers.filter((o) => o.id !== ch.offerId);
    else
      offers = offers.map((o) =>
        o.id !== ch.offerId
          ? o
          : ch.type === "disable"
            ? { ...o, active: false }
            : { ...o, epu: ch.epu },
      );
  }
  return { version: catalog.version, offers };
}

export function catalogV1(): Catalog {
  return {
    version: catalogJson.version,
    offers: catalogJson.offers.map((o) => ({
      id: o.id,
      partnerId: o.partner_id,
      name: o.name,
      ethnicity: o.ethnicity,
      genders: o.genders,
      epu: o.epu,
      url: o.url,
      kind: o.kind as Offer["kind"],
      active: o.active,
    })),
  };
}
