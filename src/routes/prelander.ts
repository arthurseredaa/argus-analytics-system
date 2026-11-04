// Route: GET /p/:prelander, the server-rendered quiz page with entry selection.
// Implements ADR 0002 and ADR 0004 (entry moment); serves ID-1, ID-2, QZ-1, QZ-2, QZ-5, QZ-7, OFF-8, OFF-10.
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { readFacts } from "../db/facts.ts";
import type { Flow } from "../domain/flow.ts";
import { select } from "../domain/select.ts";
import { renderQuizPage } from "../pages/quiz.ts";

export function prelanderRoute(flows: ReadonlyMap<string, Flow>): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/:prelander", async (c) => {
    const id = c.req.param("prelander");
    const flow = flows.get(id);
    if (flow === undefined) return c.text("Not found", 404);

    // A request without a valid cookie is a new user: no D1 table is touched.
    if (c.get("returning")) {
      const read = await readFacts(c.env.FACTS, c.get("userId"));
      const selection = select(read.facts, read.catalog, "entry");
      // Stage 3 writes the click here and answers 302; until then the quiz is shown.
      if (selection.action === "redirect")
        console.log(JSON.stringify({ msg: "entry_redirect_deferred", reason: selection.reason }));
    }

    return c.body(renderQuizPage(flow, id), 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
  });

  return route;
}
