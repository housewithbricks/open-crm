export const config = {
  port: Number(process.env.PORT ?? 8080),
  /**
   * DATABASE_URL wins. Without it, the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT variables are used,
   * which keeps passwords with "/", "@" or "%" intact (docker compose sets these). Neither: local dev default.
   */
  databaseUrl: process.env.DATABASE_URL || (process.env.PGHOST ? undefined : "postgres://opencrm:opencrm@localhost:5432/opencrm"),
  /** Optional override for databases whose URL has no sslmode (e.g. Heroku): require | prefer | verify-full | disable */
  databaseSsl: process.env.DATABASE_SSL,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  sourceDigestKey: process.env.SOURCE_DIGEST_KEY || undefined,
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, ""),
  isProd: process.env.NODE_ENV === "production",
  /** Reverse proxies in front of the app that append to X-Forwarded-For (Caddy, Railway, Render…). 0 = none. */
  trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS ?? 1),
  /** Header your platform sets to the real client IP (e.g. fly-client-ip, cf-connecting-ip). Wins over X-Forwarded-For. */
  clientIpHeader: process.env.CLIENT_IP_HEADER?.toLowerCase(),
  /** Failed sign-ins from all addresses together within 15 minutes before sign-in pauses for 5 minutes. */
  loginGlobalMax: Number(process.env.LOGIN_GLOBAL_MAX ?? 100),
};
