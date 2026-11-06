import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { deleteActivity, listTasks, logActivity, timeline, updateActivity } from "../core/activities.js";
import { listAudit } from "../core/audit.js";
import { actorFromApiKey, createApiKey, listApiKeys, login, revokeApiKey, signOutEverywhere, verifySession } from "../core/auth.js";
import { decideChange, listChanges, requestOrApply } from "../core/changes.js";
import {
  archiveRecord,
  counts,
  createRecord,
  getRecord,
  groupRecords,
  listRecords,
  restoreRecord,
  searchAll,
  updateRecord,
  writeReply,
  type Filter,
} from "../core/records.js";
import { addField, createObjectType, loadSchema, updateField, updateObjectType } from "../core/schema.js";
import { CrmError, requireScope, userActor, type Actor } from "../core/types.js";
import { config } from "../config.js";
import { getUiSettings, updateUiSettings } from "../core/settings.js";
import { dashboard } from "../core/dashboard.js";
import { exportCsv, importRows } from "../core/importer.js";
import { undoEntry, UNDOABLE } from "../core/undo.js";
import { createView, deleteView, listViews, updateView } from "../core/views.js";
import { createWebhook, deleteWebhook, listWebhooks, testWebhook, updateWebhook, WEBHOOK_EVENTS } from "../core/webhooks.js";

type Env = { Variables: { actor: Actor } };
const COOKIE = "ocrm_session";

export const api = new Hono<Env>();

/* ---------------------------------- auth ----------------------------------- */

/**
 * The client address used for the login limiter. Behind N proxies that append to
 * X-Forwarded-For (TRUSTED_PROXY_HOPS, default 1), the real address is the Nth entry from the
 * right; anything further left was sent by the client and can be forged. A platform header
 * (CLIENT_IP_HEADER) wins when set. With 0 hops there is no address to go on (the app is mounted
 * behind a fetch handler), so all clients share one bucket.
 */
function clientIp(c: { req: { header: (h: string) => string | undefined } }) {
  if (config.clientIpHeader) return c.req.header(config.clientIpHeader)?.trim() || "unknown";
  if (config.trustedProxyHops <= 0) return "direct";
  const xff = (c.req.header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - config.trustedProxyHops] ?? xff[0] ?? "unknown";
}

const PER_IP_MAX = 10;
const LOCK_MS = 5 * 60_000;
const WINDOW_MS = 15 * 60_000;
type Bucket = { n: number; first: number; until: number };
const attempts = new Map<string, Bucket>();
let everyone: Bucket | undefined;

/** A finished lockout, or a window with no recent failures, starts the count over. */
const fresh = (b: Bucket | undefined, now: number): Bucket =>
  !b || (b.until ? b.until <= now : now - b.first > WINDOW_MS) ? { n: 0, first: now, until: 0 } : b;

function fail(b: Bucket, max: number, now: number) {
  b.n++;
  if (b.n >= max) b.until = now + LOCK_MS;
}

/** Keep the map small: drop finished entries, then the oldest if an attacker sprays addresses. */
function prune(now: number) {
  if (attempts.size < 1000) return;
  for (const [ip, b] of attempts) if (fresh(b, now).n === 0) attempts.delete(ip);
  for (const ip of attempts.keys()) {
    if (attempts.size <= 5000) break;
    attempts.delete(ip);
  }
}

api.post("/login", async (c) => {
  const now = Date.now();
  const ip = clientIp(c);
  const mine = fresh(attempts.get(ip), now);
  const all = (everyone = fresh(everyone, now));
  if (mine.until > now) throw new CrmError("Too many attempts, try again in a few minutes", 429);
  // A global cap too, so spreading guesses over many addresses doesn't help.
  if (all.until > now) throw new CrmError("Too many failed sign-ins recently, try again in a few minutes", 429);
  const failed = () => {
    fail(mine, PER_IP_MAX, now);
    fail(all, config.loginGlobalMax, now);
    attempts.delete(ip); // re-insert so the map stays ordered by last failure
    attempts.set(ip, mine);
    prune(now);
  };
  const body = await c.req.json().catch(() => null);
  const password = body?.password;
  if (typeof password !== "string" || !password) {
    failed();
    throw new CrmError("password is required", 400);
  }
  try {
    const { token, maxAge } = await login(password);
    attempts.delete(ip);
    // Secure only over HTTPS (directly or behind a proxy), so plain-HTTP LAN installs can still sign in.
    const https = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto")?.split(",")[0].trim() === "https";
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: https, path: "/", maxAge });
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof CrmError && e.status === 401) failed();
    throw e;
  }
});

api.post("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Everything below needs a session cookie or an API key (Bearer).
api.use("*", async (c, next) => {
  if (await verifySession(getCookie(c, COOKIE))) {
    c.set("actor", userActor);
    return next();
  }
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const agent = await actorFromApiKey(bearer);
  if (!agent) throw new CrmError("Not signed in", 401);
  c.set("actor", agent);
  // Reading CRM data (records, search, export, audit, dashboard…) needs the read scope.
  if (c.req.method === "GET" && !/\/me$/.test(c.req.path)) requireScope(agent, "read");
  return next();
});

const userOnly = (c: { get: (k: "actor") => Actor }) => {
  if (c.get("actor").type !== "user") throw new CrmError("Only the signed-in user can do this", 403);
};

api.get("/dashboard", async (c) => c.json(await dashboard()));
api.get("/settings", async (c) => c.json(await getUiSettings()));
api.patch("/settings", async (c) => {
  userOnly(c);
  return c.json(await updateUiSettings(await c.req.json()));
});
api.post("/logout-all", async (c) => {
  userOnly(c);
  await signOutEverywhere();
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});
api.get("/me", (c) => c.json({ actor: c.get("actor"), mcp_url: `${config.publicUrl ?? new URL(c.req.url).origin}/mcp` }));

/* --------------------------------- schema ---------------------------------- */

api.get("/schema", async (c) => c.json({ objects: await loadSchema(), counts: await counts() }));
api.post("/objects", async (c) => c.json(await createObjectType(c.get("actor"), await c.req.json())));
api.patch("/objects/:slug", async (c) => c.json(await updateObjectType(c.get("actor"), c.req.param("slug"), await c.req.json())));
api.delete("/objects/:slug", async (c) =>
  c.json(await requestOrApply(c.get("actor"), { kind: "archive_object", object: c.req.param("slug") })),
);
api.post("/objects/:slug/fields", async (c) => c.json(await addField(c.get("actor"), c.req.param("slug"), await c.req.json())));
api.patch("/objects/:slug/fields/:key", async (c) => {
  const { type, remove_choices, ...patch } = await c.req.json();
  const [slug, key] = [c.req.param("slug"), c.req.param("key")];
  if (type) await requestOrApply(c.get("actor"), { kind: "change_field_type", object: slug, field: key, type });
  if (remove_choices?.length)
    await requestOrApply(c.get("actor"), { kind: "remove_choices", object: slug, field: key, values: remove_choices });
  return c.json(await updateField(c.get("actor"), slug, key, patch));
});
api.delete("/objects/:slug/fields/:key", async (c) =>
  c.json(await requestOrApply(c.get("actor"), { kind: "archive_field", object: c.req.param("slug"), field: c.req.param("key") })),
);

/* --------------------------------- records --------------------------------- */

/** A non-negative integer query parameter, capped at max. Missing or empty → fallback. */
function intParam(v: string | undefined, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  if (v === undefined || v === "") return fallback;
  if (!/^\d{1,15}$/.test(v)) throw new CrmError(`${name} must be a whole number of 0 or more`);
  return Math.min(Number(v), max);
}

function listParams(q: Record<string, string>) {
  let filters: Filter[] | undefined;
  try {
    filters = q.filters ? JSON.parse(q.filters) : undefined;
  } catch {
    throw new CrmError("filters must be JSON");
  }
  return { q: q.q, filters, sort: q.sort, dir: q.dir as "asc" | "desc" };
}

api.get("/objects/:slug/records", async (c) => {
  const q = c.req.query();
  return c.json(
    await listRecords(c.req.param("slug"), {
      ...listParams(q),
      limit: intParam(q.limit, "limit", 100, 500),
      offset: intParam(q.offset, "offset", 0),
    }),
  );
});
// Counts (and an optional number-field sum) per select value, for board columns.
api.get("/objects/:slug/groups", async (c) => {
  const q = c.req.query();
  if (!q.field) throw new CrmError("field is required");
  return c.json(await groupRecords(c.req.param("slug"), q.field, { ...listParams(q), sum: q.sum || undefined }));
});
// Writes by a key without the read scope return only {id, action} (see writeReply).
api.post("/objects/:slug/records", async (c) => {
  const rec = await createRecord(c.get("actor"), c.req.param("slug"), await c.req.json());
  return c.json(writeReply(c.get("actor"), "created", rec.id, rec));
});
api.get("/records/:id", async (c) => c.json(await getRecord(c.req.param("id"))));
api.patch("/records/:id", async (c) => {
  const rec = await updateRecord(c.get("actor"), c.req.param("id"), await c.req.json());
  return c.json(writeReply(c.get("actor"), "updated", rec.id, rec));
});
api.delete("/records/:id", async (c) => c.json(await archiveRecord(c.get("actor"), c.req.param("id"))));
api.post("/records/:id/restore", async (c) => {
  const id = c.req.param("id");
  return c.json(writeReply(c.get("actor"), "restored", id, await restoreRecord(c.get("actor"), id)));
});
api.get("/records/:id/timeline", async (c) => c.json(await timeline(c.req.param("id"))));
api.post("/records/:id/activities", async (c) =>
  c.json(await logActivity(c.get("actor"), { ...(await c.req.json()), record_id: c.req.param("id") })),
);

/* ------------------------------- activities -------------------------------- */

api.post("/activities", async (c) => c.json(await logActivity(c.get("actor"), await c.req.json())));
api.patch("/activities/:id", async (c) => c.json(await updateActivity(c.get("actor"), c.req.param("id"), await c.req.json())));
api.delete("/activities/:id", async (c) => c.json(await deleteActivity(c.get("actor"), c.req.param("id"))));
api.get("/tasks", async (c) => c.json(await listTasks({ open: c.req.query("all") !== "1", record_id: c.req.query("record_id") || undefined })));
api.get("/search", async (c) => c.json(await searchAll(c.req.query("q") ?? "")));

/* -------------------------- approvals, audit, keys ------------------------- */

api.get("/changes", async (c) => c.json(await listChanges(c.req.query("status"))));
api.post("/changes/:id/:decision{approve|reject}", async (c) => {
  userOnly(c);
  return c.json(await decideChange(c.req.param("id"), c.req.param("decision") === "approve"));
});
api.get("/audit", async (c) => {
  const rows = await listAudit(intParam(c.req.query("limit"), "limit", 200, 1000));
  return c.json(rows.map((r) => ({ ...r, undoable: UNDOABLE.has(r.action) && !r.undone_at })));
});
api.post("/audit/:id/undo", async (c) => {
  userOnly(c);
  const { force } = await c.req.json().catch(() => ({ force: false }));
  return c.json(await undoEntry(c.get("actor"), c.req.param("id"), !!force));
});

/* ------------------------------ views / import ----------------------------- */

api.get("/objects/:slug/views", async (c) => c.json(await listViews(c.req.param("slug"))));
api.post("/objects/:slug/views", async (c) => c.json(await createView(c.get("actor"), c.req.param("slug"), await c.req.json())));
api.patch("/views/:id", async (c) => c.json(await updateView(c.get("actor"), c.req.param("id"), await c.req.json())));
api.delete("/views/:id", async (c) => c.json(await deleteView(c.get("actor"), c.req.param("id"))));

api.post("/objects/:slug/import", async (c) => {
  const { rows, ...opts } = await c.req.json();
  return c.json(await importRows(c.get("actor"), c.req.param("slug"), rows, opts));
});
api.get("/objects/:slug/export.csv", async (c) => {
  const slug = c.req.param("slug");
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="${slug}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body(await exportCsv(slug));
});

/* --------------------------------- webhooks -------------------------------- */

api.get("/webhooks", async (c) => {
  userOnly(c);
  return c.json({ webhooks: await listWebhooks(), events: WEBHOOK_EVENTS });
});
api.post("/webhooks", async (c) => {
  userOnly(c);
  return c.json(await createWebhook(await c.req.json()));
});
api.patch("/webhooks/:id", async (c) => {
  userOnly(c);
  return c.json(await updateWebhook(c.req.param("id"), await c.req.json()));
});
api.delete("/webhooks/:id", async (c) => {
  userOnly(c);
  return c.json(await deleteWebhook(c.req.param("id")));
});
api.post("/webhooks/:id/test", async (c) => {
  userOnly(c);
  return c.json(await testWebhook(c.req.param("id")));
});

api.get("/keys", async (c) => {
  userOnly(c);
  return c.json(await listApiKeys());
});
api.post("/keys", async (c) => {
  userOnly(c);
  const { name, scopes } = await c.req.json();
  return c.json(await createApiKey(name ?? "", scopes ?? []));
});
api.delete("/keys/:id", async (c) => {
  userOnly(c);
  return c.json(await revokeApiKey(c.req.param("id")));
});

