// Worker secrets, declared by hand because `wrangler types` only sees them when a local
// .dev.vars exists (not in CI). Serves DEMO-8, P-5, PB-3.
declare namespace Cloudflare {
  interface Env {
    MASTER_KEY: string;
    EMAIL_HASH_KEY: string;
  }
}
