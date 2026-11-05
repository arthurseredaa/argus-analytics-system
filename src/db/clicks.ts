// DB: the click written at the transition to an offer, before the 302.
// Implements ADR 0003 (facts in D1) and ADR 0007 (click id); serves OFF-11, PB-4.
export type Click = {
  clickId: string;
  userId: string | null;
  offerId: string;
  catalogVersion: number;
  prelanderId: string;
  visitId: string;
  reason: "lead_return" | "best_epu" | "fallback_universal";
  createdAt: number;
};

export async function insertClick(db: D1Database, click: Click): Promise<void> {
  await db
    .prepare(
      `INSERT INTO clicks (click_id, user_id, offer_id, catalog_version, prelander_id, visit_id, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      click.clickId,
      click.userId,
      click.offerId,
      click.catalogVersion,
      click.prelanderId,
      click.visitId,
      click.reason,
      click.createdAt,
    )
    .run();
}

export type PostbackClick = {
  clickId: string;
  userId: string | null;
  offerId: string;
  catalogVersion: number;
  prelanderId: string;
  visitId: string;
  offerPartnerId: string;
};

// The click a postback names, with the partner of its offer in the catalog version it was made
// under, so a later catalog change cannot move a click to another partner (Q-24).
export async function findClickForPostback(
  db: D1Database,
  clickId: string,
): Promise<PostbackClick | null> {
  const row = await db
    .prepare(
      `SELECT c.click_id, c.user_id, c.offer_id, c.catalog_version, c.prelander_id, c.visit_id,
              o.partner_id
       FROM clicks c JOIN offers o ON o.version = c.catalog_version AND o.id = c.offer_id
       WHERE c.click_id = ?1`,
    )
    .bind(clickId)
    .first<{
      click_id: string;
      user_id: string | null;
      offer_id: string;
      catalog_version: number;
      prelander_id: string;
      visit_id: string;
      partner_id: string;
    }>();
  if (row === null) return null;
  return {
    clickId: row.click_id,
    userId: row.user_id,
    offerId: row.offer_id,
    catalogVersion: row.catalog_version,
    prelanderId: row.prelander_id,
    visitId: row.visit_id,
    offerPartnerId: row.partner_id,
  };
}
