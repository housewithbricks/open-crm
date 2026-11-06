import { json, sql } from "../db.js";
import { isColor, OBJECT_COLORS } from "./settings.js";
import { audit } from "./audit.js";
import { normalizeChoices, slugify } from "./fields.js";
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

export async function getObject(slug: string) {
  const s = (await loadSchema()).find((o) => o.slug === slug || o.label_plural.toLowerCase() === slug.toLowerCase());
  if (!s) {
    const all = (await loadSchema()).map((o) => o.slug).join(", ");
    throw new CrmError(`Object "${slug}" not found. Objects: ${all}`, 404);
  }
  return s;
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
  const labelPlural = input.label_plural || (input.label.endsWith("s") ? input.label : input.label + "s");
  const slug = slugify(input.slug || labelPlural);
  if (!slug) throw new CrmError("Object needs a label");
  if ((await loadSchema()).some((o) => o.slug === slug)) throw new CrmError(`Object "${slug}" already exists`, 409);
  const [{ max }] = await sql<{ max: number }[]>`select coalesce(max(position), 0) as max from object_types`;
  // Give every object a color so it's recognisable in links, search and the sidebar.
  const palette = ["blue", "violet", "green", "amber", "pink", "teal", "orange", "red"];
  const used = (await loadSchema()).map((o) => o.color);
  if (input.color && !isColor(input.color)) throw new CrmError(`color must be a hex color like #0ea5e9 or one of ${OBJECT_COLORS.join(", ")}`);
  const color = input.color?.toLowerCase() || palette.find((c) => !used.includes(c)) || palette[(max + 1) % palette.length];
  const [row] = await sql<{ id: string }[]>`
    insert into object_types (slug, label, label_plural, description, icon, color, position, created_by)
    values (${slug}, ${input.label}, ${labelPlural}, ${input.description ?? ""},
            ${input.icon ?? ""}, ${color}, ${max + 1}, ${actor.name})
    returning id`;
  invalidateSchema();
  await audit(sql, actor, "object.create", slug, row.id, null, input);
  const fields = input.fields ?? [];
  if (!fields.some((f) => (f.key || slugify(f.label)) === "name")) {
    fields.unshift({ key: "name", label: "Name", type: "text", required: true });
  }
  for (const f of fields) await addField(actor, slug, f);
  return getObject(slug);
}

export async function updateObjectType(
  actor: Actor,
  slug: string,
  patch: Partial<Pick<ObjectType, "label" | "label_plural" | "description" | "icon" | "color" | "primary_field">>,
) {
  requireScope(actor, "schema");
  const obj = await getObject(slug);
  if (patch.primary_field) getField(obj, patch.primary_field);
  if (patch.color !== undefined && !isColor(patch.color)) {
    throw new CrmError(`color must be a hex color like #0ea5e9 or one of ${OBJECT_COLORS.join(", ")}`);
  }
  if (patch.color) patch = { ...patch, color: patch.color.toLowerCase() };
  const next = { ...obj, ...patch };
  await sql`update object_types set label = ${next.label}, label_plural = ${next.label_plural},
            description = ${next.description}, icon = ${next.icon}, color = ${next.color},
            primary_field = ${next.primary_field} where id = ${obj.id}`;
  if (patch.primary_field && patch.primary_field !== obj.primary_field) {
    await sql`update records set display_name = coalesce(data->>${patch.primary_field}, '') where object_type_id = ${obj.id}`;
  }
  invalidateSchema();
  await audit(sql, actor, "object.update", slug, obj.id, pick(obj, Object.keys(patch)), patch);
  return getObject(slug);
}

/* ---------------------------------- fields ---------------------------------- */

export async function addField(actor: Actor, slug: string, input: NewField) {
  requireScope(actor, "schema");
  const obj = await getObject(slug);
  const key = slugify(input.key || input.label);
  if (!key || key === "id") throw new CrmError("Invalid field key");
  if (!FIELD_TYPES.includes(input.type)) throw new CrmError(`Invalid type "${input.type}". Types: ${FIELD_TYPES.join(", ")}`);
  const existing = await sql`select id from field_defs where object_type_id = ${obj.id} and key = ${key}`;
  if (existing.length) throw new CrmError(`Field "${key}" already exists on ${obj.slug} (it may be archived)`, 409);

  const options: FieldOptions = {};
  if (input.type === "select" || input.type === "multi_select") options.choices = normalizeChoices(input.choices);
  if (input.type === "relation") {
    if (!input.target) throw new CrmError("relation fields need a target object slug");
    options.target = (await getObject(input.target)).slug;
    options.multiple = !!input.multiple;
  }
  if (input.type === "currency") options.currency = input.currency || "USD";

  const position = obj.fields.length ? Math.max(...obj.fields.map((f) => f.position)) + 1 : 0;
  const [row] = await sql<{ id: string }[]>`
    insert into field_defs (object_type_id, key, label, description, type, options, required, is_unique, position, created_by)
    values (${obj.id}, ${key}, ${input.label}, ${input.description ?? ""}, ${input.type}, ${json(options)}::jsonb,
            ${!!input.required}, ${!!input.unique}, ${position}, ${actor.name})
    returning id`;
  invalidateSchema();
  await audit(sql, actor, "field.create", obj.slug, row.id, null, { key, ...input });
  return getField(await getObject(slug), key);
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
  const options = structuredClone(f.options);
  if (patch.add_choices?.length || patch.choices) {
    if (f.type !== "select" && f.type !== "multi_select") throw new CrmError(`${key} is not a select field`);
    let choices = options.choices ?? [];
    if (patch.choices) {
      const removed = choices.filter((c) => !patch.choices!.some((n) => n.value === c.value));
      if (removed.length) {
        throw new CrmError(
          `Removing choices (${removed.map((c) => c.value).join(", ")}) is destructive: use request_schema_change with kind "remove_choices"`,
        );
      }
      choices = normalizeChoices(patch.choices);
    }
    for (const c of normalizeChoices(patch.add_choices ?? [])) {
      if (!choices.some((x) => x.value === c.value)) choices.push({ ...c, color: c.color });
    }
    options.choices = choices;
  }
  await sql`update field_defs set
      label = ${patch.label ?? f.label},
      description = ${patch.description ?? f.description},
      required = ${patch.required ?? f.required},
      position = ${patch.position ?? f.position},
      options = ${json(options)}::jsonb
    where id = ${f.id}`;
  invalidateSchema();
  await audit(sql, actor, "field.update", obj.slug, f.id, pick(f, Object.keys(patch)), patch);
  return getField(await getObject(slug), key);
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
  const obj = await getObject(c.object);
  switch (c.kind) {
    case "archive_object":
      if (obj.is_system) throw new CrmError(`${obj.slug} is a built-in object and cannot be archived`);
      await sql`update object_types set archived_at = now() where id = ${obj.id}`;
      break;
    case "archive_field": {
      const f = getField(obj, c.field);
      if (f.key === obj.primary_field) throw new CrmError("Cannot archive the primary field");
      await sql`update field_defs set archived_at = now() where id = ${f.id}`;
      break;
    }
    case "change_field_type": {
      const f = getField(obj, c.field);
      if (!FIELD_TYPES.includes(c.type)) throw new CrmError(`Invalid type ${c.type}`);
      if (c.type === "relation") throw new CrmError("Convert to relation by adding a new relation field instead");
      const options: FieldOptions = c.type === "select" || c.type === "multi_select" ? { choices: [] } : {};
      if (c.type === "select" || c.type === "multi_select") {
        // derive choices from existing values so nothing is lost
        const vals = await sql<{ v: string }[]>`select distinct data->>${f.key} as v from records
          where object_type_id = ${obj.id} and data->>${f.key} is not null and deleted_at is null limit 200`;
        options.choices = normalizeChoices(vals.map((r) => r.v));
        await sql`update records set data = jsonb_set(data, ${[f.key]}::text[],
          to_jsonb(regexp_replace(regexp_replace(lower(data->>${f.key}), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g')))
          where object_type_id = ${obj.id} and data ? ${f.key} and jsonb_typeof(data->${f.key}) = 'string'`;
      }
      if (c.type === "currency") options.currency = "USD";
      await sql`update field_defs set type = ${c.type}, options = ${json(options)}::jsonb where id = ${f.id}`;
      break;
    }
    case "remove_choices": {
      const f = getField(obj, c.field);
      const choices = (f.options.choices ?? []).filter((x) => !c.values.includes(x.value));
      await sql`update field_defs set options = ${json({ ...f.options, choices })}::jsonb where id = ${f.id}`;
      break;
    }
  }
  invalidateSchema();
  await audit(sql, actor, `schema.${c.kind}`, obj.slug, obj.id, null, c);
}

function pick(o: any, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
