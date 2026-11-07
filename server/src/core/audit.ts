import type postgres from "postgres";
import { json, sql, type Db } from "../db.js";
import type { Actor } from "./types.js";
import { emit, eventForAction, type EventPayload } from "./webhooks.js";

/** Webhook events from audits inside a `transaction`, held until it commits. */
const pending = new WeakMap<object, EventPayload[]>();

/**
 * sql.begin, but webhooks for audits made inside it are sent only once it commits,
 * and dropped if it rolls back.
 */
export async function transaction<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const queue: EventPayload[] = [];
  const result = await sql.begin((tx) => {
    pending.set(tx, queue);
    return fn(tx);
  });
  queue.forEach(emit);
  return result as T;
}

export async function audit(
  db: Db,
  actor: Actor,
  action: string,
  objectSlug: string | null,
  targetId: string | null,
  before: unknown,
  after: unknown,
) {
  const [row] = await db`insert into audit_log (actor_type, actor_name, action, object_slug, target_id, before, after, source)
           values (${actor.type}, ${actor.name}, ${action}, ${objectSlug}, ${targetId},
                   ${json(before)}::jsonb, ${json(after)}::jsonb, ${json(actor.source)}::jsonb)
           returning id, created_at`;
  const event = eventForAction(action);
  if (event) {
    const payload: EventPayload = {
      id: String(row.id),
      event,
      action,
      actor: { type: actor.type, name: actor.name },
      object: objectSlug,
      target_id: targetId,
      before: before ?? null,
      after: after ?? null,
      source: actor.source ?? null,
      at: new Date(row.created_at).toISOString(),
    };
    const queue = pending.get(db);
    if (queue) queue.push(payload);
    else emit(payload);
  }
  return row;
}

export async function listAudit(limit = 100, targetId?: string) {
  return sql`select * from audit_log
             ${targetId ? sql`where target_id = ${targetId}` : sql``}
             order by id desc limit ${limit}`;
}
