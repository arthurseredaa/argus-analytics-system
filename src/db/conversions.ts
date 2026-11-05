// DB: partners, conversions and the quarantine, as the postback endpoint reads and writes them.
// Implements ADR 0007 and ADR 0003 (facts in D1); serves PB-3, PB-4, PB-5, Q-11, R-4.
export type PartnerRow = {
  active: boolean;
  secretCurrentEnc: string;
  secretPreviousEnc: string | null;
};

export async function readPartner(db: D1Database, id: string): Promise<PartnerRow | null> {
  const row = await db
    .prepare("SELECT active, secret_current_enc, secret_previous_enc FROM partners WHERE id = ?1")
    .bind(id)
    .first<{ active: number; secret_current_enc: string; secret_previous_enc: string | null }>();
  if (row === null) return null;
  return {
    active: row.active === 1,
    secretCurrentEnc: row.secret_current_enc,
    secretPreviousEnc: row.secret_previous_enc,
  };
}

export type ConversionInsert = {
  partnerId: string;
  type: "lead" | "purchase";
  transactionId: string;
  clickId: string;
  occurredAt: number;
  acceptedAt: number;
  payout: number | null;
  currency: string | null;
  partnerUserId: string | null;
};

// `inserted: false` is a redelivery: the unique key (partner_id, type, transaction_id) already
// holds a row, and that row is left as it was (R-4, PB-5).
export async function insertConversion(
  db: D1Database,
  row: ConversionInsert,
): Promise<{ inserted: boolean }> {
  const result = await db
    .prepare(
      `INSERT INTO conversions (partner_id, type, transaction_id, click_id, occurred_at, accepted_at,
                                payout, currency, partner_user_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (partner_id, type, transaction_id) DO NOTHING
       RETURNING id`,
    )
    .bind(
      row.partnerId,
      row.type,
      row.transactionId,
      row.clickId,
      row.occurredAt,
      row.acceptedAt,
      row.payout,
      row.currency,
      row.partnerUserId,
    )
    .first<{ id: number }>();
  return { inserted: result !== null };
}

export type QuarantineInsert = {
  partnerId: string;
  type: string | null;
  transactionId: string | null;
  clickId: string | null;
  body: string;
  reason: "unknown_click";
  receivedAt: number;
};

export async function insertQuarantine(db: D1Database, row: QuarantineInsert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO quarantine (partner_id, type, transaction_id, click_id, body, reason, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      row.partnerId,
      row.type,
      row.transactionId,
      row.clickId,
      row.body,
      row.reason,
      row.receivedAt,
    )
    .run();
}
