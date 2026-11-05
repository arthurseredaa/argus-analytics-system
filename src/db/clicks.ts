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
