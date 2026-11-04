// DB: statements that load config/catalog-v1.json into D1, shared by the seed script and the tests.
// Implements ADR 0003 (catalog versions); serves OFF-1, PB-3. Erasable TypeScript only (Node runs it).

export type CatalogFile = {
  version: number;
  note: string;
  partners: { id: string; name: string }[];
  offers: {
    id: string;
    partner_id: string;
    name: string;
    ethnicity: string;
    genders: string[];
    epu: number;
    url: string;
    kind: string;
    active: boolean;
  }[];
};

export type Statement = { sql: string; params: (string | number | null)[] };

// Partners first, then the history row, then the offers that reference both. Every insert is
// ON CONFLICT DO NOTHING, so seeding twice changes nothing.
export function seedStatements(
  file: CatalogFile,
  partnerSecretsEnc: ReadonlyMap<string, string>,
  now: number,
): Statement[] {
  const out: Statement[] = [];
  for (const p of file.partners) {
    const enc = partnerSecretsEnc.get(p.id);
    if (enc === undefined) throw new Error(`no encrypted secret for partner ${p.id}`);
    out.push({
      sql: "INSERT INTO partners (id, name, active, secret_current_enc) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING",
      params: [p.id, p.name, enc],
    });
  }
  out.push({
    sql: "INSERT INTO catalog_history (version, created_at, changed_by, note) VALUES (?, ?, 'seed', ?) ON CONFLICT DO NOTHING",
    params: [file.version, now, file.note],
  });
  for (const o of file.offers) {
    out.push({
      sql: "INSERT INTO offers (version, id, partner_id, name, ethnicity, genders, epu, url, kind, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      params: [
        file.version,
        o.id,
        o.partner_id,
        o.name,
        o.ethnicity,
        JSON.stringify(o.genders),
        o.epu,
        o.url,
        o.kind,
        o.active ? 1 : 0,
      ],
    });
  }
  return out;
}

function literal(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replaceAll("'", "''")}'`;
}

// One SQL file with the values inlined, for `wrangler d1 execute --file`.
export function renderSql(statements: readonly Statement[]): string {
  return statements
    .map((s) => {
      let i = 0;
      const sql = s.sql.replace(/\?/g, () => literal(s.params[i++] as string | number | null));
      return `${sql};`;
    })
    .join("\n");
}
