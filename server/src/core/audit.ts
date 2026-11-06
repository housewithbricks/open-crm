import { json, sql, type Sql } from "../db.js";
import type { Actor } from "./types.js";
import { emit, eventForAction } from "./webhooks.js";

export async function audit(
  db: Sql | any,
  actor: Actor,
  action: string,
  objectSlug: string | null,
  targetId: string | null,
  before: unknown,
  after: unknown,
) {
  const [row] = await db`insert into audit_log (actor_type, actor_name, action, object_slug, target_id, before, after)
           values (${actor.type}, ${actor.name}, ${action}, ${objectSlug}, ${targetId},
                   ${json(before)}::jsonb, ${json(after)}::jsonb)
           returning id, created_at`;
  const event = eventForAction(action);
  if (event) {
    emit({
      id: String(row.id),
      event,
      action,
      actor: { type: actor.type, name: actor.name },
      object: objectSlug,
      target_id: targetId,
      before: before ?? null,
      after: after ?? null,
      at: new Date(row.created_at).toISOString(),
    });
  }
  return row;
}

export async function listAudit(limit = 100, targetId?: string) {
  return sql`select * from audit_log
             ${targetId ? sql`where target_id = ${targetId}` : sql``}
             order by id desc limit ${limit}`;
}
