// The Hono app: healthz, the identity middleware and the routes.
// Implements ADR 0002 (identity before the pages, `/go` and the two browser APIs; the report and
// postbacks have none); serves ID-2, R-12, R-26, DLV-1.
import { Hono } from "hono";
import type { Flow } from "./domain/flow.ts";
import { completeRoute } from "./routes/complete.ts";
import { eventsRoute } from "./routes/events.ts";
import { goRoute } from "./routes/go.ts";
import { isD1Overload, requestMetrics } from "./ops/metrics.ts";
import { identity } from "./routes/identity.ts";
import { postbackRoute } from "./routes/postback.ts";
import { prelanderRoute } from "./routes/prelander.ts";
import { probeRoute } from "./routes/probe.ts";
import { reportRoute } from "./routes/report.ts";
import { sameOrigin } from "./routes/same-origin.ts";
import { testRoute } from "./routes/test.ts";

export type AppEnv = {
  Bindings: Env;
  Variables: { userId: string; returning: boolean; errorTag?: "d1_overload" };
};

export function createApp(flows: ReadonlyMap<string, Flow>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // First, so the point sees every response, including the one the error handler builds.
  app.use("*", requestMetrics());

  app.get("/healthz", (c) => c.json({ sha: c.env.GIT_SHA }));

  // Before identity, so a cross-site POST is refused before it gets a new cookie (R-26).
  app.use("/api/events", sameOrigin());
  app.use("/api/complete", sameOrigin());

  app.use("/p/*", identity());
  // Only the two browser endpoints get a user id; the report is open and sets no cookie.
  app.use("/api/events", identity());
  app.use("/api/complete", identity());
  app.use("/go/*", identity());
  app.use("/__test/*", identity());

  app.route("/api", completeRoute(flows));
  app.route("/api", eventsRoute(flows));
  app.route("/", reportRoute());
  app.route("/p", prelanderRoute(flows));
  app.route("/go", goRoute(flows));
  app.route("/__test", testRoute());
  // No identity middleware: a partner server is not a user and gets no cookie (ADR 0007).
  app.route("/postback", postbackRoute());
  // No identity middleware: the probe is not a user and writes nothing.
  app.route("/__probe", probeRoute());

  // Names the error class only: a message can carry request data such as an email.
  app.onError((err, c) => {
    if (isD1Overload(err)) c.set("errorTag", "d1_overload");
    console.log(JSON.stringify({ msg: "unhandled", name: err.name }));
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
