import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSinkArgs, sinkWranglerArgs } from "../../scripts/lib/sink.ts";
import { eventsBucketName, readWranglerConfig } from "../../scripts/lib/wrangler-config.ts";
import { PAUSE_KEY } from "../../src/events/files.ts";

describe("pnpm sink", () => {
  it("NFR-4 pnpm sink outage on puts the pause key", () => {
    expect(parseSinkArgs(["outage", "on"])).toEqual({ action: "on", target: "local" });
    expect(parseSinkArgs(["outage", "on", "--remote"])).toEqual({
      action: "on",
      target: "remote",
    });
    expect(parseSinkArgs(["outage", "on", "--local"])).toEqual({ action: "on", target: "local" });
    expect(sinkWranglerArgs("on", "remote", "funnels-events")).toEqual([
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      "funnels-events/control/loader-paused",
      "--remote",
      "--pipe",
    ]);
  });

  it("NFR-4 pnpm sink outage off deletes the pause key", () => {
    expect(parseSinkArgs(["outage", "off"])).toEqual({ action: "off", target: "local" });
    expect(sinkWranglerArgs("off", "local", "funnels-events")).toEqual([
      "exec",
      "wrangler",
      "r2",
      "object",
      "delete",
      "funnels-events/control/loader-paused",
      "--local",
    ]);
  });

  it("NFR-4 pnpm sink rejects anything else", () => {
    const bad = [
      [],
      ["outage"],
      ["outage", "maybe"],
      ["pause", "on"],
      ["outage", "on", "--prod"],
      ["outage", "on", "--local", "--remote"],
    ];
    for (const argv of bad) expect(parseSinkArgs(argv)).toBeNull();
  });

  it("NFR-4 pnpm sink pauses the bucket the Worker binds", () => {
    const config = readWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
    const bucket = eventsBucketName(config);
    expect(bucket).toBe("funnels-events");
    const key = sinkWranglerArgs("on", "local", bucket)[5]!;
    expect(key.endsWith(PAUSE_KEY)).toBe(true);
    expect(key).toBe(`${bucket}/${PAUSE_KEY}`);
  });
});
