import { sql, type Db } from "../db.js";
import { audit, transaction } from "./audit.js";
import { UUID_RE } from "./fields.js";
import { writeReply } from "./records.js";
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
  deleted_at?: string | null;
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
async function resolveLinks(db: Db, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return [];
  const bad = unique.filter((id) => !UUID_RE.test(id));
  if (bad.length) throw new CrmError(`Not record ids: ${bad.join(", ")}`);
  const found = await db<{ id: string }[]>`select id from records where id = any(${unique}::uuid[]) and deleted_at is null`;
  const missing = unique.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) throw new CrmError(`Records not found: ${missing.join(", ")}`);
  return unique;
}

async function setLinks(db: Db, activityId: string, ids: string[]) {
  await db`delete from activity_links where activity_id = ${activityId}`;
  for (let i = 0; i < ids.length; i++) {
    await db`insert into activity_links (activity_id, record_id, position) values (${activityId}, ${ids[i]}, ${i})`;
  }
  await db`update activities set record_id = ${ids[0] ?? null} where id = ${activityId}`;
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
  const due = parseDue(input.due_at);
  const row = await transaction(async (tx) => {
    const ids = await resolveLinks(tx, [input.record_id, ...(input.record_ids ?? [])]);
    const [row] = await tx<Activity[]>`
      insert into activities (record_id, kind, title, body, due_at, actor_type, actor_name)
      values (${ids[0] ?? null}, ${input.kind}, ${input.title ?? ""}, ${input.body ?? ""},
              ${due}::timestamptz, ${actor.type}, ${actor.name})
      returning *`;
    await setLinks(tx, row.id, ids);
    await audit(tx, actor, "activity.create", null, row.id, null, {
      record_ids: ids, kind: row.kind, title: row.title, body: row.body, due_at: row.due_at,
    });
    return row;
  });
  return writeReply(actor, "created", row.id, { ...row, links: (await linksFor([row.id]))[row.id] ?? [] });
}

/** Activity fields as stored in audit entries: plain JSON, timestamps as ISO strings. */
type ActivitySnapshot = { title?: string; body?: string; due_at?: string | null; done_at?: string | null; record_ids?: string[] };

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

async function snapshot(db: Db, id: string): Promise<ActivitySnapshot & { kind: string }> {
  const [a] = await db<Activity[]>`select * from activities where id = ${id}`;
  const links = await db<{ record_id: string }[]>`select record_id from activity_links where activity_id = ${id} order by position`;
  return { kind: a.kind, title: a.title, body: a.body, due_at: iso(a.due_at), done_at: iso(a.done_at), record_ids: links.map((l) => l.record_id) };
}

/** Write snapshot values as-is (no validation): used by updates after checks, and by undo. */
async function writeSnapshot(db: Db, id: string, v: ActivitySnapshot) {
  if (v.title !== undefined) await db`update activities set title = ${v.title} where id = ${id}`;
  if (v.body !== undefined) await db`update activities set body = ${v.body} where id = ${id}`;
  if (v.due_at !== undefined) await db`update activities set due_at = ${v.due_at}::timestamptz where id = ${id}`;
  if (v.done_at !== undefined) await db`update activities set done_at = ${v.done_at}::timestamptz where id = ${id}`;
  if (v.record_ids) await setLinks(db, id, v.record_ids);
}

export async function updateActivity(
  actor: Actor,
  id: string,
  patch: { done?: boolean; title?: string; body?: string; due_at?: string | null; record_ids?: string[] },
  opts: { taskOnly?: boolean } = {},
) {
  requireScope(actor, "write");
  if (!UUID_RE.test(id)) throw new CrmError(`"${id}" is not an activity id`);
  await transaction(async (tx) => {
    const [cur] = await tx<Activity[]>`select * from activities where id = ${id} and deleted_at is null for update`;
    if (!cur) throw notFound(opts.taskOnly ? "Task" : "Activity");
    if (opts.taskOnly && cur.kind !== "task") throw new CrmError(`${id} is a ${cur.kind}, not a task`);
    if (patch.title !== undefined && cur.kind === "task" && !patch.title.trim()) throw new CrmError("Tasks need a title");
    const prev = await snapshot(tx, id);
    const want: ActivitySnapshot = {
      title: patch.title,
      body: patch.body,
      due_at: patch.due_at === undefined ? undefined : iso(parseDue(patch.due_at)),
      done_at: patch.done === undefined ? undefined : patch.done ? (prev.done_at ?? new Date().toISOString()) : null,
      record_ids: patch.record_ids ? await resolveLinks(tx, patch.record_ids) : undefined,
    };
    // Audit every field that actually changes, with its old and new value.
    const keys = (Object.keys(want) as (keyof ActivitySnapshot)[]).filter(
      (k) => want[k] !== undefined && JSON.stringify(want[k]) !== JSON.stringify(prev[k]),
    );
    if (!keys.length) return;
    const changed = Object.fromEntries(keys.map((k) => [k, want[k]])) as ActivitySnapshot;
    await writeSnapshot(tx, id, changed);
    await audit(tx, actor, "activity.update", null, id, { kind: cur.kind, ...Object.fromEntries(keys.map((k) => [k, prev[k]])) }, { kind: cur.kind, ...changed });
  });
  // Without the read scope, only the id and what happened (see writeReply).
  if (!actor.scopes.includes("read")) return { id, action: "updated" as const };
  const [row] = await sql<Activity[]>`select * from activities where id = ${id}`;
  return { ...row, links: (await linksFor([id]))[id] ?? [] };
}

/** Soft delete: the activity disappears everywhere but can be brought back from the audit log. */
export async function deleteActivity(actor: Actor, id: string) {
  requireScope(actor, "write");
  if (!UUID_RE.test(id)) throw new CrmError(`"${id}" is not an activity id`);
  await transaction(async (tx) => {
    const [row] = await tx<Activity[]>`update activities set deleted_at = now() where id = ${id} and deleted_at is null returning id`;
    if (!row) throw notFound("Activity");
    await audit(tx, actor, "activity.delete", null, id, await snapshot(tx, id), null);
  });
  return { deleted: true };
}

/**
 * Undo helpers. They refuse when the activity changed again since the entry being undone,
 * unless force is set.
 */
export async function revertActivityUpdate(actor: Actor, id: string, before: ActivitySnapshot, after: ActivitySnapshot, force: boolean) {
  await transaction(async (tx) => {
    const [cur] = await tx`select id from activities where id = ${id} and deleted_at is null for update`;
    if (!cur) throw notFound("Activity");
    const now = await snapshot(tx, id);
    const keys = (Object.keys(after) as (keyof ActivitySnapshot)[]).filter((k) => k !== ("kind" as string));
    const drifted = keys.filter((k) => JSON.stringify(now[k]) !== JSON.stringify(after[k]));
    if (drifted.length && !force) {
      throw new CrmError(`These fields changed again since this edit: ${drifted.join(", ")}. Undo anyway to overwrite them.`, 409, { conflict: drifted });
    }
    // Links to records that were archived since are dropped rather than failing the undo.
    const restore = Object.fromEntries(keys.map((k) => [k, before[k]])) as ActivitySnapshot;
    if (restore.record_ids) {
      const live = await tx<{ id: string }[]>`select id from records where id = any(${restore.record_ids}::uuid[]) and deleted_at is null`;
      restore.record_ids = restore.record_ids.filter((r) => live.some((l) => l.id === r));
    }
    await writeSnapshot(tx, id, restore);
    await audit(tx, actor, "activity.update", null, id, { kind: now.kind, ...Object.fromEntries(keys.map((k) => [k, now[k]])) }, { kind: now.kind, ...restore });
  });
}

export async function restoreActivity(actor: Actor, id: string) {
  await transaction(async (tx) => {
    const [row] = await tx`update activities set deleted_at = null where id = ${id} and deleted_at is not null returning id`;
    if (!row) throw notFound("Deleted activity");
    await audit(tx, actor, "activity.restore", null, id, null, await snapshot(tx, id));
  });
}

export async function listTasks(opts: { open?: boolean; limit?: number; record_id?: string } = {}) {
  if (opts.record_id && !UUID_RE.test(opts.record_id)) throw new CrmError(`"${opts.record_id}" is not a record id`);
  const rows = await sql<Activity[]>`select a.* from activities a
    where a.kind = 'task' and a.deleted_at is null ${opts.open !== false ? sql`and a.done_at is null` : sql``}
    ${opts.record_id ? sql`and exists (select 1 from activity_links l where l.activity_id = a.id and l.record_id = ${opts.record_id})` : sql``}
    order by a.done_at is not null, a.due_at nulls last, a.created_at desc limit ${opts.limit ?? 200}`;
  const links = await linksFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, links: links[r.id] ?? [] }));
}

/** Notes, tasks and field changes for one record, newest first. */
export async function timeline(recordId: string, limit = 100) {
  if (!UUID_RE.test(recordId)) throw new CrmError(`"${recordId}" is not a record id`);
  const rows = await sql`select 'activity' as type, a.* from activities a
    where a.deleted_at is null and exists (select 1 from activity_links l where l.activity_id = a.id and l.record_id = ${recordId})
    order by a.created_at desc limit ${limit}`;
  const links = await linksFor(rows.map((r) => r.id));
  const acts: any[] = rows.map((r) => ({ ...r, links: links[r.id] ?? [] }));
  const changes = await sql`select 'change' as type, id::text, action, actor_type, actor_name, before, after, created_at, undone_at
                            from audit_log where target_id = ${recordId} and action like 'record.%' order by id desc limit ${limit}`;
  return [...acts, ...changes]
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    .slice(0, limit);
}
