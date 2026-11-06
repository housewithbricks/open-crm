import { json, sql } from "../db.js";
import { audit } from "./audit.js";
import { coerceValue, validateData } from "./fields.js";
import { getField, getObject, loadSchema } from "./schema.js";
import { CrmError, notFound, requireScope, type Actor, type FieldDef, type ObjectType } from "./types.js";

export type CrmRecord = {
  id: string;
  object: string;
  display_name: string;
  data: Record<string, unknown>;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

export type Ref = { id: string; object: string; display_name: string };

export const FILTER_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "between", "in", "not_in", "is_empty", "not_empty"] as const;
export type Filter = { field: string; op: (typeof FILTER_OPS)[number]; value?: unknown };

/** Filterable record metadata, in addition to the object's own fields. */
export const META_FILTER_FIELDS = ["created_at", "updated_at"] as const;

export const FILTER_HELP = `Filters are ANDed. Each is {field, op, value}.
Ops: eq, neq, contains (text), gt, gte, lt, lte, between ([min, max], inclusive), in / not_in (list), is_empty, not_empty.
Select values accept option values or labels. Relation values are record ids.
Dates accept YYYY-MM-DD or relative "today", "today+7", "today-30" (days), which stay current in saved views.
You can also filter on created_at and updated_at.
Examples: {"field":"stage","op":"in","value":["Proposal","Negotiation"]} · {"field":"amount","op":"between","value":[10000,50000]} ·
{"field":"close_date","op":"between","value":["today","today+30"]} · {"field":"updated_at","op":"lt","value":"today-14"}`;

/** "today", "today+7", "today-30" → YYYY-MM-DD (UTC). Anything else passes through. */
export function resolveRelativeDate(v: unknown): unknown {
  const m = typeof v === "string" ? /^\s*today\s*(?:([+-])\s*(\d+)\s*d?)?\s*$/i.exec(v) : null;
  if (!m) return v;
  const d = new Date();
  const days = m[1] ? Number(m[2]) * (m[1] === "-" ? -1 : 1) : 0;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type ListParams = {
  q?: string;
  filters?: Filter[];
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

const META_SORT = new Set(["created_at", "updated_at", "display_name"]);
const isNumeric = (f: FieldDef) => f.type === "number" || f.type === "currency";

function filterSql(obj: ObjectType, flt: Filter) {
  const op = flt.op;
  if (!FILTER_OPS.includes(op)) throw new CrmError(`Unknown filter op "${op}". ${FILTER_HELP}`);

  // created_at / updated_at: compare the record's own timestamps by day.
  if ((META_FILTER_FIELDS as readonly string[]).includes(flt.field)) {
    const col = sql.unsafe(`(${flt.field} at time zone 'UTC')::date`);
    const day = (v: unknown) => {
      const d = String(resolveRelativeDate(v));
      if (Number.isNaN(Date.parse(d))) throw new CrmError(`${flt.field}: "${v}" is not a date (use YYYY-MM-DD or today±N)`);
      return d.slice(0, 10);
    };
    const cmp = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as Record<string, string>;
    if (op === "between") {
      const [a, b] = Array.isArray(flt.value) ? flt.value : [];
      return sql`${col} between ${day(a)}::date and ${day(b)}::date`;
    }
    if (cmp[op]) return sql`${col} ${sql.unsafe(cmp[op])} ${day(flt.value)}::date`;
    throw new CrmError(`${flt.field} supports eq, neq, gt, gte, lt, lte and between`);
  }

  const f = getField(obj, flt.field);
  const k = f.key;
  const many = f.type === "multi_select" || (f.type === "relation" && f.options.multiple);
  const isDate = f.type === "date";
  const val = (v: unknown) => coerceValue(f, isDate ? resolveRelativeDate(v) : v);
  const empty = sql`(data->${k} is null or data->>${k} = '' or data->${k} = '[]'::jsonb)`;
  // Dates may be stored as YYYY-MM-DD or full ISO timestamps; compare by day.
  const scalar = isNumeric(f) ? sql`(data->>${k})::numeric` : isDate ? sql`left(data->>${k}, 10)` : sql`data->>${k}`;
  const lit = (v: unknown) => (isNumeric(f) ? Number(v) : isDate ? String(v).slice(0, 10) : String(v));
  const list = () => (Array.isArray(flt.value) ? flt.value : [flt.value]).map((v) => String(val(v)));

  switch (op) {
    case "is_empty":
      return empty;
    case "not_empty":
      return sql`not ${empty}`;
    case "contains":
      return sql`data->>${k} ilike ${"%" + String(flt.value ?? "").replace(/[\\%_]/g, (c) => "\\" + c) + "%"}`;
    case "in":
    case "not_in": {
      const arr = list();
      const cond = many ? sql`coalesce(data->${k} ?| ${arr}::text[], false)` : sql`coalesce(data->>${k} = any(${arr}::text[]), false)`;
      return op === "in" ? cond : sql`not ${cond}`;
    }
    case "eq":
    case "neq": {
      let v = val(flt.value);
      if (Array.isArray(v)) v = v[0];
      const cond = many
        ? sql`coalesce(data->${k} ? ${String(v)}, false)`
        : f.type === "boolean"
          ? sql`coalesce((data->>${k})::boolean, false) = ${Boolean(v)}`
          : isNumeric(f) || isDate
            ? sql`coalesce(${scalar} = ${lit(v)}, false)`
            : sql`coalesce(lower(data->>${k}) = lower(${String(v)}), false)`;
      return op === "eq" ? cond : sql`not ${cond}`;
    }
    case "between": {
      if (!Array.isArray(flt.value) || flt.value.length !== 2) throw new CrmError(`${k}: between needs [min, max]`);
      const [a, b] = flt.value.map((v) => lit(val(v)));
      return sql`${scalar} between ${a} and ${b}`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
      return sql`${scalar} ${sql.unsafe(sym)} ${lit(val(flt.value))}`;
    }
  }
}

/** Match the record name, or (for 3+ chars) any field value. Never keys or JSON syntax. */
function textMatch(q: string, alias = "") {
  const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const name = sql.unsafe(alias ? `${alias}.display_name` : "display_name");
  const data = sql.unsafe(alias ? `${alias}.data` : "data");
  if (q.trim().length < 3) return sql`${name} ilike ${like}`;
  return sql`(${name} ilike ${like} or exists (
    select 1 from jsonb_each(${data}) e
    where (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' ilike ${like})
       or (jsonb_typeof(e.value) = 'array' and e.value::text ilike ${like})))`;
}

function orderSql(obj: ObjectType, sort = "updated_at", dir: "asc" | "desc" = "desc") {
  const d = sql.unsafe(dir === "asc" ? "asc" : "desc");
  if (META_SORT.has(sort)) return sql`${sql(sort)} ${d} nulls last, id`;
  const f = getField(obj, sort);
  return isNumeric(f)
    ? sql`(data->>${f.key})::numeric ${d} nulls last, id`
    : sql`data->>${f.key} ${d} nulls last, id`;
}

const toOut = (obj: ObjectType, r: any): CrmRecord => ({
  id: r.id,
  object: obj.slug,
  display_name: r.display_name,
  data: r.data,
  created_by: r.created_by,
  updated_by: r.updated_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export async function listRecords(slug: string, p: ListParams = {}) {
  const obj = await getObject(slug);
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 500);
  const conds = [
    sql`object_type_id = ${obj.id}`,
    sql`deleted_at is null`,
    p.q ? textMatch(p.q) : null,
    ...(p.filters ?? []).map((f) => filterSql(obj, f)),
  ];
  const where = sql`and`.join(conds);
  const rows = await sql`select *, count(*) over() as _total from records where ${where}
                         order by ${orderSql(obj, p.sort, p.dir)} limit ${limit} offset ${p.offset ?? 0}`;
  const records = rows.map((r) => toOut(obj, r));
  return { object: obj.slug, total: Number(rows[0]?._total ?? 0), records, refs: await resolveRefs(obj, records) };
}

/** Look up display names for every relation value in a set of records. */
export async function resolveRefs(obj: ObjectType, records: CrmRecord[]): Promise<Record<string, Ref>> {
  const relFields = obj.fields.filter((f) => f.type === "relation");
  const ids = new Set<string>();
  for (const r of records)
    for (const f of relFields) {
      const v = r.data[f.key];
      for (const id of Array.isArray(v) ? v : v ? [v] : []) ids.add(String(id));
    }
  if (!ids.size) return {};
  const rows = await sql<Ref[]>`select r.id, o.slug as object, r.display_name from records r
    join object_types o on o.id = r.object_type_id where r.id = any(${[...ids]}::uuid[]) and r.deleted_at is null`;
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

async function fetchRow(id: string) {
  const [row] = await sql`select r.*, o.slug from records r join object_types o on o.id = r.object_type_id
                          where r.id = ${id} and r.deleted_at is null`;
  if (!row) throw notFound(`Record ${id}`);
  const obj = await getObject(row.slug);
  return { obj, rec: toOut(obj, row) };
}

export async function getRecord(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CrmError(`"${id}" is not a record id`);
  const { obj, rec } = await fetchRow(id);
  return { record: rec, refs: await resolveRefs(obj, [rec]), related: await backlinks(obj, id) };
}

/** Records in other objects whose relation fields point at this record. */
async function backlinks(obj: ObjectType, id: string) {
  const out: { object: string; label: string; field: string; field_label: string; records: Ref[] }[] = [];
  for (const o of await loadSchema()) {
    for (const f of o.fields) {
      if (f.type !== "relation" || f.options.target !== obj.slug) continue;
      const rows = await sql<Ref[]>`select id, ${o.slug}::text as object, display_name from records
        where object_type_id = ${o.id} and deleted_at is null and
        ${f.options.multiple ? sql`data->${f.key} ? ${id}` : sql`data->>${f.key} = ${id}`}
        order by updated_at desc limit 50`;
      if (rows.length) out.push({ object: o.slug, label: o.label_plural, field: f.key, field_label: f.label, records: [...rows] });
    }
  }
  return out;
}

async function checkIntegrity(obj: ObjectType, data: Record<string, unknown>, selfId?: string) {
  for (const f of obj.fields) {
    const v = data[f.key];
    if (v === null || v === undefined) continue;
    if (f.is_unique) {
      const dup = await sql`select id, display_name from records where object_type_id = ${obj.id} and deleted_at is null
        and lower(data->>${f.key}) = lower(${String(v)}) ${selfId ? sql`and id <> ${selfId}` : sql``} limit 1`;
      if (dup.length) {
        throw new CrmError(`A ${obj.label} with ${f.key} "${v}" already exists (${dup[0].display_name}, id ${dup[0].id}). Use update or upsert.`, 409);
      }
    }
    if (f.type === "relation") {
      const ids = (Array.isArray(v) ? v : [v]).map(String);
      const target = await getObject(f.options.target!);
      const found = await sql`select id from records where id = any(${ids}::uuid[]) and object_type_id = ${target.id} and deleted_at is null`;
      if (found.length !== ids.length) throw new CrmError(`${f.key}: related ${target.label} record not found`);
    }
  }
}

const displayName = (obj: ObjectType, data: Record<string, unknown>) => String(data[obj.primary_field] ?? "");

const stripNulls = (d: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));

export async function createRecord(actor: Actor, slug: string, input: Record<string, unknown>) {
  requireScope(actor, "write");
  const obj = await getObject(slug);
  const data = stripNulls(validateData(obj, input ?? {}, "create"));
  await checkIntegrity(obj, data);
  const [row] = await sql`insert into records (object_type_id, data, display_name, created_by, updated_by)
    values (${obj.id}, ${json(data)}::jsonb, ${displayName(obj, data)}, ${actor.name}, ${actor.name}) returning *`;
  await audit(sql, actor, "record.create", obj.slug, row.id, null, data);
  return toOut(obj, row);
}

export async function updateRecord(actor: Actor, id: string, patch: Record<string, unknown>) {
  requireScope(actor, "write");
  const { obj, rec } = await fetchRow(id);
  const clean = validateData(obj, patch ?? {}, "update");
  const next = stripNulls({ ...rec.data, ...clean });
  await checkIntegrity(obj, clean, id);
  const changedKeys = Object.keys(clean).filter((k) => JSON.stringify(rec.data[k] ?? null) !== JSON.stringify(next[k] ?? null));
  if (!changedKeys.length) return rec;
  const [row] = await sql`update records set data = ${json(next)}::jsonb, display_name = ${displayName(obj, next)},
    updated_by = ${actor.name}, updated_at = now() where id = ${id} returning *`;
  const before = Object.fromEntries(changedKeys.map((k) => [k, rec.data[k] ?? null]));
  const after = Object.fromEntries(changedKeys.map((k) => [k, next[k] ?? null]));
  await audit(sql, actor, "record.update", obj.slug, id, before, after);
  return toOut(obj, row);
}

/** Find by a unique-ish field (e.g. email, domain), update if found, create otherwise. */
export async function upsertRecord(actor: Actor, slug: string, matchOn: string, input: Record<string, unknown>) {
  requireScope(actor, "write");
  const obj = await getObject(slug);
  const f = getField(obj, matchOn);
  const v = coerceValue(f, input[matchOn]);
  if (v === null) throw new CrmError(`upsert needs a value for ${matchOn}`);
  const [hit] = await sql`select id from records where object_type_id = ${obj.id} and deleted_at is null
    and lower(data->>${f.key}) = lower(${String(v)}) order by created_at limit 1`;
  if (hit) {
    const { [matchOn]: _, ...rest } = input; // keep the stored match value as-is
    return { action: "updated" as const, record: await updateRecord(actor, hit.id, rest) };
  }
  return { action: "created" as const, record: await createRecord(actor, slug, input) };
}

export async function archiveRecord(actor: Actor, id: string) {
  requireScope(actor, "write");
  const { obj, rec } = await fetchRow(id);
  await sql`update records set deleted_at = now(), updated_by = ${actor.name} where id = ${id}`;
  await audit(sql, actor, "record.archive", obj.slug, id, rec.data, null);
  return { archived: true, id };
}

export async function restoreRecord(actor: Actor, id: string) {
  requireScope(actor, "write");
  const [row] = await sql`update records set deleted_at = null, updated_by = ${actor.name}
    where id = ${id} and deleted_at is not null returning id`;
  if (!row) throw notFound("Archived record");
  await audit(sql, actor, "record.restore", null, id, null, null);
  return getRecord(id);
}

export async function searchAll(q: string, limit = 20) {
  if (!q.trim()) return [];
  return sql<(Ref & { label: string })[]>`
    select r.id, o.slug as object, o.label, r.display_name from records r
    join object_types o on o.id = r.object_type_id
    where r.deleted_at is null and o.archived_at is null and ${textMatch(q, "r")}
    order by (r.display_name ilike ${q.replace(/[\\%_]/g, (c) => "\\" + c) + "%"}) desc,
             (r.display_name ilike ${"%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%"}) desc,
             similarity(r.display_name, ${q}) desc, r.updated_at desc
    limit ${limit}`;
}

export async function counts() {
  const rows = await sql<{ slug: string; n: number }[]>`select o.slug, count(r.id)::int as n from object_types o
    left join records r on r.object_type_id = o.id and r.deleted_at is null
    where o.archived_at is null group by o.slug`;
  return Object.fromEntries(rows.map((r) => [r.slug, r.n]));
}
