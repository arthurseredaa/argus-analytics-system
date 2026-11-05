// Events: removes personal-data keys from an event payload before it is queued.
// Implements ADR 0005 and "Personal data" of data-model.md; serves R-23, R-12.
// Only keys are checked: a string value is never read or changed, so an email inside one is the accepted risk R-23.
const EMAIL_KEY = /email/i;

export function sanitizePayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  removed: number;
} {
  let removed = 0;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const kept: [string, unknown][] = [];
    for (const [key, inner] of Object.entries(value)) {
      if (EMAIL_KEY.test(key)) removed += 1;
      else kept.push([key, walk(inner)]);
    }
    return Object.fromEntries(kept);
  };

  return { payload: walk(payload) as Record<string, unknown>, removed };
}
