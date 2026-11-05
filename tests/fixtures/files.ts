// Fixture: reads of the events bucket and a bucket that refuses, for the R2 file tests.
// Serves NFR-4, NFR-5, R-16; the layout is in src/events/files.ts.
import { env } from "cloudflare:test";

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
