// Route: GET /p/:prelander, the server-rendered quiz page with entry selection.
// Implements ADR 0002 and ADR 0004 (entry moment); serves ID-1, ID-2, ID-4, NFR-4, QZ-1, QZ-4, QZ-2, QZ-5, QZ-7, OFF-3, OFF-4, OFF-8, OFF-9, OFF-10.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { readFacts } from "../db/facts.ts";
import type { Flow } from "../domain/flow.ts";
import { select } from "../domain/select.ts";
import { makeServerEvent } from "../events/envelope.ts";
import { emitInBackground } from "../events/producer.ts";
import { renderNoOfferPage } from "../pages/no-offer.ts";
import { renderQuizPage } from "../pages/quiz.ts";
import { redirectTarget, startTransition } from "./transition.ts";

const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

export function prelanderRoute(flows: ReadonlyMap<string, Flow>): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/:prelander", async (c) => {
    const id = c.req.param("prelander");
    const flow = flows.get(id);
    if (flow === undefined) return c.text("Not found", 404);

    const visitId = crypto.randomUUID();
    // Hono runs this handler for HEAD too; an uptime checker is not a funnel start and makes no click.
    if (c.req.method === "HEAD") return c.body(renderQuizPage(flow, id, visitId), 200, HTML);

    const base = { userId: c.get("userId"), visitId, prelanderId: id, now: Date.now() };
    const viewed = (reason: string) =>
      makeServerEvent({ ...base, type: "prelander_viewed", payload: { reason } });

    // A request without a valid cookie is a new user: no D1 table is touched.
    if (c.get("returning")) {
      const read = await readFacts(c.env.FACTS, c.get("userId"));
      const selection = select(read.facts, read.catalog, "entry");
      if (selection.action !== "quiz") {
        // Rule 1 sends a Lead back to its offer; rule 3 skips the quiz with sufficient answers.
        const selected = makeServerEvent({
          ...base,
          type: "offer_selected",
          payload: {
            offer_id: selection.offerId,
            reason: selection.reason,
            moment: "entry",
            catalog_version: selection.catalogVersion,
          },
        });
        const shown = viewed(selection.reason === "lead_return" ? "lead_return" : "skip");
        const target = redirectTarget(selection, read.catalog);
        if (target !== null)
          return startTransition(c, {
            ...target,
            prelanderId: id,
            visitId,
            extraEvents: [shown, selected],
          });
        emitInBackground(c.executionCtx, c.env, [shown, selected]);
        return c.body(renderNoOfferPage(), 200, HTML);
      }
    }

    emitInBackground(c.executionCtx, c.env, [viewed("quiz")]);
    return c.body(renderQuizPage(flow, id, visitId), 200, HTML);
  });

  return route;
}
