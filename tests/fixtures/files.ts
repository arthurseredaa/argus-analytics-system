// Fixture: reads of the events bucket, a bucket that refuses, and the loader's inputs, for the R2 file tests.
// Serves NFR-4, NFR-5, R-16; the layout is in src/events/files.ts, the loader in src/events/loader.ts.
import { env } from "cloudflare:test";
import { PAUSE_KEY, pendingKey, toNdjson } from "../../src/events/files.ts";
import {
  LOADER_LIMITS,
  runLoader,
  type LoaderLimits,
  type LoaderRun,
} from "../../src/events/loader.ts";

const down = async () => {
  throw new Error("r2 down");
};

// Every method rejects, the way an R2 outage looks to the Worker.
export function failingBucket(): R2Bucket {
  return {
    put: down,
    get: down,
    head: down,
    list: down,
    delete: down,
  } as unknown as R2Bucket;
}

export async function keysUnder(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.EVENTS_BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

// R2 storage is shared between the tests of one file and isolated between files, so a file that
// reads or lists the bucket empties it before each test. This removes every key the pipeline owns.
export async function clearBucket(): Promise<void> {
  for (const prefix of ["pending/", "batches/", "loaded/", "rejected/", "control/"]) {
    const keys = await keysUnder(prefix);
    for (let i = 0; i < keys.length; i += 1000)
      await env.EVENTS_BUCKET.delete(keys.slice(i, i + 1000));
  }
}

// The non-empty lines of a file; a missing key gives [].
export async function linesOf(key: string): Promise<string[]> {
  const object = await env.EVENTS_BUCKET.get(key);
  if (object === null) return [];
  return (await object.text()).split("\n").filter((line) => line !== "");
}

// Keys under `prefix` whose text contains `needle`.
export async function filesWith(prefix: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const key of await keysUnder(prefix)) {
    const object = await env.EVENTS_BUCKET.get(key);
    if (object !== null && (await object.text()).includes(needle)) found.push(key);
  }
  return found;
}

// A pending file: rows as NDJSON, or a raw string. A low `at` sorts the file before any other.
export async function putPending(
  content: readonly unknown[] | string,
  at?: number,
): Promise<string> {
  const key = pendingKey("batch", at ?? Date.now(), crypto.randomUUID());
  await env.EVENTS_BUCKET.put(key, typeof content === "string" ? content : toNdjson(content));
  return key;
}

export async function pauseLoader(): Promise<void> {
  await env.EVENTS_BUCKET.put(PAUSE_KEY, "");
}

export async function resumeLoader(): Promise<void> {
  await env.EVENTS_BUCKET.delete(PAUSE_KEY);
}

// One loader run against the test bucket; `events` swaps the database for a failing one.
export function loadNow(limits?: Partial<LoaderLimits>, events?: D1Database): Promise<LoaderRun> {
  return runLoader({ EVENTS_BUCKET: env.EVENTS_BUCKET, EVENTS: events ?? env.EVENTS }, Date.now(), {
    ...LOADER_LIMITS,
    ...limits,
  });
}

// An events database whose inserts fail but which still answers `SELECT 1`.
export function insertFailingEvents(): D1Database {
  return {
    prepare: (sql: string) => env.EVENTS.prepare(sql),
    batch: async () => {
      throw new Error("SQLITE_CONSTRAINT");
    },
  } as unknown as D1Database;
}

const d1Down = async () => {
  throw new Error("d1 down");
};

// An events database that answers nothing, the way an outage looks to the Worker.
export function unreachableEvents(): D1Database {
  const statement = { first: d1Down, run: d1Down, all: d1Down, bind: () => statement };
  return { prepare: () => statement, batch: d1Down } as unknown as D1Database;
}
