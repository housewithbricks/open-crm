import { json, sql, type Db } from "../db.js";
import { deleteActivity, restoreActivity, revertActivityUpdate } from "./activities.js";
import { archiveRecord, restoreRecord, revertRecordUpdate } from "./records.js";
import { applyDestructive, getField, getObject, invalidateSchema, updateField, writeObject } from "./schema.js";
import { audit } from "./audit.js";
import { CrmError, notFound, type Actor, type ObjectType } from "./types.js";

export const UNDOABLE = new Set([
  "record.create",
  "record.update",
  "record.archive",
  "record.restore",
  "activity.create",
  "activity.update",
  "activity.delete",
  "field.create",
  "field.update",
  "object.create",
  "object.update",
  "schema.archive_field",
  "schema.archive_object",
]);

type Entry = {
  id: string;
  action: string;
  object_slug: string | null;
  target_id: string | null;
  before: any;
  after: any;
  undone_at: string | null;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Reverse one audit entry. Edits are checked for conflicts: if a value changed again after
 * this entry, undo refuses unless force is set. Where the reversal is a single transaction,
 * the entry is marked undone in it, under the row lock, so a concurrent write or a second
 * undo can't slip in between the check and the write.
 */
export async function undoEntry(actor: Actor, id: string, force = false) {
  if (!/^\d{1,18}$/.test(id)) throw new CrmError(`"${id}" is not an audit entry id`);
  const [e] = await sql<Entry[]>`select * from audit_log where id = ${id}`;
  if (!e) throw notFound("Audit entry");
  if (e.undone_at) throw new CrmError("Already undone", 409);
  if (!UNDOABLE.has(e.action)) throw new CrmError(`"${e.action}" can't be undone`);
  const t = e.target_id!;
  const markUndone = async (db: Db) => {
    const [row] = await db`update audit_log set undone_at = now() where id = ${id} and undone_at is null returning id`;
    if (!row) throw new CrmError("Already undone", 409);
  };
  const inTx = async (fn: (tx: Db) => Promise<unknown>) => {
    try {
      await sql.begin(async (tx) => {
        await markUndone(tx);
        await fn(tx);
      });
    } finally {
      invalidateSchema();
    }
  };

  switch (e.action) {
    case "record.update":
      await inTx((tx) => revertRecordUpdate(tx, actor, t, e.before ?? {}, e.after ?? {}, force));
      return { undone: true, id };
    case "object.update":
      await inTx((tx) => undoObjectUpdate(tx, actor, e, force));
      return { undone: true, id };
    case "schema.archive_object":
      await inTx(async (tx) => {
        const [o] = await tx<{ slug: string }[]>`update object_types set archived_at = null
          where id = ${t} and archived_at is not null returning slug`;
        if (!o) throw notFound("Archived object");
        await audit(tx, actor, "object.unarchive", o.slug, t, null, e.after);
      });
      return { undone: true, id };
    case "schema.archive_field":
      // target_id is the object; newer entries also carry the field id.
      await inTx(async (tx) => {
        const [f] = await tx<{ id: string }[]>`update field_defs set archived_at = null where archived_at is not null and
          ${e.after.field_id ? tx`id = ${e.after.field_id}` : tx`object_type_id = ${t} and key = ${e.after.field}`} returning id`;
        if (!f) throw notFound("Archived field");
        await audit(tx, actor, "field.unarchive", e.object_slug, t, null, e.after);
      });
      return { undone: true, id };
    case "record.create":
    case "record.restore":
      await archiveRecord(actor, t);
      break;
    case "record.archive":
      await restoreRecord(actor, t);
      break;
    case "activity.create":
      await deleteActivity(actor, t);
      break;
    case "activity.update":
      await revertActivityUpdate(actor, t, e.before ?? {}, e.after ?? {}, force);
      break;
    case "activity.delete":
      await restoreActivity(actor, t);
      break;
    case "object.create":
      await applyDestructive(actor, { kind: "archive_object", object: e.object_slug! });
      break;
    case "field.create":
      await applyDestructive(actor, { kind: "archive_field", object: e.object_slug!, field: e.after.key });
      break;
    case "field.update":
      await undoFieldUpdate(actor, e, force);
      break;
  }
  await markUndone(sql);
  return { undone: true, id };
}

/** Put an object's label, plural, description, icon, color and primary field back. */
async function undoObjectUpdate(tx: Db, actor: Actor, e: Entry, force: boolean) {
  const [cur] = await tx<ObjectType[]>`select * from object_types where id = ${e.target_id} and archived_at is null for update`;
  if (!cur) throw notFound("Object");
  const before = e.before ?? {};
  const after = e.after ?? {};
  const keys = Object.keys(after).filter((k) => k in before && k in cur) as (keyof ObjectType)[];
  const drifted = keys.filter((k) => !same(cur[k], after[k]));
  if (drifted.length && !force) {
    throw new CrmError(`This object changed again since this edit (${drifted.join(", ")}). Undo anyway to overwrite it.`, 409, { conflict: drifted });
  }
  const next = { ...cur, ...Object.fromEntries(keys.map((k) => [k, before[k]])) } as ObjectType;
  if (next.primary_field !== cur.primary_field) {
    const [f] = await tx`select 1 from field_defs where object_type_id = ${cur.id} and key = ${next.primary_field} and archived_at is null`;
    if (!f) throw new CrmError(`The old primary field "${next.primary_field}" no longer exists`);
  }
  await writeObject(tx, cur, next);
  await audit(tx, actor, "object.update", cur.slug, cur.id,
    Object.fromEntries(keys.map((k) => [k, cur[k]])), Object.fromEntries(keys.map((k) => [k, next[k]])));
}

/**
 * Put a field's label, description, required flag, position and select options back as they
 * were before the edit. Options are snapshotted whole (labels, colors, order, stage kind and
 * probability). Refuses if the field changed again since, unless force is set.
 */
async function undoFieldUpdate(actor: Actor, e: Entry, force: boolean) {
  const [row] = await sql<{ key: string }[]>`select key from field_defs where id = ${e.target_id} and archived_at is null`;
  if (!row) throw notFound("Field");
  const f = getField(await getObject(e.object_slug!), row.key);
  const before = e.before ?? {};
  const after = e.after ?? {};

  // Entries written before options were snapshotted: only "added options" can be reversed.
  if (!("choices" in before) && (after.choices || after.add_choices)) {
    if (after.choices) throw new CrmError("This edit was logged before option changes could be undone. Edit the options by hand instead.");
    const { normalizeChoices } = await import("./fields.js");
    const { add_choices: _, ...restore } = before;
    await updateField(actor, e.object_slug!, f.key, restore);
    const values = normalizeChoices(after.add_choices).map((c) => c.value);
    await applyDestructive(actor, { kind: "remove_choices", object: e.object_slug!, field: f.key, values });
    return;
  }

  const current: Record<string, unknown> = { label: f.label, description: f.description, required: f.required, position: f.position, choices: f.options.choices ?? [] };
  const keys = Object.keys(after).filter((k) => k in current);
  const drifted = keys.filter((k) => !same(current[k], after[k]));
  if (drifted.length && !force) {
    throw new CrmError(`This field changed again since this edit (${drifted.join(", ")}). Undo anyway to overwrite it.`, 409, { conflict: drifted });
  }
  const next = { ...current, ...Object.fromEntries(keys.map((k) => [k, before[k]])) } as typeof current;
  await sql.begin(async (tx) => {
    await tx`update field_defs set label = ${next.label as string}, description = ${next.description as string},
      required = ${next.required as boolean}, position = ${next.position as number},
      options = ${json(keys.includes("choices") ? { ...f.options, choices: next.choices } : f.options)}::jsonb where id = ${f.id}`;
    await audit(tx, actor, "field.update", e.object_slug, f.id,
      Object.fromEntries(keys.map((k) => [k, current[k]])), Object.fromEntries(keys.map((k) => [k, next[k]])));
  });
  invalidateSchema();
}
