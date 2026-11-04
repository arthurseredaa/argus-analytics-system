// Ambient declarations for tests; this file has no import or export, so `declare module`
// with a wildcard works (in a module file it would be an augmentation and fail).

// Test-only bindings, injected by vitest.config.ts. They are not part of the Worker's Env.
declare namespace Cloudflare {
  interface Env {
    TEST_FACTS_MIGRATIONS: D1Migration[];
    TEST_EVENTS_MIGRATIONS: D1Migration[];
    TEST_ROUTES: string;
  }
}

// Vite `?raw` imports: the decision table and select.ts are read as text.
declare module "*.md?raw" {
  const text: string;
  export default text;
}

declare module "*.ts?raw" {
  const text: string;
  export default text;
}
