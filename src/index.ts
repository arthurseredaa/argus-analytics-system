// The one Worker: HTTP, queue and cron entry points all live here.
// The folders under src/ are its modules, not separate deployables.
import { createApp } from "./app.ts";
import { prelanderFlows } from "./domain/prelanders.ts";
import { consumeEvents } from "./events/consumer.ts";

export const app = createApp(prelanderFlows);

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    await consumeEvents(batch, env.EVENTS);
  },

  async scheduled(controller) {
    console.log(JSON.stringify({ msg: "scheduled", cron: controller.cron }));
  },
} satisfies ExportedHandler<Env>;
