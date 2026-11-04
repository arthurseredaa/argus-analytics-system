import { describe, expect, it } from "vitest";
import catalogJson from "../../config/catalog-v1.json";
import md from "../../docs/requirements/offer-selection.md?raw";
import { parseCatalog, type OfferRow } from "../../src/domain/catalog.ts";
import { parseCatalogTable } from "../fixtures/decision-table.ts";

const rowsV1 = (): OfferRow[] =>
  catalogJson.offers.map((o) => ({
    id: o.id,
    partner_id: o.partner_id,
    name: o.name,
    ethnicity: o.ethnicity,
    genders: JSON.stringify(o.genders),
    epu: o.epu,
    url: o.url,
    kind: o.kind,
    active: o.active ? 1 : 0,
  }));

describe("catalog", () => {
  it("OFF-1 seed catalog equals the spec catalog", () => {
    const spec = parseCatalogTable(md);
    expect(spec).toHaveLength(7);
    const seed = catalogJson.offers.map(({ id, name, ethnicity, genders, epu, url, kind }) => ({
      id,
      name,
      ethnicity,
      genders,
      epu,
      url,
      kind,
    }));
    expect(seed).toEqual(spec);
    expect(catalogJson.offers.every((o) => o.active === true)).toBe(true);
  });

  it("OFF-6 a duplicate offer id is reported and the repeat is excluded", () => {
    const rows = rowsV1();
    const { catalog, errors } = parseCatalog(1, [...rows, { ...rows[0]!, name: "Repeat" }]);
    expect(errors).toEqual([{ offerId: rows[0]!.id, problem: "offer id is not unique" }]);
    expect(catalog.offers).toHaveLength(7);
    expect(catalog.offers.find((o) => o.id === rows[0]!.id)?.name).toBe(rows[0]!.name);
  });

  it("OFF-6 incomplete offer row is excluded and reported", () => {
    const rows = rowsV1().map((r) => (r.id === "006" ? { ...r, ethnicity: "" } : r));
    const { catalog, errors } = parseCatalog(1, rows);
    expect(catalog.offers).toHaveLength(6);
    expect(errors).toEqual([{ offerId: "006", problem: expect.any(String) }]);
    expect(catalog.offers.find((o) => o.id === "007")).toMatchObject({
      ethnicity: "any",
      kind: "universal",
    });
  });

  it("OFF-8 no rows give an empty catalog and no errors", () => {
    expect(parseCatalog(null, [])).toEqual({ catalog: { version: null, offers: [] }, errors: [] });
  });
});
