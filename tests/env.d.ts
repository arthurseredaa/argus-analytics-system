// Test-only bindings, injected by vitest.config.ts. They are not part of the Worker's Env.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_FACTS_MIGRATIONS: D1Migration[];
      TEST_EVENTS_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
