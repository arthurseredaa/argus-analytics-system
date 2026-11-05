// Events: the pipeline health read behind GET /__test/health (pending files, last load, freshness, pause flag).
// Implements ADR 0005 "Buffer limits" and metrics-and-operations.md "Alerts"; serves NFR-3, NFR-4, NFR-5.
import { newestEventAt } from "../db/events.ts";
import { BATCHES_PREFIX, LAST_LOAD_KEY, PAUSE_KEY, PENDING_PREFIX, listKeys } from "./files.ts";

// Counting stops here; `pending_truncated` says there are more.
const PENDING_COUNT_MAX = 10_000;

export type PipelineHealth = {
  as_of: number;
  loader_paused: boolean;
  pending_files: number;
  pending_truncated: boolean;
  pending_oldest_age_ms: number | null;
  open_batches: number;
  last_load_at: number | null;
  events_newest_at: number | null;
  freshness_ms: number | null;
};

// `control/last-load.json` is written by the loader after a run that loaded files: { at, files, rows }.
async function readLastLoadAt(bucket: R2Bucket): Promise<number | null> {
  const object = await bucket.get(LAST_LOAD_KEY);
  if (object === null) return null;
  try {
    const parsed = JSON.parse(await object.text()) as { at?: unknown };
    return typeof parsed.at === "number" ? parsed.at : null;
  } catch {
    return null;
  }
}

export async function readHealth(
  env: Pick<Env, "EVENTS_BUCKET" | "EVENTS">,
  now: number,
): Promise<PipelineHealth> {
  const [paused, pending, batches, lastLoadAt, newestAt] = await Promise.all([
    env.EVENTS_BUCKET.head(PAUSE_KEY),
    listKeys(env.EVENTS_BUCKET, PENDING_PREFIX, PENDING_COUNT_MAX),
    listKeys(env.EVENTS_BUCKET, BATCHES_PREFIX, PENDING_COUNT_MAX),
    readLastLoadAt(env.EVENTS_BUCKET),
    newestEventAt(env.EVENTS),
  ]);
  const oldest = pending.keys.reduce<number | null>(
    (min, k) => (min === null || k.uploaded < min ? k.uploaded : min),
    null,
  );
  return {
    as_of: now,
    loader_paused: paused !== null,
    pending_files: pending.keys.length,
    pending_truncated: pending.truncated,
    pending_oldest_age_ms: oldest === null ? null : Math.max(0, now - oldest),
    open_batches: batches.keys.length,
    last_load_at: lastLoadAt,
    events_newest_at: newestAt,
    freshness_ms: newestAt === null ? null : now - newestAt,
  };
}
