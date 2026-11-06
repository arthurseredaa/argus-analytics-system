// Scripts: argument parsing and the wrangler command lines for `pnpm sink outage on|off`.
// Implements ADR 0005 and ADR 0006 (the pause flag); serves NFR-4, NFR-5, R-16.

// The scripts project has no Workers types, so it cannot import src/events/files.ts; a test pins this to PAUSE_KEY.
export const PAUSE_KEY = "control/loader-paused";

export type SinkAction = "on" | "off";
export type SinkTarget = "local" | "remote";

// `outage on|off` with an optional `--local` or `--remote`; anything else is null.
export function parseSinkArgs(
  argv: readonly string[],
): { action: SinkAction; target: SinkTarget } | null {
  const [command, action, ...flags] = argv;
  if (command !== "outage" || (action !== "on" && action !== "off")) return null;
  if (flags.length > 1) return null;
  const flag = flags[0];
  if (flag === undefined || flag === "--local") return { action, target: "local" };
  if (flag === "--remote") return { action, target: "remote" };
  return null;
}

// Arguments for `pnpm`: `on` puts an empty flag object (the body comes from stdin), `off` deletes it.
export function sinkWranglerArgs(action: SinkAction, target: SinkTarget, bucket: string): string[] {
  const path = `${bucket}/${PAUSE_KEY}`;
  return action === "on"
    ? ["exec", "wrangler", "r2", "object", "put", path, `--${target}`, "--pipe"]
    : ["exec", "wrangler", "r2", "object", "delete", path, `--${target}`];
}
