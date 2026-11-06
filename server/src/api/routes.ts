import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { deleteActivity, listTasks, logActivity, timeline, updateActivity } from "../core/activities.js";
import { listAudit } from "../core/audit.js";
import { actorFromApiKey, createApiKey, listApiKeys, login, revokeApiKey, verifySession } from "../core/auth.js";
import { decideChange, listChanges, requestOrApply } from "../core/changes.js";
import {
  archiveRecord,
  counts,
  createRecord,
  getRecord,
  listRecords,
  restoreRecord,
  searchAll,
  updateRecord,
  type Filter,
} from "../core/records.js";
import { addField, createObjectType, loadSchema, updateField, updateObjectType } from "../core/schema.js";
import { CrmError, userActor, type Actor } from "../core/types.js";
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

const attempts = new Map<string, { n: number; until: number }>();

api.post("/login", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0] ?? "local";
  const a = attempts.get(ip);
  if (a && a.n >= 10 && a.until > Date.now()) throw new CrmError("Too many attempts, try again in a few minutes", 429);
  const { password } = await c.req.json<{ password: string }>();
  try {
    const { token, maxAge } = await login(password ?? "");
    attempts.delete(ip);
    // Secure only over HTTPS (directly or behind a proxy), so plain-HTTP LAN installs can still sign in.
    const https = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto")?.split(",")[0].trim() === "https";
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: https, path: "/", maxAge });
    return c.json({ ok: true });
  } catch (e) {
    attempts.set(ip, { n: (a?.n ?? 0) + 1, until: Date.now() + 5 * 60_000 });
    throw e;
  }
});

api.post("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// Everything below needs a session cookie or an API key (Bearer).
api.use("*", async (c, next) => {
  if (verifySession(getCookie(c, COOKIE))) {
    c.set("actor", userActor);
    return next();
  }
  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const agent = await actorFromApiKey(bearer);
  if (!agent) throw new CrmError("Not signed in", 401);
  c.set("actor", agent);
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

api.get("/objects/:slug/records", async (c) => {
  const q = c.req.query();
  let filters: Filter[] | undefined;
  try {
    filters = q.filters ? JSON.parse(q.filters) : undefined;
  } catch {
    throw new CrmError("filters must be JSON");
  }
  return c.json(
    await listRecords(c.req.param("slug"), {
      q: q.q,
      filters,
      sort: q.sort,
      dir: q.dir as "asc" | "desc",
      limit: q.limit ? Number(q.limit) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    }),
  );
});
api.post("/objects/:slug/records", async (c) => c.json(await createRecord(c.get("actor"), c.req.param("slug"), await c.req.json())));
api.get("/records/:id", async (c) => c.json(await getRecord(c.req.param("id"))));
api.patch("/records/:id", async (c) => c.json(await updateRecord(c.get("actor"), c.req.param("id"), await c.req.json())));
api.delete("/records/:id", async (c) => c.json(await archiveRecord(c.get("actor"), c.req.param("id"))));
api.post("/records/:id/restore", async (c) => c.json(await restoreRecord(c.get("actor"), c.req.param("id"))));
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
  const rows = await listAudit(Number(c.req.query("limit") ?? 200));
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

