import { createHmac, randomBytes } from "node:crypto";
import { sql } from "../db.js";
import { CrmError, notFound } from "./types.js";

export const WEBHOOK_EVENTS = [
  "record.created",
  "record.updated",
  "record.archived",
  "record.restored",
  "activity.created",
  "schema.changed",
  "change.requested",
  "change.decided",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Map an audit action to the public event name. */
export function eventForAction(action: string): WebhookEvent | null {
  if (action === "record.create") return "record.created";
  if (action === "record.update" || action === "record.undo") return "record.updated";
  if (action === "record.archive") return "record.archived";
  if (action === "record.restore") return "record.restored";
  if (action === "activity.create") return "activity.created";
  if (action === "change.request") return "change.requested";
  if (action === "change.approve" || action === "change.reject") return "change.decided";
  if (/^(object|field|schema)\./.test(action)) return "schema.changed";
  return null;
}

type Hook = { id: string; url: string; events: string[]; secret: string };

export type EventPayload = {
  id: string;
  event: WebhookEvent;
  action: string;
  actor: { type: string; name: string };
  object: string | null;
  target_id: string | null;
  before: unknown;
  after: unknown;
  at: string;
};

export function sign(secret: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/** Fire-and-forget delivery to every active hook subscribed to the event. Never throws. */
export function emit(payload: EventPayload) {
  void (async () => {
    try {
      const hooks = await sql<Hook[]>`select id, url, events, secret from webhooks
        where active and (${payload.event} = any(events) or '*' = any(events))`;
      await Promise.all(hooks.map((h) => deliver(h, payload)));
    } catch (e) {
      console.error("[webhooks] emit failed", e);
    }
  })();
}

async function deliver(hook: Hook, payload: unknown, attempt = 1): Promise<{ status: number | null; error: string | null }> {
  const body = JSON.stringify(payload);
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "OpenCRM-Webhooks/1",
        "x-opencrm-event": (payload as EventPayload).event,
        "x-opencrm-signature": sign(hook.secret, body),
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  if (error && attempt < 3) {
    await new Promise((r) => setTimeout(r, attempt * 2000));
    return deliver(hook, payload, attempt + 1);
  }
  await sql`update webhooks set last_status = ${status}, last_error = ${error}, last_at = now() where id = ${hook.id}`;
  return { status, error };
}

/* ------------------------------- management -------------------------------- */

function checkUrl(url: string) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    throw new CrmError("Webhook URL must be an http(s) URL");
  }
}

function checkEvents(events: string[]) {
  const bad = events.filter((e) => e !== "*" && !WEBHOOK_EVENTS.includes(e as WebhookEvent));
  if (bad.length) throw new CrmError(`Unknown events: ${bad.join(", ")}. Events: *, ${WEBHOOK_EVENTS.join(", ")}`);
  if (!events.length) throw new CrmError("Pick at least one event");
}

export const listWebhooks = () => sql`select * from webhooks order by created_at desc`;

export async function createWebhook(input: { url: string; events?: string[] }) {
  checkUrl(input.url);
  const events = input.events?.length ? input.events : ["*"];
  checkEvents(events);
  const secret = `whsec_${randomBytes(20).toString("base64url")}`;
  const [row] = await sql`insert into webhooks (url, events, secret) values (${input.url}, ${events}::text[], ${secret}) returning *`;
  return row;
}

export async function updateWebhook(id: string, patch: { url?: string; events?: string[]; active?: boolean }) {
  const [cur] = await sql`select * from webhooks where id = ${id}`;
  if (!cur) throw notFound("Webhook");
  if (patch.url) checkUrl(patch.url);
  if (patch.events) checkEvents(patch.events);
  const [row] = await sql`update webhooks set url = ${patch.url ?? cur.url}, events = ${patch.events ?? cur.events}::text[],
    active = ${patch.active ?? cur.active} where id = ${id} returning *`;
  return row;
}

export async function deleteWebhook(id: string) {
  await sql`delete from webhooks where id = ${id}`;
  return { deleted: true };
}

export async function testWebhook(id: string) {
  const [hook] = await sql<Hook[]>`select id, url, events, secret from webhooks where id = ${id}`;
  if (!hook) throw notFound("Webhook");
  return deliver(hook, {
    id: "test",
    event: "ping",
    action: "ping",
    actor: { type: "user", name: "You" },
    object: null,
    target_id: null,
    before: null,
    after: { message: "Hello from Open CRM" },
    at: new Date().toISOString(),
  }, 3);
}
