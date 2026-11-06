// The one Worker: HTTP, queue and cron entry points all live here.
// The folders under src/ are its modules, not separate deployables.
import { createApp } from "./app.ts";
import { prelanderFlows } from "./domain/prelanders.ts";
import { consumeEvents } from "./events/consumer.ts";
import { LOADER_CRON, runLoader } from "./events/loader.ts";

export const app = createApp(prelanderFlows);

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    await consumeEvents(batch, env.EVENTS_BUCKET, Date.now());
  },

  async scheduled(controller, env) {
    // The alert cron of stage 6 adds a branch here, not a Worker.
    if (controller.cron === LOADER_CRON) {
      try {
        await runLoader(env, Date.now());
      } catch (err) {
        // The class name only: an error message can quote what it failed on.
        const name = err instanceof Error ? err.name : "unknown";
        console.log(JSON.stringify({ msg: "loader_run", status: "error", name }));
        throw err;
      }
      return;
    }
    console.log(JSON.stringify({ msg: "scheduled_unknown_cron", cron: controller.cron }));
  },
} satisfies ExportedHandler<Env>;
