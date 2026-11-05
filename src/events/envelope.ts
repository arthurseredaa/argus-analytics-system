// Events: the event envelope, its check at the edge and the shape of a stored event.
// Implements ADR 0005 and "Event envelope" of data-model.md; serves ID-1, ID-2, ID-4, BIZ-2, QZ-1, QZ-4, R-12, R-14.
// The Worker sets user_id and received_at, so a client that sends them is ignored, not rejected.
import { z } from "zod";
import type { Flow } from "../domain/flow.ts";

export const BROWSER_TYPES = ["step_viewed", "step_answered"] as const;
export const SERVER_TYPES = [
  "prelander_viewed",
  "quiz_completed",
  "offer_selected",
  "offer_click",
  "lead",
  "purchase",
] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

// One id pattern for visit ids and prelander ids; the flow loader checks prelander ids against it too.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const idPattern = ID_PATTERN;
// One rule for a visit id: the envelope schema, the consumer and the completion route all use it.
export const isValidVisitId = (value: string): boolean => idPattern.test(value);
const typePattern = /^[a-z][a-z0-9_]{0,63}$/;

// D1 refuses a payload nested about 1000 levels deep (json_valid), which would fail a whole batch,
// so no event type or schema version gets past 32 levels. The payload object itself is level 1.
export const MAX_PAYLOAD_DEPTH = 32;

export function payloadDepth(value: unknown, limit = MAX_PAYLOAD_DEPTH + 1): number {
  if (value === null || typeof value !== "object") return 0;
  if (limit <= 1) return 1;
  let deepest = 0;
  for (const child of Object.values(value))
    deepest = Math.max(deepest, payloadDepth(child, limit - 1));
  return 1 + deepest;
}

const payloadSchema = z
  .record(z.string(), z.unknown())
  .refine((payload) => payloadDepth(payload) <= MAX_PAYLOAD_DEPTH);

const envelopeSchema = z.strictObject({
  event_id: z.uuid(),
  schema_version: z.int().min(1).max(1000),
  type: z.string().regex(typePattern),
  client_time: z.int().min(0),
  visit_id: z.string().regex(idPattern),
  seq: z.int().min(1).max(10_000),
  prelander_id: z.string().regex(idPattern),
  payload: payloadSchema,
});

export type IncomingEvent = z.infer<typeof envelopeSchema>;

export const storedEventSchema = z.strictObject({
  event_id: z.uuid(),
  schema_version: z.int().min(1).max(1000),
  type: z.string().regex(typePattern),
  client_time: z.int().min(0).nullable(),
  received_at: z.int().min(0),
  user_id: z.string().nullable(),
  visit_id: z.string().regex(idPattern),
  seq: z.int().min(1).max(10_000).nullable(),
  prelander_id: z.string().regex(idPattern),
  payload: payloadSchema,
});

export type StoredEvent = z.infer<typeof storedEventSchema>;

export type CheckError = "invalid_body" | "server_only_type" | "unknown_prelander";

type CheckResult =
  | { ok: true; event: IncomingEvent }
  | { ok: false; error: CheckError; fields: string[] };

const bad = (fields: string[]): CheckResult => ({
  ok: false,
  error: "invalid_body",
  fields: [...new Set(fields)],
});

// A client-chosen key name never goes into the result, so unknown keys all become "<unknown>".
function fieldNames(error: z.ZodError, prefix: string): string[] {
  return error.issues.map((issue) =>
    issue.code === "unrecognized_keys" ? `${prefix}<unknown>` : `${prefix}${issue.path.join(".")}`,
  );
}

function checkPayloadV1(event: IncomingEvent, flow: Flow): string[] {
  if (event.type === "step_viewed") {
    const parsed = z
      .strictObject({ step: z.int().min(1).max(flow.steps.length), prefilled: z.boolean() })
      .safeParse(event.payload);
    return parsed.success ? [] : fieldNames(parsed.error, "payload.");
  }
  if (event.type === "step_answered") {
    const parsed = z
      .strictObject({ step: z.int().min(1), question_key: z.string(), value: z.string() })
      .safeParse(event.payload);
    if (!parsed.success) return fieldNames(parsed.error, "payload.");
    const { step, question_key, value } = parsed.data;
    const index = flow.steps.findIndex((s) => s.key === question_key && s.kind === "choice");
    const asked = flow.steps[index];
    if (!asked) return ["payload.question_key"];
    const fields: string[] = [];
    if (step !== index + 1) fields.push("payload.step");
    if (!asked.options?.some((o) => o.value === value)) fields.push("payload.value");
    return fields;
  }
  return [];
}

export function checkIncoming(raw: unknown, flows: ReadonlyMap<string, Flow>): CheckResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad([]);

  const { user_id: _userId, received_at: _receivedAt, ...body } = raw as Record<string, unknown>;
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return bad(fieldNames(parsed.error, ""));
  const event = parsed.data;

  if ((SERVER_TYPES as readonly string[]).includes(event.type)) {
    return { ok: false, error: "server_only_type", fields: [] };
  }
  const flow = flows.get(event.prelander_id);
  if (!flow) return { ok: false, error: "unknown_prelander", fields: [] };

  if (event.schema_version === 1) {
    const fields = checkPayloadV1(event, flow);
    if (fields.length > 0) return bad(fields);
  }
  return { ok: true, event };
}

export function makeServerEvent(input: {
  type: ServerType;
  userId: string | null;
  visitId: string;
  prelanderId: string;
  payload: Record<string, unknown>;
  now: number;
}): StoredEvent {
  return {
    event_id: crypto.randomUUID(),
    schema_version: 1,
    type: input.type,
    client_time: null,
    received_at: input.now,
    user_id: input.userId,
    visit_id: input.visitId,
    seq: null,
    prelander_id: input.prelanderId,
    payload: input.payload,
  };
}
