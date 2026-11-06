import { sql } from "../db.js";
import { deleteActivity } from "./activities.js";
import { archiveRecord, getRecord, restoreRecord, updateRecord } from "./records.js";
import { applyDestructive, invalidateSchema, updateField } from "./schema.js";
import { audit } from "./audit.js";
import { CrmError, notFound, type Actor } from "./types.js";

export const UNDOABLE = new Set([
  "record.create",
  "record.update",
  "record.archive",
  "record.restore",
  "activity.create",
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
    case "field.update": {
      const [f] = await sql<{ key: string }[]>`select key from field_defs where id = ${t}`;
      if (!f) throw notFound("Field");
      const { add_choices, choices, ...restore } = e.before ?? {};
      await updateField(actor, e.object_slug!, f.key, restore);
      if (e.after?.add_choices?.length) {
        const { normalizeChoices } = await import("./fields.js");
        const values = normalizeChoices(e.after.add_choices).map((c) => c.value);
        await applyDestructive(actor, { kind: "remove_choices", object: e.object_slug!, field: f.key, values });
      }
      break;
    }
  }
  await sql`update audit_log set undone_at = now() where id = ${id}`;
  return { undone: true, id };
}
