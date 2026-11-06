// Fixture: alert log lines, queue metrics stand-ins, the alert state object and the decision 8 thresholds.
// Serves NFR-3, NFR-5, NFR-6; the evaluator is src/ops/alerts.ts.
import { env } from "cloudflare:test";
import { ALERT_STATE_KEY } from "../../src/events/files.ts";
import type { AlertState, AlertThresholds } from "../../src/ops/alerts.ts";

type LogSpy = { mock: { calls: unknown[][] } };

// Every `console.log` line that parses as a JSON object with this `msg`.
export function logLines(spy: LogSpy, msg: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const args of spy.mock.calls) {
    try {
      const parsed: unknown = JSON.parse(String(args[0]));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { msg?: unknown }).msg === msg
      )
        lines.push(parsed as Record<string, unknown>);
    } catch {
      // Not a JSON line.
    }
  }
  return lines;
}

export const alertLines = (spy: LogSpy): Record<string, unknown>[] => logLines(spy, "alert");

// A Queue binding whose backlog is `count` messages.
export function queueWithBacklog(count: number): Queue {
  return {
    metrics: async () => ({ backlogCount: count, backlogBytes: count * 100 }),
  } as unknown as Queue;
}

// A Queue binding whose metrics call fails.
export function queueWithoutMetrics(): Queue {
  return {
    metrics: async () => {
      throw new Error("queue metrics down");
    },
  } as unknown as Queue;
}

// `{ checked_at, sizes_checked_at }` is the state an older run wrote.
export async function putAlertState(
  state: AlertState | { checked_at: number; sizes_checked_at: number },
): Promise<void> {
  await env.EVENTS_BUCKET.put(ALERT_STATE_KEY, JSON.stringify(state));
}

// The values of ALERT_THRESHOLDS in wrangler.jsonc.
export function testThresholds(overrides: Partial<AlertThresholds> = {}): AlertThresholds {
  return {
    freshness_lag_ms: 900_000,
    pending_oldest_file_ms: 3_600_000,
    postbacks_min_requests: 5,
    postbacks_window_ms: 900_000,
    d1_facts_size_bytes: 7_000_000_000,
    d1_events_size_bytes: 7_000_000_000,
    selection_p95_ms: 300,
    worker_5xx_rate: 0.01,
    d1_overload_errors_per_hour: 10,
    ...overrides,
  };
}
