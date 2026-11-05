// Fixture: a valid browser event body for the demo prelander, shared by unit and integration tests.
// Pure on purpose (no cloudflare:test import) so both test pools can load it.
export function browserEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID(),
    schema_version: 1,
    type: "step_answered",
    client_time: 1762300000000,
    visit_id: "v1",
    seq: 2,
    prelander_id: "demo",
    payload: { step: 1, question_key: "gender", value: "women" },
    ...overrides,
  };
}
