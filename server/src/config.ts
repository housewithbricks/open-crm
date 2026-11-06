export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://opencrm:opencrm@localhost:5432/opencrm",
  /** Optional override for databases whose URL has no sslmode (e.g. Heroku): require | prefer | verify-full | disable */
  databaseSsl: process.env.DATABASE_SSL,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, ""),
  isProd: process.env.NODE_ENV === "production",
};
