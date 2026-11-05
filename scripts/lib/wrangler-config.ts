// Scripts: reads wrangler.jsonc so a script and the Worker name the same bucket and cron.
// Serves ADR 0005, ADR 0006 and NFR-3, NFR-5. The file has comments and trailing commas, so TypeScript parses it.
import ts from "typescript";

export type WranglerConfig = {
  triggers?: { crons?: string[] };
  queues?: {
    consumers?: { queue: string; max_retries?: number; dead_letter_queue?: string }[];
  };
  r2_buckets?: { binding: string; bucket_name: string }[];
};

export function readWranglerConfig(text: string): WranglerConfig {
  const { config, error } = ts.parseConfigFileTextToJson("wrangler.jsonc", text);
  if (error !== undefined) {
    const reason = ts.flattenDiagnosticMessageText(error.messageText, "\n");
    throw new Error(`wrangler.jsonc does not parse: ${reason}`);
  }
  return config as WranglerConfig;
}

export function eventsBucketName(config: WranglerConfig): string {
  const bucket = config.r2_buckets?.find((b) => b.binding === "EVENTS_BUCKET");
  if (bucket === undefined) throw new Error("wrangler.jsonc has no EVENTS_BUCKET binding");
  return bucket.bucket_name;
}
