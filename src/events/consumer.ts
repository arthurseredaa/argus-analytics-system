// Events: the Queue consumer that writes each event batch as one NDJSON file to R2 pending/.
// Implements ADR 0005 and ADR 0006; serves NFR-5, NFR-8, R-3. The D1 write moved to the loader (src/events/loader.ts).
// Log lines name counts and error classes, never a message body.
import { NDJSON_PUT, pendingKey, toNdjson } from "./files.ts";

// Seconds before the next delivery of a message that failed `attempts` times (1 on the first
// delivery): 60, 120, 240, 480, 960, 1920, then 3600. Ten retries add up to 18,180 seconds.
export function retryDelaySeconds(attempts: number): number {
  return Math.min(60 * 2 ** (attempts - 1), 3600);
}

// Every body is written as it came: the loader validates, so one bad row never costs the batch
// ten retries and a dead letter slot.
export async function consumeEvents(
  batch: MessageBatch<unknown>,
  bucket: R2Bucket,
  now: number,
): Promise<void> {
  const count = batch.messages.length;
  try {
    await bucket.put(
      pendingKey("batch", now, crypto.randomUUID()),
      toNdjson(batch.messages.map((message) => message.body)),
      NDJSON_PUT,
    );
  } catch (err) {
    // The class name only: an error message can quote the rows it failed on.
    const name = err instanceof Error ? err.name : "unknown";
    console.log(JSON.stringify({ msg: "consumer_write_failed", count, name }));
    // Per message, not retryAll: a batch can mix fresh messages with retried ones.
    for (const message of batch.messages) {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
    return;
  }

  for (const message of batch.messages) message.ack();
  console.log(JSON.stringify({ msg: "consumer_batch", written: count }));
}
