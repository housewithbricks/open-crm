import { sql } from "../db.js";
import { audit } from "./audit.js";
import { CrmError, notFound, requireScope, type Actor } from "./types.js";

export const ACTIVITY_KINDS = ["note", "call", "email", "meeting", "task"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type Activity = {
  id: string;
  record_id: string | null;
  kind: ActivityKind;
  title: string;
  body: string;
  due_at: string | null;
  done_at: string | null;
  actor_type: string;
  actor_name: string;
  created_at: string;
};

/** Date-only input ("2026-11-09") is stored at noon UTC so it shows the same day in every timezone. */
function parseDue(v: string | null | undefined) {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new CrmError("due_at is not a valid date (use YYYY-MM-DD)");
  return d;
}

export type ActivityLink = { id: string; object: string; display_name: string };

/** Distinct, validated record ids. The first one is stored as the primary record_id. */
async function resolveLinks(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return [];
  const bad = unique.filter((id) => !/^[0-9a-f-]{36}$/i.test(id));
  if (bad.length) throw new CrmError(`Not record ids: ${bad.join(", ")}`);
  const found = await sql<{ id: string }[]>`select id from records where id = any(${unique}::uuid[]) and deleted_at is null`;
  const missing = unique.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw new CrmError(`Records not found: ${missing.join(", ")}`);
  return unique;
}

async function setLinks(activityId: string, ids: string[]) {
  await sql`delete from activity_links where activity_id = ${activityId}`;
  for (let i = 0; i < ids.length; i++) {
    await sql`insert into activity_links (activity_id, record_id, position) values (${activityId}, ${ids[i]}, ${i})`;
  }
  await sql`update activities set record_id = ${ids[0] ?? null} where id = ${activityId}`;
}

/** Linked records for a set of activities, keyed by activity id. */
export async function linksFor(activityIds: string[]) {
  const out: Record<string, ActivityLink[]> = {};
  if (!activityIds.length) return out;
  const rows = await sql<(ActivityLink & { activity_id: string })[]>`
    select l.activity_id, r.id, o.slug as object, r.display_name
    from activity_links l join records r on r.id = l.record_id join object_types o on o.id = r.object_type_id
    where l.activity_id = any(${activityIds}::uuid[]) and r.deleted_at is null
    order by l.position`;
  for (const { activity_id, ...link } of rows) (out[activity_id] ??= []).push(link);
  return out;
}

export async function logActivity(
  actor: Actor,
  input: { record_id?: string | null; record_ids?: string[]; kind: ActivityKind; title?: string; body?: string; due_at?: string | null },
) {
  requireScope(actor, "write");
  if (!ACTIVITY_KINDS.includes(input.kind)) throw new CrmError(`kind must be one of ${ACTIVITY_KINDS.join(", ")}`);
  if (input.kind === "task" && !input.title) throw new CrmError("Tasks need a title");
  if (!input.title && !input.body) throw new CrmError("Provide a title or body");
  const ids = await resolveLinks([input.record_id, ...(input.record_ids ?? [])]);
  const due = parseDue(input.due_at);
  const [row] = await sql<Activity[]>`
    insert into activities (record_id, kind, title, body, due_at, actor_type, actor_name)
    values (${ids[0] ?? null}, ${input.kind}, ${input.title ?? ""}, ${input.body ?? ""},
            ${due}::timestamptz, ${actor.type}, ${actor.name})
    returning *`;
  await setLinks(row.id, ids);
  await audit(sql, actor, "activity.create", null, row.id, null, {
    record_ids: ids, kind: row.kind, title: row.title, body: row.body, due_at: row.due_at,
  });
  return { ...row, links: (await linksFor([row.id]))[row.id] ?? [] };
}

export async function updateActivity(
  actor: Actor,
  id: string,
  patch: { done?: boolean; title?: string; body?: string; due_at?: string | null; record_ids?: string[] },
) {
  requireScope(actor, "write");
  const [cur] = await sql<Activity[]>`select * from activities where id = ${id}`;
  if (!cur) throw notFound("Activity");
  const done_at = patch.done === undefined ? cur.done_at : patch.done ? (cur.done_at ?? new Date()) : null;
  const due_at = patch.due_at === undefined ? cur.due_at : parseDue(patch.due_at);
  if (patch.title !== undefined && cur.kind === "task" && !patch.title.trim()) throw new CrmError("Tasks need a title");
  const [row] = await sql<Activity[]>`update activities set
      title = ${patch.title ?? cur.title}, body = ${patch.body ?? cur.body},
      due_at = ${due_at}::timestamptz, done_at = ${done_at}::timestamptz
    where id = ${id} returning *`;
  if (patch.record_ids) {
    const before = (await linksFor([id]))[id]?.map((l) => l.id) ?? [];
    const ids = await resolveLinks(patch.record_ids);
    await setLinks(id, ids);
    await audit(sql, actor, "activity.update", null, id, { record_ids: before }, { record_ids: ids });
  }
  return { ...row, record_id: patch.record_ids ? (patch.record_ids[0] ?? null) : row.record_id, links: (await linksFor([id]))[id] ?? [] };
}

export async function deleteActivity(actor: Actor, id: string) {
  requireScope(actor, "write");
  const [row] = await sql<Activity[]>`delete from activities where id = ${id} returning *`;
  if (!row) throw notFound("Activity");
  await audit(sql, actor, "activity.delete", null, row.record_id, row, null);
  return { deleted: true };
}

export async function listTasks(opts: { open?: boolean; limit?: number; record_id?: string } = {}) {
  const rows = await sql<Activity[]>`select a.* from activities a
    where a.kind = 'task' ${opts.open !== false ? sql`and a.done_at is null` : sql``}
    ${opts.record_id ? sql`and exists (select 1 from activity_links l where l.activity_id = a.id and l.record_id = ${opts.record_id})` : sql``}
    order by a.done_at is not null, a.due_at nulls last, a.created_at desc limit ${opts.limit ?? 200}`;
  const links = await linksFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, links: links[r.id] ?? [] }));
}

/** Notes, tasks and field changes for one record, newest first. */
export async function timeline(recordId: string, limit = 100) {
  const rows = await sql`select 'activity' as type, a.* from activities a
    where exists (select 1 from activity_links l where l.activity_id = a.id and l.record_id = ${recordId})
    order by a.created_at desc limit ${limit}`;
  const links = await linksFor(rows.map((r) => r.id));
  const acts: any[] = rows.map((r) => ({ ...r, links: links[r.id] ?? [] }));
  const changes = await sql`select 'change' as type, id::text, action, actor_type, actor_name, before, after, created_at, undone_at
                            from audit_log where target_id = ${recordId} and action like 'record.%' order by id desc limit ${limit}`;
  return [...acts, ...changes]
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    .slice(0, limit);
}
