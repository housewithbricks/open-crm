import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";
import { getSetting, json, setSetting, sql } from "../db.js";
import { CrmError, setSourceKey, type Actor, type Scope } from "./types.js";

const SESSION_DAYS = 30;
let sessionSecret = "";
const scryptAsync = promisify(scrypt) as (pw: string, salt: string, len: number) => Promise<Buffer>;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function hashPassword(pw: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await scryptAsync(pw, salt, 64)).toString("hex")}`;
}

async function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const a = await scryptAsync(pw, salt, 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 64+ hex characters, or base64 of at least 32 bytes. */
const looksRandom = (k: string) => /^[0-9a-f]{64,}$/i.test(k) || (/^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(k) && Buffer.from(k, "base64").length >= 32);

/** Set up the admin password and the session secret on boot. */
export async function initAuth() {
  sessionSecret = config.sessionSecret ?? (await getSetting<string>("session_secret")) ?? "";
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("hex");
    await setSetting("session_secret", sessionSecret);
  }
  // Key for source fingerprints. Separate from the session secret, so rotating SESSION_SECRET
  // doesn't make every stored fingerprint uncheckable. SOURCE_DIGEST_KEY keeps it out of the
  // database (and its backups); with a different key, existing fingerprints can't be checked (409).
  // It must be random: its kid is public, so a passphrase could be guessed offline.
  if (config.sourceDigestKey && !looksRandom(config.sourceDigestKey)) {
    const msg = "[auth] SOURCE_DIGEST_KEY must be random: 64+ hex characters or base64 of 32+ bytes (e.g. openssl rand -hex 32).";
    if (config.isProd) throw new Error(msg);
    console.warn(msg);
  }
  const storedSourceKey = await getSetting<string>("source_digest_key");
  if (config.sourceDigestKey && storedSourceKey) {
    if (storedSourceKey === config.sourceDigestKey) {
      // Not deleted here: another instance (rolling deploy, job container) may still start
      // without the env var, and would then make a second key.
      console.log("[auth] SOURCE_DIGEST_KEY matches the key stored in the database. Once every instance has it, remove the database copy: delete from settings where key = 'source_digest_key';");
    } else {
      console.warn("[auth] SOURCE_DIGEST_KEY differs from the key in the database: fingerprints made with the stored key can't be checked. Set it to the stored value to keep them.");
    }
  }
  let sourceKey = config.sourceDigestKey ?? storedSourceKey;
  if (!sourceKey) {
    const [old] = await sql`select 1 from audit_log where source->'digest'->>'by' = 'crm' limit 1`;
    if (old) {
      console.warn("[auth] No source digest key (SOURCE_DIGEST_KEY unset and none in the database), but fingerprints exist: making a new key. Fingerprints made with the old key can't be checked until SOURCE_DIGEST_KEY is set back to it.");
    }
    sourceKey = randomBytes(32).toString("hex");
    await sql`insert into settings (key, value) values ('source_digest_key', ${json(sourceKey)}::jsonb) on conflict (key) do nothing`;
    sourceKey = (await getSetting<string>("source_digest_key"))!;
  }
  setSourceKey(sourceKey);
  if (config.adminPassword && /^(change-?me|password|admin)$/i.test(config.adminPassword)) {
    const msg = `[auth] ADMIN_PASSWORD is still the placeholder "${config.adminPassword}". Set a real password.`;
    if (config.isProd) throw new Error(msg);
    console.warn(msg);
  }
  const stored = await getSetting<string>("admin_password");
  if (config.adminPassword) {
    // The env var always wins, so rotating it in Railway just works. Only rehash when it changed:
    // a new hash signs everyone out (sessions are bound to it), which is what a rotation should do.
    if (!stored || !(await checkPassword(config.adminPassword, stored))) {
      await setSetting("admin_password", await hashPassword(config.adminPassword));
    }
  } else if (!stored) {
    const pw = randomBytes(9).toString("base64url");
    await setSetting("admin_password", await hashPassword(pw));
    console.log(`\n[auth] No ADMIN_PASSWORD set. Generated one-time admin password: ${pw}\n`);
  }
}

/* --------------------------------- sessions --------------------------------- */

/**
 * A session cookie is "<expiry>.<signature>". The signature covers the expiry, the session epoch
 * and a fingerprint of the stored password hash, so a session dies when the password changes or
 * when the user signs out everywhere (which bumps the epoch). Both are read per request, so this
 * also holds across several app instances.
 */
async function sessionKey() {
  const rows = await sql<{ key: string; value: unknown }[]>`select key, value from settings where key in ('admin_password', 'session_epoch')`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return `${sessionSecret}:${Number(get("session_epoch") ?? 0)}:${sha256(String(get("admin_password") ?? ""))}`;
}

const sign = (key: string, s: string) => createHmac("sha256", key).update(s).digest("base64url");

export async function login(password: string) {
  const stored = await getSetting<string>("admin_password");
  if (!stored || !(await checkPassword(password, stored))) throw new CrmError("Wrong password", 401);
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return { token: `${exp}.${sign(await sessionKey(), String(exp))}`, maxAge: SESSION_DAYS * 86400 };
}

export async function verifySession(token?: string) {
  if (!token) return false;
  const [exp, sig, extra] = token.split(".");
  if (!exp || !sig || extra !== undefined || Number(exp) < Date.now()) return false;
  const expected = sign(await sessionKey(), exp);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/** Invalidate every session cookie issued so far, on every device. */
export async function signOutEverywhere() {
  await sql`insert into settings (key, value) values ('session_epoch', '1'::jsonb)
            on conflict (key) do update set value = to_jsonb(coalesce((settings.value #>> '{}')::int, 0) + 1)`;
  return { ok: true };
}

/* --------------------------------- API keys --------------------------------- */

const VALID_SCOPES: Scope[] = ["read", "write", "schema"];

export async function createApiKey(name: string, scopes: Scope[], requireSource = false) {
  if (typeof name !== "string" || !name.trim()) throw new CrmError("Key needs a name");
  if (!Array.isArray(scopes)) throw new CrmError("scopes must be a list");
  const s = scopes.filter((x) => VALID_SCOPES.includes(x));
  if (!s.length) throw new CrmError("Pick at least one scope");
  const key = `ocrm_${randomBytes(24).toString("base64url")}`;
  if (typeof requireSource !== "boolean") throw new CrmError("require_source must be true or false");
  const [row] = await sql`insert into api_keys (name, prefix, key_hash, scopes, require_source)
    values (${name.trim()}, ${key.slice(0, 10)}, ${sha256(key)}, ${s}::text[], ${requireSource})
    returning id, name, prefix, scopes, require_source, created_at`;
  return { ...row, key };
}

export const listApiKeys = () =>
  sql`select id, name, prefix, scopes, require_source, last_used_at, created_at from api_keys where revoked_at is null order by created_at desc`;

/** Turn "every write needs a source" on or off for a key. Takes effect on its next request. */
export async function updateApiKey(id: string, patch: { require_source?: unknown }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CrmError("API key not found", 404);
  if (typeof patch.require_source !== "boolean") throw new CrmError("require_source must be true or false");
  const [row] = await sql`update api_keys set require_source = ${patch.require_source}
    where id = ${id} and revoked_at is null
    returning id, name, prefix, scopes, require_source, last_used_at, created_at`;
  if (!row) throw new CrmError("API key not found", 404);
  return row;
}

export async function revokeApiKey(id: string) {
  await sql`update api_keys set revoked_at = now() where id = ${id}`;
  return { revoked: true };
}

export async function actorFromApiKey(key?: string): Promise<Actor | null> {
  if (!key?.startsWith("ocrm_")) return null;
  const [row] = await sql<{ id: string; name: string; scopes: Scope[]; require_source: boolean }[]>`
    update api_keys set last_used_at = now() where key_hash = ${sha256(key)} and revoked_at is null
    returning id, name, scopes, require_source`;
  return row ? { type: "agent", name: row.name, scopes: row.scopes, requireSource: row.require_source } : null;
}
