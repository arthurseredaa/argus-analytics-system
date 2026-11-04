// Domain: catalog types and validation of offer rows read from D1.
// Implements ADR 0003 (catalog versions) and ADR 0004 (incomplete rows are excluded and reported).
// Serves OFF-1, OFF-6, OFF-8.

export type Offer = {
  id: string;
  partnerId: string;
  name: string;
  ethnicity: string;
  genders: readonly string[];
  epu: number;
  url: string;
  kind: "specialised" | "universal";
  active: boolean;
};

export type Catalog = { version: number | null; offers: readonly Offer[] };

// The D1 row; `genders` is JSON text.
export type OfferRow = {
  id: string;
  partner_id: string;
  name: string;
  ethnicity: string;
  genders: string;
  epu: number;
  url: string;
  kind: string;
  active: number;
};

export type CatalogError = { offerId: string; problem: string };

const ETHNICITIES: readonly string[] = ["asia", "europe", "latam", "any"];
const GENDERS: readonly string[] = ["women", "men"];

function parseGenders(text: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((g) => typeof g === "string" && GENDERS.includes(g))) return null;
  return value as string[];
}

function toKind(kind: string): Offer["kind"] | null {
  return kind === "specialised" || kind === "universal" ? kind : null;
}

export function parseCatalog(
  version: number | null,
  rows: readonly OfferRow[],
): { catalog: Catalog; errors: CatalogError[] } {
  const offers: Offer[] = [];
  const errors: CatalogError[] = [];
  for (const row of rows) {
    const genders = parseGenders(row.genders);
    const kind = toKind(row.kind);
    let problem: string | null = null;
    if (!ETHNICITIES.includes(row.ethnicity)) problem = "ethnicity is missing or unknown";
    else if (genders === null) problem = "genders is not a non-empty list of women/men";
    else if (kind === null) problem = "kind is unknown";
    else if (typeof row.epu !== "number" || !Number.isFinite(row.epu) || row.epu < 0)
      problem = "epu is not a number of at least 0";
    else if (typeof row.url !== "string" || !row.url.startsWith("https://"))
      problem = "url does not start with https://";
    if (problem !== null || genders === null || kind === null) {
      errors.push({ offerId: row.id, problem: problem ?? "invalid row" });
      continue;
    }
    offers.push({
      id: row.id,
      partnerId: row.partner_id,
      name: row.name,
      ethnicity: row.ethnicity,
      genders,
      epu: row.epu,
      url: row.url,
      kind,
      active: row.active === 1,
    });
  }
  return { catalog: { version, offers }, errors };
}
