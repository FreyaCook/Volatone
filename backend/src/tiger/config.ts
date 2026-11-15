import pg from "pg";

/** TIGER=on|off. Unset: on only if TIGER_DATABASE_URL is set. "on" without a URL stays off. */
export function tigerEnabled(env: NodeJS.ProcessEnv): boolean {
  const url = env.TIGER_DATABASE_URL?.trim();
  const sw = env.TIGER?.trim().toLowerCase();
  if (sw === "off") return false;
  return !!url;
}

/** Small pool, short timeouts. TLS comes from the URL (sslmode=require). The URL is never logged. */
export function createPool(url: string, onError: (e: unknown) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 4000,
    statement_timeout: 5000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", onError); // an idle client dying must not crash the server
  return pool;
}
