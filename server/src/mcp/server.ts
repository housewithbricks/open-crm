import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listTasks, logActivity, timeline, updateActivity, ACTIVITY_KINDS } from "../core/activities.js";
import { requestOrApply } from "../core/changes.js";
import {
  archiveRecord,
  createRecord,
  FILTER_HELP,
  FILTER_OPS,
  getRecord,
  listRecords,
  searchAll,
  updateRecord,
  upsertRecord,
  writeReply,
} from "../core/records.js";
import { importRows } from "../core/importer.js";
import { dashboard } from "../core/dashboard.js";
import { createView, deleteView, listViews, updateView } from "../core/views.js";
import { addField, createObjectType, getObject, loadSchema, updateField, updateObjectType } from "../core/schema.js";
import { CrmError, FIELD_TYPES, type Actor, type ObjectType } from "../core/types.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Open CRM is the user's personal CRM. You are a first-class client next to the web UI.
- Call describe_schema first: objects and fields are user-defined and change over time.
- Prefer upsert_record (match on email for people, domain for companies) to avoid duplicates.
- Use log_activity to record calls, meetings and notes, and create_task for follow-ups.
- You may grow the CRM: add fields or new objects when the user's data needs them. Write clear labels and descriptions.
- Destructive schema changes (archive or retype a field, archive an object, remove options) go to the user for approval through request_schema_change.
- Every write is attributed to you and visible in the record timeline and audit log.`;

/** Compact schema description that agents can read. */
export function schemaForAgent(objects: ObjectType[]) {
  return objects.map((o) => ({
    object: o.slug,
    label: o.label,
    label_plural: o.label_plural,
    description: o.description || undefined,
    primary_field: o.primary_field,
    fields: o.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.description ? { description: f.description } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.is_unique ? { unique: true } : {}),
      ...(f.options.choices ? { options: f.options.choices.map((c) => c.value) } : {}),
      ...(f.options.target ? { target: f.options.target, multiple: !!f.options.multiple } : {}),
      ...(f.options.currency ? { currency: f.options.currency } : {}),
    })),
  }));
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      const msg = e instanceof CrmError ? e.message : `Internal error: ${(e as Error).message}`;
      if (!(e instanceof CrmError)) console.error("[mcp]", e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  };
}

const dataSchema = z.record(z.string(), z.unknown()).describe("Field values keyed by field key (see describe_schema)");
const idSchema = z.string().describe("Record id (uuid)");
const choiceList = z.array(z.string()).describe("Option labels for select / multi_select");
const colorSchema = z.string().describe("A hex color like #0ea5e9, or one of gray, blue, violet, green, amber, orange, red, teal, pink");

async function listViewsById(id: string) {
  const { sql } = await import("../db.js");
  const rows = await sql<{ config: Record<string, unknown> }[]>`select config from views where id = ${id}`;
  if (!rows.length) throw new CrmError(`No view with id ${id}`, 404);
  return rows;
}

export function buildMcpServer(actor: Actor) {
  const server = new McpServer({ name: "open-crm", version: VERSION }, { instructions: INSTRUCTIONS });
  const can = (s: Actor["scopes"][number]) => actor.scopes.includes(s);
  const ro = { readOnlyHint: true, openWorldHint: false };

  /* ----------------------------- read ----------------------------- */
  if (can("read")) {
    server.registerTool(
      "describe_schema",
      { title: "Describe CRM schema", description: "List every object (People, Companies, Deals, custom ones) with its fields, types and select options.", inputSchema: {}, annotations: ro },
      wrap(async () => schemaForAgent(await loadSchema())),
    );

    server.registerTool(
      "search",
      { title: "Search everything", description: "Full-text search across all records of all objects. Returns ids and names.", inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() }, annotations: ro },
      wrap(async ({ query, limit }) => searchAll(query, limit)),
    );

    server.registerTool(
      "list_records",
      {
        title: "List / filter records",
        description: `List records of one object with an optional text query, filters and sort. Relation values in results are ids; names are in "refs".\n${FILTER_HELP}`,
        inputSchema: {
          object: z.string().describe("Object slug, e.g. people, companies, deals"),
          view: z.string().optional().describe("Saved view id; its filters and sort apply first (see list_views)"),
          query: z.string().optional(),
          filters: z.array(z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: z.unknown().optional() })).optional(),
          sort: z.string().optional().describe("Field key or created_at/updated_at"),
          dir: z.enum(["asc", "desc"]).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).optional(),
        },
        annotations: ro,
      },
      wrap(async (a) => {
        const v = a.view ? (await listViews(a.object)).find((x) => x.id === a.view || x.name.toLowerCase() === a.view!.toLowerCase()) : undefined;
        if (a.view && !v) throw new CrmError(`No view "${a.view}" on ${a.object}`);
        const c = v?.config ?? {};
        return listRecords(a.object, {
          q: a.query ?? c.q,
          filters: [...(c.filters ?? []), ...((a.filters as any) ?? [])],
          sort: a.sort ?? c.sort,
          dir: a.dir ?? c.dir,
          limit: a.limit ?? 25,
          offset: a.offset,
        });
      }),
    );

    server.registerTool(
      "get_record",
      { title: "Get record", description: "Get a record with its related records (e.g. a company's people and deals) and recent timeline (notes, tasks, changes).", inputSchema: { id: idSchema }, annotations: ro },
      wrap(async ({ id }) => ({ ...(await getRecord(id)), timeline: await timeline(id, 25) })),
    );

    server.registerTool(
      "list_views",
      { title: "List saved views", description: "Saved views (named filters and sorts) for an object.", inputSchema: { object: z.string() }, annotations: ro },
      wrap(async ({ object }) => listViews(object)),
    );

    server.registerTool(
      "get_overview",
      {
        title: "CRM overview",
        description: "High-level numbers: open pipeline by stage, won this month, 90-day win rate, deals closing soon, stale deals (no activity in 14 days), task load, new records per object and agent activity. Use it for check-ins and pipeline reviews.",
        inputSchema: {},
        annotations: ro,
      },
      wrap(async () => {
        const d = await dashboard();
        return { ...d, activity: undefined, activity_last_30_days: { by_you: d.activity.reduce((s, x) => s + x.user, 0), by_agents: d.activity.reduce((s, x) => s + x.agent, 0) } };
      }),
    );

    server.registerTool(
      "list_tasks",
      { title: "List tasks", description: "List tasks, open ones by default, sorted by due date. Each task lists the records it's linked to. Pass record_id to see only tasks about that record.", inputSchema: { include_done: z.boolean().optional(), record_id: idSchema.optional() }, annotations: ro },
      wrap(async ({ include_done, record_id }) => listTasks({ open: !include_done, limit: 100, record_id })),
    );

    server.registerResource(
      "schema",
      "crm://schema",
      { title: "CRM schema", description: "All objects and fields", mimeType: "application/json" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(schemaForAgent(await loadSchema()), null, 2) }] }),
    );

    server.registerResource(
      "record",
      new ResourceTemplate("crm://records/{id}", { list: undefined }),
      { title: "CRM record", mimeType: "application/json" },
      async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await getRecord(String(id)), null, 2) }] }),
    );

    server.registerPrompt(
      "pipeline_review",
      { title: "Pipeline review", description: "Review open deals, flag stale ones and suggest next steps." },
      () => ({
        messages: [{ role: "user", content: { type: "text", text: "Review my pipeline in Open CRM. List open deals by stage (not Won/Lost) with amounts and close dates, flag deals with no activity in 14 days or past their close date, and propose a concrete next step for each. Ask before creating tasks." } }],
      }),
    );

    server.registerPrompt(
      "meeting_prep",
      { title: "Meeting prep", description: "Brief me on a person or company before a meeting.", argsSchema: { who: z.string().describe("Name, email or company") } },
      ({ who }) => ({
        messages: [{ role: "user", content: { type: "text", text: `Prep me for a meeting with "${who}". Find them in Open CRM, then summarize who they are, related company/deals, the last interactions and open tasks, and suggest 3 talking points.` } }],
      }),
    );
  }

  /* ----------------------------- write ---------------------------- */
  if (can("write")) {
    server.registerTool(
      "create_record",
      { title: "Create record", description: "Create a record. Prefer upsert_record when a unique field (email, domain) is known.", inputSchema: { object: z.string(), data: dataSchema } },
      wrap(async ({ object, data }) => {
        const rec = await createRecord(actor, object, data);
        return writeReply(actor, "created", rec.id, rec);
      }),
    );

    server.registerTool(
      "update_record",
      { title: "Update record", description: "Update some fields of a record. Set a field to null to clear it.", inputSchema: { id: idSchema, data: dataSchema }, annotations: { idempotentHint: true } },
      wrap(async ({ id, data }) => {
        const rec = await updateRecord(actor, id, data);
        return writeReply(actor, "updated", rec.id, rec);
      }),
    );

    server.registerTool(
      "upsert_record",
      { title: "Upsert record", description: "Find a record by match_on (e.g. email, domain, name), case-insensitively. Update it if found, otherwise create it. Returns {action, record}, or {id, action} for a key without the read scope.", inputSchema: { object: z.string(), match_on: z.string(), data: dataSchema }, annotations: { idempotentHint: true } },
      wrap(async ({ object, match_on, data }) => {
        const r = await upsertRecord(actor, object, match_on, data);
        return writeReply(actor, r.action, r.record.id, r);
      }),
    );

    server.registerTool(
      "bulk_upsert_records",
      {
        title: "Bulk upsert records",
        description: "Create or update up to 500 records in one call. Relation fields accept names (e.g. a company name) as well as ids; missing related records are created. With match_on, existing records are updated instead of duplicated. Returns counts and per-row errors.",
        inputSchema: {
          object: z.string(),
          match_on: z.string().optional().describe("Field to dedupe on, e.g. email or domain"),
          records: z.array(dataSchema).max(500),
          add_missing_options: z.boolean().optional().describe("Add unknown select values as options (needs schema scope)"),
        },
        annotations: { idempotentHint: true },
      },
      wrap(async ({ object, match_on, records, add_missing_options }) => {
        const r = await importRows(actor, object, records, { match_on, add_missing_options });
        return { created: r.created, updated: r.updated, failed: r.failed, errors: r.errors, ids: r.records.map((x) => x.id) };
      }),
    );

    server.registerTool(
      "save_view",
      {
        title: "Save view",
        description: `Save a named view (filters, sort, table or board) on an object. It appears as a tab on that object in the UI, so the user can open it in one click. Use relative dates (today, today+30) so it stays current.\n${FILTER_HELP}`,
        inputSchema: {
          object: z.string(),
          name: z.string(),
          kind: z.enum(["table", "board"]).optional(),
          query: z.string().optional(),
          filters: z.array(z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: z.unknown().optional() })).optional(),
          sort: z.string().optional(),
          dir: z.enum(["asc", "desc"]).optional(),
          group_by: z.string().optional().describe("board only: select field to group by"),
        },
      },
      wrap(async ({ object, name, query, ...cfg }) => createView(actor, object, { name, config: { ...cfg, q: query } as any })),
    );

    server.registerTool(
      "update_view",
      {
        title: "Update view",
        description: "Rename a saved view or replace its filters, sort, table/board kind or grouping. Pass only what changes; filters replace the whole list.",
        inputSchema: {
          view_id: z.string(),
          name: z.string().optional(),
          kind: z.enum(["table", "board"]).optional(),
          query: z.string().optional(),
          filters: z.array(z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: z.unknown().optional() })).optional(),
          sort: z.string().optional(),
          dir: z.enum(["asc", "desc"]).optional(),
          group_by: z.string().optional(),
        },
        annotations: { idempotentHint: true },
      },
      wrap(async ({ view_id, name, query, ...cfg }) => {
        const [cur] = (await listViewsById(view_id));
        const config = { ...cur.config, ...Object.fromEntries(Object.entries({ ...cfg, q: query }).filter(([, v]) => v !== undefined)) };
        return updateView(actor, view_id, { name, config: config as any });
      }),
    );

    server.registerTool(
      "delete_view",
      { title: "Delete view", description: "Delete a saved view. Records are not affected.", inputSchema: { view_id: z.string() }, annotations: { destructiveHint: true } },
      wrap(async ({ view_id }) => deleteView(actor, view_id)),
    );

    server.registerTool(
      "archive_record",
      { title: "Archive record", description: "Soft-delete a record. The user can restore it from the UI.", inputSchema: { id: idSchema }, annotations: { destructiveHint: true } },
      wrap(async ({ id }) => archiveRecord(actor, id)),
    );

    server.registerTool(
      "log_activity",
      {
        title: "Log activity",
        description: "Add a note, call, email or meeting summary. It shows on the timeline of every linked record, e.g. a meeting linked to a person, their company and a deal.",
        inputSchema: {
          record_ids: z.array(idSchema).min(1).describe("Records this is about, from any objects"),
          kind: z.enum(ACTIVITY_KINDS.filter((k) => k !== "task") as ["note", "call", "email", "meeting"]),
          title: z.string().optional(),
          body: z.string(),
        },
      },
      wrap(async (a) => logActivity(actor, a)),
    );

    server.registerTool(
      "create_task",
      {
        title: "Create task",
        description: "Create a follow-up task. Link it to any number of records from any objects (people, companies, deals, custom objects). Due date as YYYY-MM-DD or ISO.",
        inputSchema: { title: z.string(), record_ids: z.array(idSchema).optional().describe("Records this task is about"), due_at: z.string().optional(), body: z.string().optional() },
      },
      wrap(async (a) => logActivity(actor, { ...a, kind: "task" })),
    );

    server.registerTool(
      "complete_task",
      { title: "Complete task", description: "Mark a task done, or reopen it with done=false.", inputSchema: { task_id: z.string(), done: z.boolean().optional() }, annotations: { idempotentHint: true } },
      wrap(async ({ task_id, done }) => updateActivity(actor, task_id, { done: done ?? true }, { taskOnly: true })),
    );

    server.registerTool(
      "update_task",
      {
        title: "Update task",
        description: "Change a task's title, notes or due date, or replace the records it's linked to (pass the full list). Set due_at to null to clear it.",
        inputSchema: {
          task_id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          due_at: z.string().nullable().optional(),
          record_ids: z.array(idSchema).optional().describe("The complete new list of linked records"),
        },
        annotations: { idempotentHint: true },
      },
      wrap(async ({ task_id, ...patch }) => updateActivity(actor, task_id, patch, { taskOnly: true })),
    );
  }

  /* ----------------------------- schema --------------------------- */
  if (can("schema")) {
    const fieldInput = {
      label: z.string(),
      key: z.string().optional().describe("snake_case key; derived from label if omitted"),
      type: z.enum(FIELD_TYPES),
      description: z.string().optional().describe("What this field means. Helps humans and agents."),
      required: z.boolean().optional(),
      unique: z.boolean().optional(),
      choices: choiceList.optional(),
      target: z.string().optional().describe("relation only: target object slug"),
      multiple: z.boolean().optional().describe("relation only: allow many"),
      currency: z.string().optional(),
    };

    server.registerTool(
      "create_object_type",
      { title: "Create object", description: "Add a new kind of record to the CRM (e.g. Investors, Properties, Projects). A required 'name' field is added automatically unless provided.", inputSchema: { label: z.string().describe("Singular, e.g. Investor"), label_plural: z.string().optional(), slug: z.string().optional(), description: z.string().optional(), icon: z.string().optional(), color: colorSchema.optional(), fields: z.array(z.object(fieldInput)).optional() } },
      wrap(async (a) => schemaForAgent([await createObjectType(actor, a)])[0]),
    );

    server.registerTool(
      "update_object_type",
      { title: "Update object", description: "Rename an object, change its description, icon or color, or change its primary (display) field.", inputSchema: { object: z.string(), label: z.string().optional(), label_plural: z.string().optional(), description: z.string().optional(), icon: z.string().optional(), color: colorSchema.optional(), primary_field: z.string().optional() } },
      wrap(async ({ object, ...patch }) => schemaForAgent([await updateObjectType(actor, object, patch)])[0]),
    );

    server.registerTool(
      "add_field",
      { title: "Add field", description: "Add a field to an object. It appears immediately in the UI.", inputSchema: { object: z.string(), ...fieldInput } },
      wrap(async ({ object, ...f }) => addField(actor, object, f)),
    );

    server.registerTool(
      "update_field",
      {
        title: "Update field",
        description: "Rename a field, change its description or required flag, add select options, or rework a select field's options. Pass `options` (the full list, in order) to reorder, rename, recolor, or set pipeline stages: kind open/won/lost and win probability 0-100 (used for the weighted forecast). Every existing option must stay in the list; to remove options or change type, use request_schema_change.",
        inputSchema: {
          object: z.string(),
          field: z.string(),
          label: z.string().optional(),
          description: z.string().optional(),
          required: z.boolean().optional(),
          add_choices: choiceList.optional(),
          options: z.array(z.object({
            value: z.string().optional().describe("Existing option value; omit for a new option"),
            label: z.string(),
            color: colorSchema.optional(),
            kind: z.enum(["open", "won", "lost"]).optional(),
            probability: z.number().min(0).max(100).optional(),
          })).optional(),
        },
      },
      wrap(async ({ object, field, options, ...patch }) => {
        if (!options) return updateField(actor, object, field, patch);
        const existing = options.filter((o) => o.value) as { value: string; label: string }[];
        const added = options.filter((o) => !o.value);
        const updated = await updateField(actor, object, field, { ...patch, choices: existing, add_choices: added });
        // Keep the requested order even when new options were appended.
        const order = options.map((o) => o.value ?? updated.options.choices?.find((c) => c.label === o.label)?.value);
        const sorted = [...(updated.options.choices ?? [])].sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
        return added.length ? updateField(actor, object, field, { choices: sorted }) : updated;
      }),
    );

    server.registerTool(
      "request_schema_change",
      {
        title: "Request destructive schema change",
        description: "Propose a destructive change (archive_field, archive_object, change_field_type, remove_choices). It is queued for the user to approve in the UI.",
        inputSchema: {
          kind: z.enum(["archive_field", "archive_object", "change_field_type", "remove_choices"]),
          object: z.string(),
          field: z.string().optional(),
          type: z.enum(FIELD_TYPES).optional().describe("change_field_type only"),
          values: z.array(z.string()).optional().describe("remove_choices only"),
          reason: z.string().describe("Why. Shown to the user."),
        },
        annotations: { destructiveHint: true },
      },
      wrap(async ({ reason, ...c }) => {
        await getObject(c.object);
        if (c.kind !== "archive_object" && !c.field) throw new CrmError("field is required");
        if (c.kind === "change_field_type" && !c.type) throw new CrmError("type is required");
        if (c.kind === "remove_choices" && !c.values?.length) throw new CrmError("values is required");
        return requestOrApply(actor, c as any, reason);
      }),
    );
  }

  return server;
}
