import { sql, type Db } from "../db.js";
import { transaction } from "./audit.js";
import { UUID_RE } from "./fields.js";
import { insertRecord, listRecords, upsertIn } from "./records.js";
import { applyFieldUpdate, getObject, invalidateSchema } from "./schema.js";
import { CrmError, requireScope, type Actor, type FieldDef, type ObjectType } from "./types.js";

const MAX_ROWS = 5000;

export type ImportOptions = {
  /** Field to dedupe on (e.g. email, domain). Without it every row is created. */
  match_on?: string;
  /** Relation values given as names are looked up by name; create the related record if missing. Default true. */
  create_missing_relations?: boolean;
  /** Add unknown select/multi-select values as new options (needs schema scope). Default true for the UI. */
  add_missing_options?: boolean;
};

export type ImportResult = {
  created: number;
  updated: number;
  failed: number;
  errors: { row: number; error: string }[];
  records: { row: number; id: string; action: "created" | "updated" }[];
};

const splitMulti = (v: unknown) => (Array.isArray(v) ? v : String(v).split(/[;,]/)).map((x) => String(x).trim()).filter(Boolean);

/** Relation names → ids, inside the row's transaction. New lookups go to `found`, merged into the cache after commit. */
async function resolveRelation(tx: Db, actor: Actor, field: FieldDef, raw: unknown, opts: ImportOptions, cache: Map<string, string>, found: Map<string, string>) {
  const target = await getObject(field.options.target!);
  const names = field.options.multiple ? splitMulti(raw) : [String(raw).trim()];
  const ids: string[] = [];
  for (const name of names) {
    if (UUID_RE.test(name)) {
      ids.push(name);
      continue;
    }
    const ck = `${target.slug}:${name.toLowerCase()}`;
    let id = found.get(ck) ?? cache.get(ck);
    if (!id) {
      const [hit] = await tx<{ id: string }[]>`select id from records where object_type_id = ${target.id}
        and deleted_at is null and lower(display_name) = lower(${name}) order by created_at limit 1`;
      if (hit) id = hit.id;
      else if (opts.create_missing_relations !== false) id = (await insertRecord(tx, actor, target, { [target.primary_field]: name })).id;
      else throw new CrmError(`${field.key}: no ${target.label} named "${name}"`);
      found.set(ck, id);
    }
    ids.push(id);
  }
  return field.options.multiple ? ids : (ids[0] ?? null);
}

/** Add unknown select values as options, in the row's transaction. Updates `field` (a copy) in place. */
async function ensureOptions(tx: Db, actor: Actor, obj: ObjectType, field: FieldDef, raw: unknown, opts: ImportOptions) {
  const values = field.type === "multi_select" ? splitMulti(raw) : [String(raw).trim()];
  const known = (field.options.choices ?? []).flatMap((c) => [c.value.toLowerCase(), c.label.toLowerCase()]);
  const missing = [...new Set(values.filter((v) => v && !known.includes(v.toLowerCase())))];
  if (missing.length && opts.add_missing_options && actor.scopes.includes("schema")) {
    field.options = await applyFieldUpdate(tx, actor, obj, field, { add_choices: missing });
  }
  return field.type === "multi_select" ? values : values[0];
}

/**
 * Create or upsert many records. Rows are keyed by field key; values may use names for relations.
 * Each row is one transaction: if it fails, the related records and options it added are rolled back too.
 */
export async function importRows(actor: Actor, slug: string, rows: Record<string, unknown>[], opts: ImportOptions = {}): Promise<ImportResult> {
  requireScope(actor, "write");
  if (!Array.isArray(rows)) throw new CrmError("rows must be an array");
  if (rows.length > MAX_ROWS) throw new CrmError(`Too many rows (${rows.length}); the limit is ${MAX_ROWS} per import`);
  const first = await getObject(slug);
  if (opts.match_on && !first.fields.some((f) => f.key === opts.match_on)) throw new CrmError(`match_on: no field "${opts.match_on}" on ${first.slug}`);
  const res: ImportResult = { created: 0, updated: 0, failed: 0, errors: [], records: [] };
  const cache = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const found = new Map<string, string>();
    let optionsAdded = false;
    try {
      // A copy, so options added by a row that then fails don't leak into the next one.
      const obj = structuredClone(await getObject(slug));
      const r = await transaction(async (tx) => {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rows[i] ?? {})) {
          if (v === undefined || v === null || (typeof v === "string" && !v.trim())) continue;
          const f = obj.fields.find((x) => x.key === k);
          if (!f) throw new CrmError(`Unknown field "${k}"`);
          if (f.type === "relation") data[k] = await resolveRelation(tx, actor, f, v, opts, cache, found);
          else if (f.type === "select" || f.type === "multi_select") {
            const before = f.options;
            data[k] = await ensureOptions(tx, actor, obj, f, v, opts);
            optionsAdded ||= f.options !== before;
          } else data[k] = v;
        }
        if (!Object.keys(data).length) return null;
        if (opts.match_on && data[opts.match_on] != null) return upsertIn(tx, actor, obj, opts.match_on, data);
        return { action: "created" as const, record: await insertRecord(tx, actor, obj, data) };
      });
      for (const [k, id] of found) cache.set(k, id);
      if (!r) continue;
      res[r.action]++;
      res.records.push({ row: i, id: r.record.id, action: r.action });
    } catch (e) {
      res.failed++;
      if (res.errors.length < 200) res.errors.push({ row: i, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (optionsAdded) invalidateSchema();
    }
  }
  return res;
}

/* ---------------------------------- export --------------------------------- */

/**
 * One CSV cell. Text starting with = + - @ tab or CR is prefixed with ' so spreadsheet apps
 * show it instead of running it as a formula. Numbers are left alone (-5 stays -5).
 */
const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportCsv(slug: string) {
  const obj = await getObject(slug);
  const header = ["id", ...obj.fields.map((f) => f.key), "created_at", "updated_at"];
  const lines = [header.map(csvCell).join(",")];
  for (let offset = 0; ; offset += 500) {
    const page = await listRecords(slug, { limit: 500, offset, sort: "created_at", dir: "asc" });
    for (const r of page.records) {
      const cells = obj.fields.map((f) => {
        const v = r.data[f.key];
        if (v == null) return "";
        if (f.type === "relation") return (Array.isArray(v) ? v : [v]).map((id) => page.refs[id]?.display_name ?? id).join("; ");
        if (f.type === "select") return f.options.choices?.find((c) => c.value === v)?.label ?? v;
        // Tolerate a scalar where a list is expected (data from before a type change).
        if (f.type === "multi_select") return (Array.isArray(v) ? v : [v]).map((x) => f.options.choices?.find((c) => c.value === x)?.label ?? x).join("; ");
        return v;
      });
      lines.push([r.id, ...cells, r.created_at, r.updated_at].map((c) => csvCell(c instanceof Date ? c.toISOString() : c)).join(","));
    }
    if (page.records.length < 500) break;
  }
  return lines.join("\r\n") + "\r\n";
}

