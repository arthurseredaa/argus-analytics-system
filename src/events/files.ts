// Events: the R2 key layout and small helpers for the NDJSON files the producer, consumer and loader share.
// Implements ADR 0005 "Path of an event" and ADR 0006 "Loader"; serves NFR-4, NFR-5, R-16.
// A key sorts by write time, so listing `pending/` in key order gives the oldest file first.

export const PENDING_PREFIX = "pending/";
export const BATCHES_PREFIX = "batches/";
export const LOADED_PREFIX = "loaded/";
export const REJECTED_PREFIX = "rejected/";
export const PAUSE_KEY = "control/loader-paused";
export const LAST_LOAD_KEY = "control/last-load.json";
// Written by the alert run: { rejected_checked_at, quarantine_checked_at, sizes_checked_at }.
export const ALERT_STATE_KEY = "control/alert-state.json";

export const NDJSON_PUT: R2PutOptions = { httpMetadata: { contentType: "application/x-ndjson" } };

const LIST_PAGE = 1000;
const DELETE_CHUNK = 1000;

// `pending/<ms>-b-<uuid>.ndjson` for a consumer batch, `pending/<ms>-e-<event_id>.ndjson` for a
// producer fallback file. `<ms>` is padded to 13 digits so key order is write order.
export function pendingKey(kind: "batch" | "event", at: number, id: string): string {
  return `${PENDING_PREFIX}${String(at).padStart(13, "0")}-${kind === "batch" ? "b" : "e"}-${id}.ndjson`;
}

// One JSON value per line, each line ending in a newline.
export function toNdjson(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

// Lists in pages of 1,000, in key order, until `max` keys; `truncated` says there are more.
export async function listKeys(
  bucket: R2Bucket,
  prefix: string,
  max: number,
): Promise<{ keys: { key: string; uploaded: number }[]; truncated: boolean }> {
  const keys: { key: string; uploaded: number }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({
      prefix,
      limit: Math.min(LIST_PAGE, max - keys.length + 1),
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      if (keys.length === max) return { keys, truncated: true };
      keys.push({ key: object.key, uploaded: object.uploaded.getTime() });
    }
    if (!page.truncated) return { keys, truncated: false };
    cursor = page.cursor;
  }
}

export async function deleteKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_CHUNK) {
    await bucket.delete(keys.slice(i, i + DELETE_CHUNK));
  }
}
