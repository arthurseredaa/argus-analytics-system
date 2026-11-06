// Worker secrets, declared by hand because `wrangler types` only sees them when a local
// .dev.vars exists (not in CI). Serves DEMO-8, P-5, PB-3. Both declarations are needed:
// wrangler 4.157 generates the global `Env` without extending `Cloudflare.Env`.
declare namespace Cloudflare {
  interface Env {
    MASTER_KEY: string;
    EMAIL_HASH_KEY: string;
    // The Analytics Engine SQL alerts; without them the alert run logs alert_source_unavailable.
    AE_SQL_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
  }
}

interface Env {
  MASTER_KEY: string;
  EMAIL_HASH_KEY: string;
  AE_SQL_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}
