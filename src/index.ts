// The one Worker: HTTP, queue and cron entry points all live here.
// The folders under src/ are its modules, not separate deployables.
import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ sha: c.env.GIT_SHA }));

export default {
  fetch: app.fetch,

  // Placeholder until stage 2. Retrying keeps any stray message instead of acking it.
  async queue(batch) {
    console.log(JSON.stringify({ msg: "queue batch", size: batch.messages.length }));
    batch.retryAll();
  },

  async scheduled(controller) {
    console.log(JSON.stringify({ msg: "scheduled", cron: controller.cron }));
  },
} satisfies ExportedHandler<Env>;
