import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
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
  /** Where the write came from, when the caller gave one. */
  source: { url: string; label?: string } | null;
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

/** An IPv6 address as 8 numbers. Handles "::" and a trailing dotted IPv4 part. */
function hextets(a: string) {
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number);
    a = a.slice(0, v4.index) + ((b0 << 8) | b1).toString(16) + ":" + ((b2 << 8) | b3).toString(16);
  }
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const parts = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return parts.map((x) => parseInt(x, 16));
}

/**
 * The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d, which the URL parser writes as
 * ::ffff:a9fe:a9fe) or NAT64 (64:ff9b::/96) IPv6 address, which reach that IPv4 address.
 */
function embeddedV4(a: string) {
  const h = hextets(a);
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0);
  return mapped || nat64 ? [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join(".") : null;
}

/**
 * Link-local addresses (169.254.0.0/16, fe80::/10), which include the cloud metadata service,
 * and the other well-known metadata addresses, also when written as IPv6. Localhost and private
 * ranges stay allowed: self-hosters point webhooks at their own local services.
 * WEBHOOK_ALLOW_PRIVATE=1 allows all.
 */
export function isBlockedAddress(ip: string) {
  if (process.env.WEBHOOK_ALLOW_PRIVATE === "1") return false;
  let a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(a) === 6) a = embeddedV4(a) ?? a;
  if (isIP(a) === 4) return a.startsWith("169.254.") || a === "100.100.100.200";
  if (isIP(a) === 6) return /^fe[89ab][0-9a-f]:/.test(a) || hextets(a).join(":") === hextets("fd00:ec2::254").join(":");
  return a === "metadata.google.internal" || a === "metadata";
}

const blocked = (host: string, ip: string) =>
  Object.assign(new Error(`${host} points at ${ip}, a link-local or cloud metadata address. Set WEBHOOK_ALLOW_PRIVATE=1 to allow it.`), { code: "EBLOCKED" });

/** DNS lookup that refuses blocked addresses, checked at connect time so a hostname can't sneak past. */
const guardedLookup: any = (host: string, opts: any, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) =>
  dnsLookup(host, opts, (err, address: string | LookupAddress[], family?: number) => {
    if (err) return cb(err, address, family);
    const bad = (Array.isArray(address) ? address : [{ address, family }]).find((x) => isBlockedAddress(x.address as string));
    if (bad) return cb(blocked(host, bad.address as string), address, family);
    cb(null, address, family);
  });

/** POST without following redirects (a 3xx is reported as a failed delivery). */
function post(url: string, headers: Record<string, string>, body: string) {
  return new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isBlockedAddress(host)) return reject(blocked(u.hostname, host));
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: guardedLookup, signal: AbortSignal.timeout(8000) },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function deliver(hook: Hook, payload: unknown, attempt = 1): Promise<{ status: number | null; error: string | null }> {
  const body = JSON.stringify(payload);
  let status: number | null = null;
  let error: string | null = null;
  let retry = true;
  try {
    status = await post(hook.url, {
      "content-type": "application/json",
      "user-agent": "OpenCRM-Webhooks/1",
      "x-opencrm-event": (payload as EventPayload).event,
      "x-opencrm-signature": sign(hook.secret, body),
    }, body);
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (e) {
    error = (e as Error).message;
    retry = (e as { code?: string }).code !== "EBLOCKED";
  }
  if (error && retry && attempt < 3) {
    await new Promise((r) => setTimeout(r, attempt * 2000));
    return deliver(hook, payload, attempt + 1);
  }
  await sql`update webhooks set last_status = ${status}, last_error = ${error}, last_at = now() where id = ${hook.id}`;
  return { status, error };
}

/* ------------------------------- management -------------------------------- */

function checkUrl(url: string) {
  let u: URL;
  try {
    u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    throw new CrmError("Webhook URL must be an http(s) URL");
  }
  if (isBlockedAddress(u.hostname)) {
    throw new CrmError("Webhook URL points at a link-local or cloud metadata address. Set WEBHOOK_ALLOW_PRIVATE=1 to allow it.");
  }
}

function checkEvents(events: string[]) {
  if (!Array.isArray(events)) throw new CrmError("events must be a list");
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
    source: null,
    at: new Date().toISOString(),
  }, 3);
}
