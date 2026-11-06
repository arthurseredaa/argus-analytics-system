// The one Worker: HTTP, queue and cron entry points all live here.
// The folders under src/ are its modules, not separate deployables.
import { createApp } from "./app.ts";
import { prelanderFlows } from "./domain/prelanders.ts";
import { consumeEvents } from "./events/consumer.ts";
import { LOADER_CRON, runLoader } from "./events/loader.ts";
import { ALERT_CRON, runAlerts } from "./ops/alerts.ts";
import { recordLoaderRun } from "./ops/metrics.ts";

export const app = createApp(prelanderFlows);

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    await consumeEvents(batch, env.EVENTS_BUCKET, Date.now());
  },

  async scheduled(controller, env) {
    // One Worker, one branch per cron: the loader every minute, the alert evaluator every 5 minutes.
    if (controller.cron === ALERT_CRON) {
      try {
        await runAlerts(env, Date.now());
      } catch (err) {
        const name = err instanceof Error ? err.name : "unknown";
        console.log(JSON.stringify({ msg: "alert_run", status: "error", name }));
        throw err;
      }
      return;
    }
    if (controller.cron === LOADER_CRON) {
      const now = Date.now();
      try {
        const run = await runLoader(env, now);
        await recordLoaderRun(env, run, now);
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
