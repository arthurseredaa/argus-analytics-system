// Route: GET /go?prelander=&visit=, the press on the offer button.
// Implements ADR 0004 (selection at the redirect moment, decision 1 of the stage 3 plan); serves OFF-8, OFF-9, OFF-11, R-9, Q-30.
// The URL names no offer: selection runs again on the cookie's user, so nothing in the link chooses the offer.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { readFacts } from "../db/facts.ts";
import type { Flow } from "../domain/flow.ts";
import { select } from "../domain/select.ts";
import { isValidVisitId } from "../events/envelope.ts";
import { renderNoOfferPage } from "../pages/no-offer.ts";
import { redirectTarget, startTransition } from "./transition.ts";

export function goRoute(flows: ReadonlyMap<string, Flow>): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/", async (c) => {
    // Hono runs this handler for HEAD too; a link preview must not make a click.
    if (c.req.method === "HEAD") return c.body(null, 405, { allow: "GET" });

    const prelanderId = c.req.query("prelander") ?? "";
    if (!flows.has(prelanderId)) return c.text("Not found", 404);
    const visit = c.req.query("visit");
    // A malformed id would make a poison Queue message, so the Worker makes one instead.
    const visitId = visit !== undefined && isValidVisitId(visit) ? visit : crypto.randomUUID();

    const read = await readFacts(c.env.FACTS, c.get("userId"));
    const selection = select(read.facts, read.catalog, "redirect");

    // A user without answers or Leads, such as a new cookie, has nothing to go to (Q-30).
    if (selection.action === "quiz")
      return c.body(null, 302, {
        location: `/p/${encodeURIComponent(prelanderId)}`,
        "cache-control": "no-store",
      });

    const target = redirectTarget(selection, read.catalog);
    if (target !== null) return startTransition(c, { ...target, prelanderId, visitId });

    console.log(JSON.stringify({ msg: "go_no_offer" }));
    return c.body(renderNoOfferPage(), 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  return route;
}
