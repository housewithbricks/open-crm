import { json, sql } from "../db.js";
import { audit } from "./audit.js";
import { FILTER_HELP, FILTER_OPS, listRecords, META_FILTER_FIELDS, type Filter } from "./records.js";
import { getField, getObject } from "./schema.js";
import { CrmError, notFound, requireScope, type Actor } from "./types.js";

export type ViewConfig = {
  kind?: "table" | "board";
  q?: string;
  filters?: Filter[];
  sort?: string;
  dir?: "asc" | "desc";
  group_by?: string;
};

export type SavedView = { id: string; object: string; name: string; config: ViewConfig; position: number; created_by: string; created_at: string };

async function cleanConfig(slug: string, c: ViewConfig = {}): Promise<ViewConfig> {
  const obj = await getObject(slug);
  const out: ViewConfig = {};
  if (c.kind) {
    if (c.kind !== "table" && c.kind !== "board") throw new CrmError('kind must be "table" or "board"');
    out.kind = c.kind;
  }
  if (c.q) out.q = String(c.q);
  if (c.filters?.length) {
    out.filters = c.filters.map((f) => {
      if (!(META_FILTER_FIELDS as readonly string[]).includes(f.field)) getField(obj, f.field);
      if (!FILTER_OPS.includes(f.op)) throw new CrmError(`Unknown filter op "${f.op}". ${FILTER_HELP}`);
      return { field: f.field, op: f.op, ...(f.value !== undefined ? { value: f.value } : {}) };
    });
  }
  if (c.sort) {
    if (!["created_at", "updated_at", "display_name"].includes(c.sort)) getField(obj, c.sort);
    out.sort = c.sort;
    out.dir = c.dir === "asc" ? "asc" : "desc";
  }
  if (c.group_by) {
    const g = getField(obj, c.group_by);
    if (g.type !== "select") throw new CrmError("group_by must be a select field");
    out.group_by = c.group_by;
  }
  // Dry run so a bad value (e.g. an unknown option) fails now, not every time the view opens.
  await listRecords(slug, { q: out.q, filters: out.filters, sort: out.sort, dir: out.dir, limit: 1 });
  return out;
}

export async function listViews(slug: string) {
  const obj = await getObject(slug);
  return sql<SavedView[]>`select id, ${obj.slug}::text as object, name, config, position, created_by, created_at
    from views where object_type_id = ${obj.id} order by position, created_at`;
}

export async function createView(actor: Actor, slug: string, input: { name: string; config?: ViewConfig }) {
  requireScope(actor, "write");
  if (!input.name?.trim()) throw new CrmError("View needs a name");
  const obj = await getObject(slug);
  const config = await cleanConfig(slug, input.config);
  const [row] = await sql<SavedView[]>`insert into views (object_type_id, name, config, created_by)
    values (${obj.id}, ${input.name.trim()}, ${json(config)}::jsonb, ${actor.name})
    returning id, ${obj.slug}::text as object, name, config, position, created_by, created_at`;
  await audit(sql, actor, "view.create", obj.slug, row.id, null, { name: row.name, config });
  return row;
}

export async function updateView(actor: Actor, id: string, patch: { name?: string; config?: ViewConfig }) {
  requireScope(actor, "write");
  const [cur] = await sql`select v.*, o.slug from views v join object_types o on o.id = v.object_type_id where v.id = ${id}`;
  if (!cur) throw notFound("View");
  const config = patch.config ? await cleanConfig(cur.slug, patch.config) : cur.config;
  const [row] = await sql<SavedView[]>`update views set name = ${patch.name?.trim() || cur.name}, config = ${json(config)}::jsonb
    where id = ${id} returning id, ${cur.slug}::text as object, name, config, position, created_by, created_at`;
  await audit(sql, actor, "view.update", cur.slug, id, { name: cur.name, config: cur.config }, { name: row.name, config });
  return row;
}

export async function deleteView(actor: Actor, id: string) {
  requireScope(actor, "write");
  const [row] = await sql`delete from views where id = ${id} returning name`;
  if (!row) throw notFound("View");
  await audit(sql, actor, "view.delete", null, id, row, null);
  return { deleted: true };
}
