import { json, sql } from "../db.js";
import { audit, transaction } from "./audit.js";
import { applyDestructive, applyDestructiveIn, describeChange, invalidateSchema, type DestructiveChange } from "./schema.js";
import { CrmError, notFound, requireScope, userActor, type Actor } from "./types.js";

export type ChangeRequest = {
  id: string;
  actor_type: string;
  actor_name: string;
  kind: string;
  summary: string;
  reason: string;
  payload: DestructiveChange;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
};

/**
 * Destructive schema changes: users apply them at once (the UI confirms first);
 * agents get a pending change request that a human approves.
 */
export async function requestOrApply(actor: Actor, change: DestructiveChange, reason = "") {
  requireScope(actor, "schema");
  if (actor.type === "user") {
    await applyDestructive(actor, change);
    return { applied: true as const };
  }
  const [row] = await sql<ChangeRequest[]>`
    insert into change_requests (actor_type, actor_name, kind, summary, reason, payload)
    values (${actor.type}, ${actor.name}, ${change.kind}, ${describeChange(change)}, ${reason}, ${json(change)}::jsonb)
    returning *`;
  await audit(sql, actor, "change.request", change.object, row.id, null, change);
  return { applied: false as const, change_request: row };
}

export async function listChanges(status?: string) {
  return sql<ChangeRequest[]>`select * from change_requests
    ${status ? sql`where status = ${status}` : sql``} order by created_at desc limit 200`;
}

/** Approve or reject a pending request. The row is locked, so a request is decided once; a second decision is a 409. */
export async function decideChange(id: string, approve: boolean) {
  const status = approve ? "approved" : "rejected";
  try {
    return await transaction(async (tx) => {
      const [cr] = await tx<ChangeRequest[]>`select * from change_requests where id = ${id} for update`;
      if (!cr) throw notFound("Change request");
      if (cr.status !== "pending") throw new CrmError(`Already ${cr.status}`, 409);
      if (approve) await applyDestructiveIn(tx, { ...userActor, name: `You (approving ${cr.actor_name})` }, cr.payload);
      await tx`update change_requests set status = ${status}, decided_at = now() where id = ${id}`;
      await audit(tx, userActor, approve ? "change.approve" : "change.reject", cr.payload.object, id, null, null);
      return { ...cr, status };
    });
  } finally {
    invalidateSchema();
  }
}
