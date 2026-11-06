import { sql } from "../db.js";
import { deleteActivity, restoreActivity, revertActivityUpdate } from "./activities.js";
import { archiveRecord, getRecord, restoreRecord, updateRecord } from "./records.js";
import { applyDestructive, getField, getObject, invalidateSchema, updateField } from "./schema.js";
import { json } from "../db.js";
import { audit } from "./audit.js";
import { CrmError, notFound, type Actor } from "./types.js";

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
 * Reverse one audit entry. Record edits are checked for conflicts: if a field changed again
 * after this entry, undo refuses unless force is set.
 */
export async function undoEntry(actor: Actor, id: string, force = false) {
  const [e] = await sql<Entry[]>`select * from audit_log where id = ${id}`;
  if (!e) throw notFound("Audit entry");
  if (e.undone_at) throw new CrmError("Already undone", 409);
  if (!UNDOABLE.has(e.action)) throw new CrmError(`"${e.action}" can't be undone`);
  const t = e.target_id!;

  switch (e.action) {
    case "record.update": {
      const { record } = await getRecord(t);
      const drifted = Object.keys(e.after ?? {}).filter((k) => !same(record.data[k], e.after[k]));
      if (drifted.length && !force) {
        throw new CrmError(`These fields changed again since this edit: ${drifted.join(", ")}. Undo anyway to overwrite them.`, 409, { conflict: drifted });
      }
      await updateRecord(actor, t, e.before ?? {});
      break;
    }
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
    case "schema.archive_object": {
      await sql`update object_types set archived_at = null where slug = ${e.after.object}`;
      invalidateSchema();
      await audit(sql, actor, "object.unarchive", e.after.object, t, null, e.after);
      break;
    }
    case "schema.archive_field": {
      await sql`update field_defs set archived_at = null where key = ${e.after.field}
        and object_type_id = (select id from object_types where slug = ${e.after.object})`;
      invalidateSchema();
      await audit(sql, actor, "field.unarchive", e.after.object, t, null, e.after);
      break;
    }
    case "field.update":
      await undoFieldUpdate(actor, e, force);
      break;
  }
  await sql`update audit_log set undone_at = now() where id = ${id}`;
  return { undone: true, id };
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
