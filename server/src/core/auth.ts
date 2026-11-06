import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { getSetting, setSetting, sql } from "../db.js";
import { CrmError, type Actor, type Scope } from "./types.js";

const SESSION_DAYS = 30;
let sessionSecret = "";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function hashPassword(pw: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const a = scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Set up the admin password and the session secret on boot. */
export async function initAuth() {
  sessionSecret = config.sessionSecret ?? (await getSetting<string>("session_secret")) ?? "";
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("hex");
    await setSetting("session_secret", sessionSecret);
  }
  if (config.adminPassword && /^(change-?me|password|admin)$/i.test(config.adminPassword)) {
    const msg = `[auth] ADMIN_PASSWORD is still the placeholder "${config.adminPassword}". Set a real password.`;
    if (config.isProd) throw new Error(msg);
    console.warn(msg);
  }
  if (config.adminPassword) {
    // env var always wins, so rotating it in Railway just works
    await setSetting("admin_password", hashPassword(config.adminPassword));
  } else if (!(await getSetting("admin_password"))) {
    const pw = randomBytes(9).toString("base64url");
    await setSetting("admin_password", hashPassword(pw));
    console.log(`\n[auth] No ADMIN_PASSWORD set. Generated one-time admin password: ${pw}\n`);
  }
}

export async function login(password: string) {
  const stored = await getSetting<string>("admin_password");
  if (!stored || !checkPassword(password, stored)) throw new CrmError("Wrong password", 401);
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return { token: `${exp}.${sign(String(exp))}`, maxAge: SESSION_DAYS * 86400 };
}

const sign = (s: string) => createHmac("sha256", sessionSecret).update(s).digest("base64url");

export function verifySession(token?: string) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/* --------------------------------- API keys --------------------------------- */

const VALID_SCOPES: Scope[] = ["read", "write", "schema"];

export async function createApiKey(name: string, scopes: Scope[]) {
  if (!name.trim()) throw new CrmError("Key needs a name");
  const s = scopes.filter((x) => VALID_SCOPES.includes(x));
  if (!s.length) throw new CrmError("Pick at least one scope");
  const key = `ocrm_${randomBytes(24).toString("base64url")}`;
  const [row] = await sql`insert into api_keys (name, prefix, key_hash, scopes)
    values (${name.trim()}, ${key.slice(0, 10)}, ${sha256(key)}, ${s}::text[])
    returning id, name, prefix, scopes, created_at`;
  return { ...row, key };
}

export const listApiKeys = () =>
  sql`select id, name, prefix, scopes, last_used_at, created_at from api_keys where revoked_at is null order by created_at desc`;

export async function revokeApiKey(id: string) {
  await sql`update api_keys set revoked_at = now() where id = ${id}`;
  return { revoked: true };
}

export async function actorFromApiKey(key?: string): Promise<Actor | null> {
  if (!key?.startsWith("ocrm_")) return null;
  const [row] = await sql<{ id: string; name: string; scopes: Scope[] }[]>`
    update api_keys set last_used_at = now() where key_hash = ${sha256(key)} and revoked_at is null
    returning id, name, scopes`;
  return row ? { type: "agent", name: row.name, scopes: row.scopes } : null;
}
