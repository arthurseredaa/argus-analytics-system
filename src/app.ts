// The Hono app: healthz, the identity middleware and the routes.
// Implements ADR 0002 (identity before every page and API route); serves ID-2, R-12, DLV-1.
import { Hono } from "hono";
import type { Flow } from "./domain/flow.ts";
import { completeRoute } from "./routes/complete.ts";
import { identity } from "./routes/identity.ts";
import { prelanderRoute } from "./routes/prelander.ts";
import { testRoute } from "./routes/test.ts";

export type AppEnv = {
  Bindings: Env;
  Variables: { userId: string; returning: boolean };
};

export function createApp(flows: ReadonlyMap<string, Flow>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/healthz", (c) => c.json({ sha: c.env.GIT_SHA }));

  app.use("/p/*", identity());
  app.use("/api/*", identity());
  app.use("/__test/*", identity());

  app.route("/api", completeRoute(flows));
  app.route("/p", prelanderRoute(flows));
  app.route("/__test", testRoute());

  // Names the error class only: a message can carry request data such as an email.
  app.onError((err, c) => {
    console.log(JSON.stringify({ msg: "unhandled", name: err.name }));
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
