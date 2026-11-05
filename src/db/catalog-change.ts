// DB: the statements that write catalog version n+1 as a copy of version n with one change.
// Implements ADR 0003 (catalog versions); serves OFF-1, OFF-2, Q-9. Shared by the offer script and the tests.
// Erasable TypeScript only (Node runs it).
import type { Statement } from "./seed.ts";

export type CatalogChange =
  | { kind: "status"; offerId: string; active: boolean }
  | { kind: "epu"; offerId: string; epu: number };

// The history row comes first: offers.version references it. The history primary key makes a
// second writer of the same version fail, and its offers copy then fails on (version, id) too.
export function catalogChangeStatements(
  current: number,
  change: CatalogChange,
  now: number,
): Statement[] {
  const next = current + 1;
  const note =
    change.kind === "status"
      ? `set-status ${change.offerId} ${change.active ? "active" : "inactive"}`
      : `set-epu ${change.offerId} ${change.epu}`;
  const epu = change.kind === "epu" ? "CASE WHEN id = ? THEN ? ELSE epu END" : "epu";
  const active = change.kind === "status" ? "CASE WHEN id = ? THEN ? ELSE active END" : "active";
  const value = change.kind === "status" ? (change.active ? 1 : 0) : change.epu;
  return [
    {
      sql: "INSERT INTO catalog_history (version, created_at, changed_by, note) VALUES (?, ?, 'offer-script', ?)",
      params: [next, now, note],
    },
    {
      sql: `INSERT INTO offers (version, id, partner_id, name, ethnicity, genders, epu, url, kind, active)
SELECT ?, id, partner_id, name, ethnicity, genders, ${epu}, url, kind, ${active}
FROM offers WHERE version = ?`,
      params: [next, change.offerId, value, current],
    },
  ];
}
