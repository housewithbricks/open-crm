import { json, sql } from "../db.js";
import { audit, transaction } from "./audit.js";
import {
  applyDestructive, applyDestructiveIn, applyFieldUpdate, checkFieldPatch, describeChange, getField, getObject, invalidateSchema,
  type DestructiveChange, type FieldPatch,
} from "./schema.js";
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
  await dryRun(actor, change);
  const [row] = await sql<ChangeRequest[]>`
    insert into change_requests (actor_type, actor_name, kind, summary, reason, payload)
    values (${actor.type}, ${actor.name}, ${change.kind}, ${describeChange(change)}, ${reason}, ${json(change)}::jsonb)
    returning *`;
  await audit(sql, actor, "change.request", change.object, row.id, null, change);
  return { applied: false as const, change_request: row };
}

/**
 * A field edit from the UI or API: a type change and option removals (destructive) plus
 * ordinary edits. For the user it all commits in one transaction, so a failing part leaves
 * the field as it was. For an agent, the ordinary edits are checked first, the destructive
 * parts become change requests, then the ordinary edits apply.
 */
export async function editField(actor: Actor, slug: string, key: string, destructive: DestructiveChange[], patch: FieldPatch) {
  requireScope(actor, "schema");
  checkFieldPatch(patch);
  const obj = await getObject(slug);
  const f = getField(obj, key);
  const hasPatch = Object.keys(patch).length > 0;
  const queued = [];
  try {
    if (actor.type === "user") {
      await transaction(async (tx) => {
        for (const change of destructive) await applyDestructiveIn(tx, actor, change);
        if (hasPatch) await applyFieldUpdate(tx, actor, obj, f, patch);
      });
    } else {
      if (hasPatch) await rollback((tx) => applyFieldUpdate(tx, actor, obj, f, patch));
      for (const change of destructive) {
        const r = await requestOrApply(actor, change);
        if (!r.applied) queued.push(r.change_request);
      }
      if (hasPatch) await transaction((tx) => applyFieldUpdate(tx, actor, obj, f, patch));
    }
  } finally {
    invalidateSchema();
  }
  return { field: getField(await getObject(obj.slug), key), change_requests: queued };
}

const DRY_RUN = Symbol("dry run");

/** Run work in a transaction that always rolls back: it surfaces errors without keeping changes or sending webhooks. */
async function rollback(work: (tx: Parameters<Parameters<typeof transaction>[0]>[0]) => Promise<unknown>) {
  try {
    await transaction(async (tx) => {
      await work(tx);
      throw DRY_RUN;
    });
  } catch (e) {
    if (e !== DRY_RUN) throw e;
  } finally {
    invalidateSchema();
  }
}

/**
 * Apply a change in a transaction that always rolls back, so a request that would fail at
 * approval is refused now. A rollback drops the transaction's queued webhooks.
 */
async function dryRun(actor: Actor, change: DestructiveChange) {
  await rollback((tx) => applyDestructiveIn(tx, actor, change));
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
