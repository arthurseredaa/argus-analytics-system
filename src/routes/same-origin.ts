// Route: the same-origin check for the two browser POST endpoints.
// Serves R-26: a page on another site must not reach /api/events or /api/complete, because the
// identity middleware would answer it with a new uid cookie and replace the visitor's own.
// Runs before identity(), so a refused request gets no cookie.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.ts";

export function sameOrigin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // Browsers send Sec-Fetch-Site; older ones send only Origin. Scripts such as curl send neither.
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const crossSite =
      site !== undefined
        ? site !== "same-origin" && site !== "none"
        : origin !== undefined && origin !== new URL(c.req.url).origin;
    if (crossSite) return c.json({ error: "cross_site" }, 403);
    await next();
  };
}
