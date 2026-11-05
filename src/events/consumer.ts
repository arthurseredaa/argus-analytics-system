// Events: the Queue consumer that writes event batches to the events database.
// Implements ADR 0005; serves ID-1, ID-4, NFR-5, NFR-8, R-3. Stage 5 replaces its D1 write with R2 files.
// Log lines name counts and message ids, never a message body.
import { insertEvents } from "../db/events.ts";
import { storedEventSchema } from "./envelope.ts";
import type { StoredEvent } from "./envelope.ts";

export async function consumeEvents(batch: MessageBatch<unknown>, db: D1Database): Promise<void> {
  const valid: { message: Message<unknown>; event: StoredEvent }[] = [];
  let invalid = 0;

  for (const message of batch.messages) {
    const parsed = storedEventSchema.safeParse(message.body);
    if (parsed.success) {
      valid.push({ message, event: parsed.data });
    } else {
      // Retried alone: after max_retries it lands in the dead letter queue, the rest is not held back.
      invalid += 1;
      console.log(JSON.stringify({ msg: "consumer_invalid_message", id: message.id }));
      message.retry();
    }
  }

  try {
    await insertEvents(
      db,
      valid.map((v) => v.event),
    );
  } catch {
    console.log(JSON.stringify({ msg: "consumer_write_failed", count: valid.length }));
    batch.retryAll();
    return;
  }

  for (const { message } of valid) message.ack();
  console.log(JSON.stringify({ msg: "consumer_batch", stored: valid.length, invalid }));
}
