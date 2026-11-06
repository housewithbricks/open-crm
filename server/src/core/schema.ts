import { json, sql, type Db } from "../db.js";
import { isColor, OBJECT_COLORS } from "./settings.js";
import { audit, transaction } from "./audit.js";
import { checkDistinct, coerceValue, normalizeChoices, slugify } from "./fields.js";
import {
  CrmError,
  FIELD_TYPES,
  notFound,
  requireScope,
  type Actor,
  type FieldDef,
  type FieldOptions,
  type FieldType,
  type ObjectType,
} from "./types.js";

let cache: ObjectType[] | null = null;
export const invalidateSchema = () => {
  cache = null;
};

export async function loadSchema(): Promise<ObjectType[]> {
  if (cache) return cache;
  const objects = await sql<ObjectType[]>`
    select id, slug, label, label_plural, description, icon, color, primary_field, is_system, position, created_by
    from object_types where archived_at is null order by position, created_at`;
  const fields = await sql<(FieldDef & { object_type_id: string })[]>`
    select id, object_type_id, key, label, description, type, options, required, is_unique, position, is_system, created_by
    from field_defs where archived_at is null order by position, created_at`;
  for (const o of objects) o.fields = fields.filter((f) => f.object_type_id === o.id);
  cache = objects;
  return objects;
}

/** An object by slug, or by plural label when no slug matches. */
export async function getObject(slug: string) {
  if (typeof slug !== "string") throw new CrmError("Name the object by its slug");
  const all = await loadSchema();
  const s = all.find((o) => o.slug === slug) ?? all.find((o) => o.label_plural.toLowerCase() === slug.toLowerCase());
  if (!s) throw new CrmError(`Object "${slug}" not found. Objects: ${all.map((o) => o.slug).join(", ")}`, 404);
  return s;
}

/** A plural label is also a name objects are looked up by, so it can't be another live object's slug or plural. */
async function checkPluralFree(labelPlural: string, selfId?: string) {
  const name = labelPlural.toLowerCase();
  const clash = (await loadSchema()).find((o) => o.id !== selfId && (o.slug === name || o.label_plural.toLowerCase() === name));
  if (clash) throw new CrmError(`"${labelPlural}" is already the name of ${clash.slug}`, 409);
}

export function getField(obj: ObjectType, key: string) {
  const f = obj.fields.find((x) => x.key === key);
  if (!f) throw new CrmError(`Field "${key}" not found on ${obj.slug}. Fields: ${obj.fields.map((x) => x.key).join(", ")}`, 404);
  return f;
}

/* ---------------------------------- objects --------------------------------- */

export type NewField = {
  key?: string;
  label: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  unique?: boolean;
  choices?: (string | { value?: string; label: string; color?: string; kind?: string; probability?: number | null })[];
  target?: string;
  multiple?: boolean;
  currency?: string;
};

export type NewObject = {
  slug?: string;
  label: string;
  label_plural?: string;
  description?: string;
  icon?: string;
  color?: string;
  fields?: NewField[];
};

export async function createObjectType(actor: Actor, input: NewObject) {
  requireScope(actor, "schema");
  if (typeof input.label !== "string" || !input.label.trim()) throw new CrmError("Object needs a label");
  for (const k of ["slug", "label_plural", "description", "icon", "color"] as const) {
    if (input[k] !== undefined && typeof input[k] !== "string") throw new CrmError(`${k} must be a string`);
  }
  if (input.fields !== undefined && (!Array.isArray(input.fields) || input.fields.some((f) => !f || typeof f !== "object"))) {
    throw new CrmError("fields must be a list of field definitions");
  }
  const labelPlural = input.label_plural || (input.label.endsWith("s") ? input.label : input.label + "s");
  const slug = slugify(input.slug || labelPlural);
  if (!slug) throw new CrmError("Object needs a label");
  const [taken] = await sql<{ archived: boolean }[]>`select archived_at is not null as archived from object_types where slug = ${slug}`;
  if (taken?.archived) throw new CrmError("An archived object uses this name. Restore it from the audit log or pick another name.", 409);
  if (taken) throw new CrmError(`Object "${slug}" already exists`, 409);
  await checkPluralFree(labelPlural);
  await checkPluralFree(slug);
  if (input.color && !isColor(input.color)) throw new CrmError(`color must be a hex color like #0ea5e9 or one of ${OBJECT_COLORS.join(", ")}`);

  // Check every field before writing anything, so a bad definition leaves nothing behind.
  const fields = [...(input.fields ?? [])];
  if (!fields.some((f) => (f.key || slugify(f.label)) === "name")) fields.unshift({ key: "name", label: "Name", type: "text", required: true });
  const self = [slug, input.label.toLowerCase(), labelPlural.toLowerCase()];
  const defs: PreparedField[] = [];
  for (const f of fields) {
    const d = await prepareField(f, self.includes(String(f.target ?? "").toLowerCase()) ? slug : undefined);
    if (defs.some((x) => x.key === d.key)) throw new CrmError(`Field "${d.key}" is listed twice`);
    defs.push(d);
  }

  const [{ max }] = await sql<{ max: number }[]>`select coalesce(max(position), 0) as max from object_types`;
  // Give every object a color so it's recognisable in links, search and the sidebar.
  const palette = ["blue", "violet", "green", "amber", "pink", "teal", "orange", "red"];
  const used = (await loadSchema()).map((o) => o.color);
  const color = input.color?.toLowerCase() || palette.find((c) => !used.includes(c)) || palette[(max + 1) % palette.length];
  try {
    await transaction(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into object_types (slug, label, label_plural, description, icon, color, position, created_by)
        values (${slug}, ${input.label}, ${labelPlural}, ${input.description ?? ""},
                ${input.icon ?? ""}, ${color}, ${max + 1}, ${actor.name})
        returning id`;
      await audit(tx, actor, "object.create", slug, row.id, null, input);
      for (let i = 0; i < defs.length; i++) await insertField(tx, actor, row.id, slug, defs[i], i, fields[i]);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new CrmError(`Object "${slug}" already exists`, 409);
    throw e;
  } finally {
    invalidateSchema();
  }
  return getObject(slug);
}

const OBJECT_KEYS = ["label", "label_plural", "description", "icon", "color", "primary_field"] as const;
export type ObjectPatch = Partial<Pick<ObjectType, (typeof OBJECT_KEYS)[number]>>;

export async function updateObjectType(actor: Actor, slug: string, patch: ObjectPatch) {
  requireScope(actor, "schema");
  const obj = await getObject(slug);
  if (patch.primary_field) getField(obj, patch.primary_field);
  if (patch.label_plural !== undefined) await checkPluralFree(String(patch.label_plural), obj.id);
  if (patch.color !== undefined && !isColor(patch.color)) {
    throw new CrmError(`color must be a hex color like #0ea5e9 or one of ${OBJECT_COLORS.join(", ")}`);
  }
  if (patch.color) patch = { ...patch, color: patch.color.toLowerCase() };
  const keys = OBJECT_KEYS.filter((k) => patch[k] !== undefined);
  try {
    await transaction(async (tx) => {
      const [cur] = await tx<ObjectType[]>`select * from object_types where id = ${obj.id} and archived_at is null for update`;
      if (!cur) throw notFound(`Object ${slug}`);
      const next = { ...cur, ...pick(patch, keys) } as ObjectType;
      await writeObject(tx, cur, next);
      // Snapshot what this edit set and what it replaced, so undo can put it back.
      await audit(tx, actor, "object.update", obj.slug, obj.id, pick(cur, keys), pick(next, keys));
    });
  } finally {
    invalidateSchema();
  }
  return getObject(obj.slug);
}

/** Write an object's editable columns. A new primary field re-derives every record's display name. */
export async function writeObject(tx: Db, cur: ObjectType, next: ObjectType) {
  await tx`update object_types set label = ${next.label}, label_plural = ${next.label_plural},
            description = ${next.description}, icon = ${next.icon}, color = ${next.color},
            primary_field = ${next.primary_field} where id = ${cur.id}`;
  if (next.primary_field !== cur.primary_field) {
    await tx`update records set display_name = coalesce(data->>${next.primary_field}, '') where object_type_id = ${cur.id}`;
  }
}

/* ---------------------------------- fields ---------------------------------- */

type PreparedField = { key: string; type: FieldType; options: FieldOptions };

/** Validate a new field definition. selfTarget is the slug of an object being created, for relations to itself. */
async function prepareField(input: NewField, selfTarget?: string): Promise<PreparedField> {
  const raw = input.key || input.label || "";
  if (typeof raw !== "string") throw new CrmError("Field key and label must be strings");
  const key = slugify(raw);
  if (!key || key === "id") throw new CrmError("Invalid field key");
  if (!FIELD_TYPES.includes(input.type)) throw new CrmError(`Invalid type "${input.type}". Types: ${FIELD_TYPES.join(", ")}`);
  const options: FieldOptions = {};
  if (input.type === "select" || input.type === "multi_select") options.choices = normalizeChoices(input.choices);
  if (input.type === "relation") {
    if (!input.target) throw new CrmError("relation fields need a target object slug");
    options.target = selfTarget ?? (await getObject(input.target)).slug;
    options.multiple = !!input.multiple;
  }
  if (input.type === "currency") options.currency = input.currency || "USD";
  return { key, type: input.type, options };
}

async function insertField(tx: Db, actor: Actor, objectId: string, slug: string, d: PreparedField, position: number, input: NewField) {
  const [row] = await tx<{ id: string }[]>`
    insert into field_defs (object_type_id, key, label, description, type, options, required, is_unique, position, created_by)
    values (${objectId}, ${d.key}, ${input.label}, ${input.description ?? ""}, ${d.type}, ${json(d.options)}::jsonb,
            ${!!input.required}, ${!!input.unique}, ${position}, ${actor.name})
    returning id`;
  await audit(tx, actor, "field.create", slug, row.id, null, { ...input, key: d.key });
}

export async function addField(actor: Actor, slug: string, input: NewField) {
  requireScope(actor, "schema");
  const obj = await getObject(slug);
  const d = await prepareField(input);
  const existing = await sql`select id from field_defs where object_type_id = ${obj.id} and key = ${d.key}`;
  if (existing.length) throw new CrmError(`Field "${d.key}" already exists on ${obj.slug} (it may be archived)`, 409);
  const position = obj.fields.length ? Math.max(...obj.fields.map((f) => f.position)) + 1 : 0;
  try {
    await transaction((tx) => insertField(tx, actor, obj.id, obj.slug, d, position, input));
  } finally {
    invalidateSchema();
  }
  return getField(await getObject(obj.slug), d.key);
}

export type FieldPatch = {
  label?: string;
  description?: string;
  required?: boolean;
  position?: number;
  add_choices?: (string | { value?: string; label: string; color?: string; kind?: string; probability?: number | null })[];
  /** Replace the full choice list (reorder / recolor / relabel). Removing values is destructive. */
  choices?: { value: string; label: string; color?: string; kind?: string; probability?: number | null }[];
};

/** Non-destructive field edits. Removing choices or changing type goes through destructiveChange. */
export async function updateField(actor: Actor, slug: string, key: string, patch: FieldPatch) {
  requireScope(actor, "schema");
  const obj = await getObject(slug);
  const f = getField(obj, key);
  try {
    await transaction((tx) => applyFieldUpdate(tx, actor, obj, f, patch));
  } finally {
    invalidateSchema();
  }
  return getField(await getObject(obj.slug), key);
}

/**
 * The write behind updateField, inside the caller's transaction. Returns the new options.
 * It doesn't touch the schema cache: callers invalidate it once their transaction ends.
 */
export async function applyFieldUpdate(tx: Db, actor: Actor, obj: ObjectType, field: FieldDef, patch: FieldPatch) {
  // Lock and re-read the row, so a concurrent edit to this field isn't overwritten with an older copy.
  const f = await lockField(tx, field.id);
  const options = structuredClone(f.options);
  if (patch.add_choices?.length || patch.choices) {
    if (f.type !== "select" && f.type !== "multi_select") throw new CrmError(`${f.key} is not a select field`);
    let choices = options.choices ?? [];
    if (patch.choices) {
      const incoming = normalizeChoices(patch.choices);
      const removed = choices.filter((c) => !patch.choices!.some((n) => n.value === c.value));
      if (removed.length) {
        throw new CrmError(
          `Removing choices (${removed.map((c) => c.value).join(", ")}) is destructive: use request_schema_change with kind "remove_choices"`,
        );
      }
      choices = incoming;
    }
    for (const c of normalizeChoices(patch.add_choices ?? [])) {
      const hit = choices.find((x) => x.value === c.value);
      // Re-adding an option is a no-op; a different label with the same value is a collision.
      if (hit && hit.label.toLowerCase() !== c.label.toLowerCase() && c.label.toLowerCase() !== hit.value) checkDistinct([hit, c]);
      if (!hit) choices.push({ ...c, color: c.color });
    }
    options.choices = choices;
  }
  const next = {
    label: patch.label ?? f.label,
    description: patch.description ?? f.description,
    required: patch.required ?? f.required,
    position: patch.position ?? f.position,
  };
  // Snapshot exactly what changed (options live in options.choices) so undo can restore it.
  const keys = (["label", "description", "required", "position"] as const).filter((k) => next[k] !== f[k]);
  const choicesChanged = JSON.stringify(f.options.choices ?? null) !== JSON.stringify(options.choices ?? null);
  if (!keys.length && !choicesChanged) return options;
  await tx`update field_defs set label = ${next.label}, description = ${next.description}, required = ${next.required},
      position = ${next.position}, options = ${json(options)}::jsonb
    where id = ${f.id}`;
  const before = { ...pick(f, keys), ...(choicesChanged ? { choices: f.options.choices ?? [] } : {}) };
  const after = { ...pick(next, keys), ...(choicesChanged ? { choices: options.choices ?? [] } : {}) };
  await audit(tx, actor, "field.update", obj.slug, f.id, before, after);
  return options;
}

/** The field's current row, locked until the transaction ends. */
export async function lockField(tx: Db, id: string) {
  const [f] = await tx<FieldDef[]>`select * from field_defs where id = ${id} and archived_at is null for update`;
  if (!f) throw notFound("Field");
  return f;
}

/* -------------------------- destructive (approval) -------------------------- */

export type DestructiveChange =
  | { kind: "archive_field"; object: string; field: string }
  | { kind: "archive_object"; object: string }
  | { kind: "change_field_type"; object: string; field: string; type: FieldType }
  | { kind: "remove_choices"; object: string; field: string; values: string[] };

export function describeChange(c: DestructiveChange) {
  switch (c.kind) {
    case "archive_field":
      return `Archive field ${c.object}.${c.field}`;
    case "archive_object":
      return `Archive object ${c.object} and hide all its records`;
    case "change_field_type":
      return `Change ${c.object}.${c.field} type to ${c.type}`;
    case "remove_choices":
      return `Remove options ${c.values.join(", ")} from ${c.object}.${c.field}`;
  }
}

/** Run a destructive schema change. Callers decide if approval is needed first. */
export async function applyDestructive(actor: Actor, c: DestructiveChange) {
  try {
    await transaction((tx) => applyDestructiveIn(tx, actor, c));
  } finally {
    invalidateSchema();
  }
}

/** The write behind applyDestructive, inside the caller's transaction. Callers invalidate the schema cache after. */
export async function applyDestructiveIn(tx: Db, actor: Actor, c: DestructiveChange) {
  const obj = await getObject(c.object);
  let before: unknown = null;
  // Store the resolved slug (the request may name the object by its plural label) and ids, for undo.
  let after: Record<string, unknown> = { ...c, object: obj.slug };
  switch (c.kind) {
    case "archive_object":
      if (obj.is_system) throw new CrmError(`${obj.slug} is a built-in object and cannot be archived`);
      await tx`update object_types set archived_at = now() where id = ${obj.id}`;
      break;
    case "archive_field": {
      const f = getField(obj, c.field);
      if (f.key === obj.primary_field) throw new CrmError("Cannot archive the primary field");
      await tx`update field_defs set archived_at = now() where id = ${f.id}`;
      after.field_id = f.id;
      break;
    }
    case "change_field_type": {
      const f = await lockField(tx, getField(obj, c.field).id);
      before = { type: f.type, options: f.options };
      after.converted = await convertFieldType(tx, obj, f, c.type);
      break;
    }
    case "remove_choices": {
      const f = await lockField(tx, getField(obj, c.field).id);
      const choices = (f.options.choices ?? []).filter((x) => !c.values.includes(x.value));
      await tx`update field_defs set options = ${json({ ...f.options, choices })}::jsonb where id = ${f.id}`;
      break;
    }
  }
  await audit(tx, actor, `schema.${c.kind}`, obj.slug, obj.id, before, after);
}

/**
 * Change a field's type and convert every stored value, archived records included, with the
 * same coercion as a normal write. All or nothing: if any value can't be converted, nothing
 * changes and the error says how many failed, with examples, so they can be fixed or cleared
 * first. Returns how many records changed.
 */
async function convertFieldType(tx: Db, obj: ObjectType, f: FieldDef, type: FieldType) {
  if (!FIELD_TYPES.includes(type)) throw new CrmError(`Invalid type ${type}`);
  if (type === "relation") throw new CrmError("Convert to relation by adding a new relation field instead");
  if (type === f.type) throw new CrmError(`${f.key} is already ${type}`);
  const rows = await tx<{ id: string; v: unknown; live: boolean }[]>`
    select id, data->${f.key} as v, deleted_at is null as live from records
    where object_type_id = ${obj.id} and data ? ${f.key} for update`;

  const options: FieldOptions = {};
  if (type === "currency") options.currency = f.options.currency ?? "USD";
  // Raw value (lowercased) → option value, for select targets.
  const optionFor = new Map<string, string>();
  if (type === "select" || type === "multi_select") {
    // Keep existing options (labels, colors, stage kinds) and add one per other distinct value.
    const choices = [...(f.options.choices ?? [])];
    for (const c of choices) for (const k of [c.value, c.label]) optionFor.set(k.toLowerCase(), c.value);
    const extra: string[] = [];
    for (const r of rows)
      for (const x of Array.isArray(r.v) ? r.v : [r.v]) {
        const s = String(x).trim();
        if (s && !optionFor.has(s.toLowerCase()) && !extra.some((e) => e.toLowerCase() === s.toLowerCase())) extra.push(s);
      }
    normalizeChoices(extra, { allowSame: true }).forEach((c, i) => {
      // Two raw values can share a slug ("Big Co", "big-co"): they become one option.
      const hit = choices.find((x) => x.value === c.value);
      if (!hit) choices.push({ ...c, color: c.color });
      optionFor.set(extra[i].toLowerCase(), hit?.value ?? c.value);
    });
    options.choices = choices;
  }
  const target: FieldDef = { ...f, type, options };
  const labelOf = (x: unknown) => f.options.choices?.find((c) => c.value === x)?.label ?? x;

  const convert = (v: unknown): unknown => {
    const list = (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && String(x).trim() !== "");
    if (type === "select" || type === "multi_select") {
      const vals = [...new Set(list.map((x) => optionFor.get(String(x).trim().toLowerCase())!))];
      if (type === "select" && vals.length > 1) throw new CrmError(`has ${vals.length} values; a select holds one`);
      return type === "select" ? (vals[0] ?? null) : vals;
    }
    if (!list.length) return null;
    // Several values (multi-select, many-relation) only fit a text field, as a list.
    if (list.length > 1) {
      if (type !== "text" && type !== "long_text") throw new CrmError(`has ${list.length} values; ${type} holds one`);
      return list.map((x) => String(labelOf(x))).join(", ");
    }
    return coerceValue(target, labelOf(list[0]));
  };

  const failures: { id: string; value: unknown; error: string }[] = [];
  const updates: { id: string; v: unknown }[] = [];
  for (const r of rows) {
    try {
      let v = convert(r.v);
      if (Array.isArray(v) && !v.length) v = null;
      if (JSON.stringify(v) !== JSON.stringify(r.v)) updates.push({ id: r.id, v });
    } catch (e) {
      failures.push({ id: r.id, value: r.v, error: (e as Error).message.replace(`${f.key}: `, "") });
    }
  }
  if (failures.length) {
    const eg = failures.slice(0, 3).map((x) => JSON.stringify(x.value)).join(", ");
    throw new CrmError(
      `Can't change ${obj.slug}.${f.key} to ${type}: ${failures.length} of ${rows.length} values can't be converted (e.g. ${eg}). ` +
        `Fix or clear those values, then try again. Nothing was changed.`,
      409,
      { failed: failures.length, total: rows.length, examples: failures.slice(0, 20) },
    );
  }

  // Unique fields must stay unique after conversion ("1.0" and "1" both become 1).
  const unique = f.is_unique && !["boolean", "long_text", "multi_select"].includes(type);
  if (unique) {
    const final = new Map(rows.map((r) => [r.id, r.v]));
    for (const u of updates) final.set(u.id, u.v);
    const seen = new Map<string, string>();
    for (const r of rows) {
      const v = final.get(r.id);
      if (!r.live || v === null || v === undefined) continue;
      const k = String(v).toLowerCase();
      if (seen.has(k)) throw new CrmError(`Can't change ${obj.slug}.${f.key} to ${type}: records ${seen.get(k)} and ${r.id} would both have "${v}", and the field is unique. Nothing was changed.`, 409);
      seen.set(k, r.id);
    }
  }

  for (const u of updates) {
    await tx`update records set data = ${u.v === null ? tx`data - ${f.key}` : tx`jsonb_set(data, ${[f.key]}::text[], (${json({ v: u.v })}::jsonb)->'v')`}
      where id = ${u.id}`;
  }
  if (f.key === obj.primary_field && updates.length) {
    await tx`update records set display_name = coalesce(data->>${f.key}, '') where object_type_id = ${obj.id}`;
  }
  await tx`update field_defs set type = ${type}, options = ${json(options)}::jsonb, is_unique = ${unique} where id = ${f.id}`;
  return updates.length;
}

function pick(o: any, keys: readonly string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
