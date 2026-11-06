// Events: the loader, a cron job that moves NDJSON files from R2 pending/ into the events table.
// Implements ADR 0005 "MVP: D1 as the stand-in for BigQuery" and ADR 0006 "Loader"; serves NFR-3, NFR-5, R-8, R-16.
// Every step can be repeated: a manifest names the files of a batch, and an insert that meets a stored event_id skips it.
import { z } from "zod";
import { insertEvents, pingEvents } from "../db/events.ts";
import { storedEventSchema, type StoredEvent } from "./envelope.ts";
import {
  BATCHES_PREFIX,
  LAST_LOAD_KEY,
  LOADED_PREFIX,
  NDJSON_PUT,
  PAUSE_KEY,
  PENDING_PREFIX,
  REJECTED_PREFIX,
  deleteKeys,
  listKeys,
  toNdjson,
} from "./files.ts";

export const LOADER_CRON = "* * * * *";

export type LoaderLimits = {
  maxFilesPerRun: number;
  maxRowsPerBatch: number;
  maxBatchesPerRun: number;
  maxAttempts: number;
};

// 9,000 files stays under the 10,000 subrequests of an invocation. 8 batches of 900 rows are
// 800 insert statements, under the 1,000 D1 queries of an invocation (decision 6 of the stage 5 plan).
export const LOADER_LIMITS: LoaderLimits = {
  maxFilesPerRun: 9000,
  maxRowsPerBatch: 900,
  maxBatchesPerRun: 8,
  maxAttempts: 5,
};

export type LoaderEnv = { EVENTS_BUCKET: R2Bucket; EVENTS: D1Database };

export type BatchManifest = {
  batch_id: string;
  files: string[];
  attempt: number;
  created_at: number;
};

export type LoaderRun = {
  status: "paused" | "done" | "d1_unreachable" | "batch_failed";
  batchIds: string[];
  files: number;
  rows: number;
  duplicates: number;
  invalid: number;
  rejected: number;
};

// A Worker invocation holds at most 6 open connections at once.
const READ_CONCURRENCY = 6;

const manifestSchema = z.object({
  batch_id: z.string(),
  files: z.array(z.string()),
  attempt: z.int().min(1),
  created_at: z.number(),
});

// The first 32 hex characters of SHA-256 over the sorted keys joined by a newline, so the same
// files always give the same id.
export async function batchId(keys: readonly string[]): Promise<string> {
  const data = new TextEncoder().encode(keys.toSorted().join("\n"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

type Source = { key: string; text: string };

// What the run keeps besides the counts it returns.
type Totals = { loadedFiles: number; loadedRows: number; failed: boolean; unreachable: boolean };

const linesIn = (text: string): string[] => text.split("\n").filter((line) => line.trim() !== "");

const manifestKey = (id: string) => `${BATCHES_PREFIX}${id}.json`;

// Reads the files 6 at a time; a file that is gone comes back as null.
async function readFiles(bucket: R2Bucket, keys: readonly string[]): Promise<(Source | null)[]> {
  const sources: (Source | null)[] = [];
  for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
    const chunk = keys.slice(i, i + READ_CONCURRENCY);
    sources.push(
      ...(await Promise.all(
        chunk.map(async (key) => {
          const object = await bucket.get(key);
          return object === null ? null : { key, text: await object.text() };
        }),
      )),
    );
  }
  return sources;
}

// Valid rows (the first one per event_id), the raw lines that failed the check, and the repeat count.
function parseBatch(sources: readonly Source[]): {
  rows: StoredEvent[];
  invalidLines: string[];
  duplicates: number;
} {
  const rows: StoredEvent[] = [];
  const invalidLines: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const source of sources) {
    for (const line of linesIn(source.text)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        invalidLines.push(line);
        continue;
      }
      const checked = storedEventSchema.safeParse(parsed);
      if (!checked.success) {
        invalidLines.push(line);
      } else if (seen.has(checked.data.event_id)) {
        duplicates += 1;
      } else {
        seen.add(checked.data.event_id);
        rows.push(checked.data);
      }
    }
  }
  return { rows, invalidLines, duplicates };
}

// Loads one batch. A new batch gets its manifest first; a resumed one already has it.
async function processBatch(
  env: LoaderEnv,
  manifest: BatchManifest,
  sources: readonly Source[],
  isNew: boolean,
  limits: LoaderLimits,
  run: LoaderRun,
  totals: Totals,
): Promise<void> {
  const bucket = env.EVENTS_BUCKET;
  const { rows, invalidLines, duplicates } = parseBatch(sources);
  run.batchIds.push(manifest.batch_id);
  run.files += sources.length;
  run.rows += rows.length;
  run.duplicates += duplicates;
  run.invalid += invalidLines.length;

  if (isNew) await bucket.put(manifestKey(manifest.batch_id), JSON.stringify(manifest));

  const writeInvalid = async () => {
    if (invalidLines.length === 0) return;
    await bucket.put(
      `${REJECTED_PREFIX}${manifest.batch_id}-invalid.ndjson`,
      invalidLines.map((line) => `${line}\n`).join(""),
      NDJSON_PUT,
    );
  };
  const close = async () => {
    await deleteKeys(bucket, manifest.files);
    await bucket.delete(manifestKey(manifest.batch_id));
  };

  try {
    await insertEvents(env.EVENTS, rows);
  } catch (err) {
    // The class name only: an error message can quote the rows it failed on.
    const name = err instanceof Error ? err.name : "unknown";
    console.log(
      JSON.stringify({
        msg: "loader_batch_failed",
        batch_id: manifest.batch_id,
        attempt: manifest.attempt,
        name,
      }),
    );
    // An outage is not a failed load: the attempt number stays and the run stops (decision 7).
    if (!(await pingEvents(env.EVENTS))) {
      console.log(JSON.stringify({ msg: "loader_d1_unreachable", batch_id: manifest.batch_id }));
      totals.unreachable = true;
      return;
    }
    totals.failed = true;
    if (manifest.attempt < limits.maxAttempts) {
      const next: BatchManifest = { ...manifest, attempt: manifest.attempt + 1 };
      await bucket.put(manifestKey(manifest.batch_id), JSON.stringify(next));
      return;
    }
    await bucket.put(`${REJECTED_PREFIX}${manifest.batch_id}.ndjson`, toNdjson(rows), NDJSON_PUT);
    await writeInvalid();
    await close();
    run.rejected += 1;
    console.log(
      JSON.stringify({
        msg: "loader_batch_rejected",
        batch_id: manifest.batch_id,
        files: manifest.files.length,
      }),
    );
    return;
  }

  // A resumed manifest whose files are all gone was closed by an earlier run: write no new file.
  if (rows.length > 0) {
    await bucket.put(`${LOADED_PREFIX}${manifest.batch_id}.ndjson`, toNdjson(rows), NDJSON_PUT);
  }
  await writeInvalid();
  await close();
  totals.loadedFiles += sources.length;
  totals.loadedRows += rows.length;
}

export async function runLoader(
  env: LoaderEnv,
  now: number,
  limits: LoaderLimits = LOADER_LIMITS,
): Promise<LoaderRun> {
  const bucket = env.EVENTS_BUCKET;
  const run: LoaderRun = {
    status: "done",
    batchIds: [],
    files: 0,
    rows: 0,
    duplicates: 0,
    invalid: 0,
    rejected: 0,
  };

  if ((await bucket.head(PAUSE_KEY)) !== null) {
    console.log(JSON.stringify({ msg: "loader_paused" }));
    return { ...run, status: "paused" };
  }

  const totals: Totals = { loadedFiles: 0, loadedRows: 0, failed: false, unreachable: false };
  const claimed = new Set<string>();
  const batchesLeft = () => run.batchIds.length < limits.maxBatchesPerRun;

  // Unfinished batches first, in key order. They count toward the batch limit.
  const manifests = await listKeys(bucket, BATCHES_PREFIX, limits.maxBatchesPerRun);
  for (const { key } of manifests.keys) {
    if (totals.unreachable) break;
    const object = await bucket.get(key);
    if (object === null) continue;
    let manifest: BatchManifest;
    try {
      manifest = manifestSchema.parse(JSON.parse(await object.text()));
    } catch {
      continue;
    }
    for (const file of manifest.files) claimed.add(file);
    // A file the manifest names that is gone was deleted by the run that crashed after its insert.
    const sources = (await readFiles(bucket, manifest.files)).filter((s) => s !== null);
    await processBatch(env, manifest, sources, false, limits, run, totals);
  }

  // New files, oldest first. The files of an open manifest are left to it.
  if (!totals.unreachable && !manifests.truncated && batchesLeft()) {
    const listed = await listKeys(bucket, PENDING_PREFIX, limits.maxFilesPerRun + claimed.size);
    const keys = listed.keys
      .map((entry) => entry.key)
      .filter((key) => !claimed.has(key))
      .slice(0, limits.maxFilesPerRun);

    let current: Source[] = [];
    let currentRows = 0;
    const flush = async () => {
      const batch = current;
      current = [];
      currentRows = 0;
      const files = batch.map((source) => source.key);
      const manifest: BatchManifest = {
        batch_id: await batchId(files),
        files,
        attempt: 1,
        created_at: now,
      };
      await processBatch(env, manifest, batch, true, limits, run, totals);
    };
    const stopped = () => totals.unreachable || !batchesLeft();

    scan: for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
      const chunk = await readFiles(bucket, keys.slice(i, i + READ_CONCURRENCY));
      for (const source of chunk) {
        if (source === null) continue;
        const rowCount = linesIn(source.text).length;
        // A file over the row cap forms a batch of its own.
        if (current.length > 0 && currentRows + rowCount > limits.maxRowsPerBatch) {
          await flush();
          if (stopped()) break scan;
        }
        current.push(source);
        currentRows += rowCount;
      }
    }
    if (current.length > 0 && !stopped()) await flush();
  }

  if (totals.loadedFiles > 0) {
    await bucket.put(
      LAST_LOAD_KEY,
      JSON.stringify({ at: now, files: totals.loadedFiles, rows: totals.loadedRows }),
    );
  }

  run.status = totals.unreachable ? "d1_unreachable" : totals.failed ? "batch_failed" : "done";
  console.log(
    JSON.stringify({
      msg: "loader_run",
      status: run.status,
      batches: run.batchIds.length,
      files: run.files,
      rows: run.rows,
      duplicates: run.duplicates,
      invalid: run.invalid,
      rejected: run.rejected,
    }),
  );
  return run;
}
