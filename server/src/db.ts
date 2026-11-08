import postgres from "postgres";
import { config } from "./config.js";

function sslOption() {
  const mode = config.databaseSsl?.toLowerCase();
  if (!mode) return undefined; // postgres.js honours ?sslmode= in DATABASE_URL by itself
  if (mode === "disable" || mode === "false") return false;
  if (mode === "require" || mode === "true") return "require" as const;
  if (mode === "prefer" || mode === "verify-full") return mode as "prefer" | "verify-full";
  throw new Error(`DATABASE_SSL must be one of require, prefer, verify-full, disable (got "${config.databaseSsl}")`);
}

const options = { max: Number(process.env.DATABASE_POOL_SIZE ?? 10), onnotice: () => {}, ssl: sslOption() };
// With no URL, postgres.js reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE itself.
export const sql = config.databaseUrl ? postgres(config.databaseUrl, options) : postgres(options);

export type Sql = typeof sql;
/** The pool or an open transaction: core helpers that take one can run inside either. */
export type Db = Sql | postgres.TransactionSql;

/** Pass a value to a `${json(x)}::jsonb` parameter. postgres.js v4 serializes it itself, so don't stringify. */
export const json = (v: unknown) => (v ?? null) as any;

/**
 * Versioned, append-only migrations. Never edit a shipped entry:
 * add a new one to the end of the list.
 */
const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "core",
    sql: /* sql */ `
      create extension if not exists pg_trgm;

      create table settings (
        key text primary key,
        value jsonb not null
      );

      create table object_types (
        id uuid primary key default gen_random_uuid(),
        slug text not null unique,
        label text not null,
        label_plural text not null,
        description text not null default '',
        icon text not null default '',
        color text not null default '',
        primary_field text not null default 'name',
        is_system boolean not null default false,
        position int not null default 0,
        created_by text not null default 'system',
        created_at timestamptz not null default now(),
        archived_at timestamptz
      );

      create table field_defs (
        id uuid primary key default gen_random_uuid(),
        object_type_id uuid not null references object_types(id) on delete cascade,
        key text not null,
        label text not null,
        description text not null default '',
        type text not null,
        options jsonb not null default '{}',
        required boolean not null default false,
        is_unique boolean not null default false,
        position int not null default 0,
        is_system boolean not null default false,
        created_by text not null default 'system',
        created_at timestamptz not null default now(),
        archived_at timestamptz,
        unique (object_type_id, key)
      );

      create table records (
        id uuid primary key default gen_random_uuid(),
        object_type_id uuid not null references object_types(id) on delete cascade,
        data jsonb not null default '{}',
        display_name text not null default '',
        created_by text not null,
        updated_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz
      );
      create index records_type_idx on records (object_type_id, updated_at desc) where deleted_at is null;
      create index records_data_idx on records using gin (data jsonb_path_ops);
      create index records_name_trgm on records using gin (display_name gin_trgm_ops);

      create table activities (
        id uuid primary key default gen_random_uuid(),
        record_id uuid references records(id) on delete cascade,
        kind text not null,
        title text not null default '',
        body text not null default '',
        due_at timestamptz,
        done_at timestamptz,
        actor_type text not null,
        actor_name text not null,
        created_at timestamptz not null default now()
      );
      create index activities_record_idx on activities (record_id, created_at desc);
      create index activities_open_tasks_idx on activities (due_at) where kind = 'task' and done_at is null;

      create table audit_log (
        id bigserial primary key,
        actor_type text not null,
        actor_name text not null,
        action text not null,
        object_slug text,
        target_id text,
        before jsonb,
        after jsonb,
        created_at timestamptz not null default now()
      );
      create index audit_target_idx on audit_log (target_id, created_at desc);

      create table change_requests (
        id uuid primary key default gen_random_uuid(),
        actor_type text not null,
        actor_name text not null,
        kind text not null,
        summary text not null,
        reason text not null default '',
        payload jsonb not null,
        status text not null default 'pending',
        decided_at timestamptz,
        created_at timestamptz not null default now()
      );

      create table api_keys (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        prefix text not null,
        key_hash text not null unique,
        scopes text[] not null,
        last_used_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      );
    `,
  },
  {
    id: 2,
    name: "views_webhooks_undo",
    sql: /* sql */ `
      create table views (
        id uuid primary key default gen_random_uuid(),
        object_type_id uuid not null references object_types(id) on delete cascade,
        name text not null,
        config jsonb not null default '{}',
        position int not null default 0,
        created_by text not null,
        created_at timestamptz not null default now()
      );

      create table webhooks (
        id uuid primary key default gen_random_uuid(),
        url text not null,
        events text[] not null default '{*}',
        secret text not null,
        active boolean not null default true,
        last_status int,
        last_error text,
        last_at timestamptz,
        created_at timestamptz not null default now()
      );

      alter table audit_log add column undone_at timestamptz;
    `,
  },
  {
    id: 3,
    name: "activity_links",
    sql: /* sql */ `
      -- An activity (task, note, call…) can be about any number of records, across objects.
      create table activity_links (
        activity_id uuid not null references activities(id) on delete cascade,
        record_id uuid not null references records(id) on delete cascade,
        position int not null default 0,
        primary key (activity_id, record_id)
      );
      create index activity_links_record_idx on activity_links (record_id);
      insert into activity_links (activity_id, record_id)
        select id, record_id from activities where record_id is not null;
    `,
  },
  {
    id: 4,
    name: "object_colors",
    sql: /* sql */ `
      -- Backfill a color for objects created before colors were assigned automatically.
      update object_types o set color = (array['amber','pink','teal','orange','red','blue','violet','green'])[1 + (n.rn - 1) % 8]
      from (select id, row_number() over (order by created_at) as rn from object_types where color = '') n
      where o.id = n.id;
    `,
  },
  {
    id: 5,
    name: "stage_kinds",
    sql: /* sql */ `
      -- Give existing deal stages a kind (open/won/lost) and a default win probability.
      update field_defs f set options = jsonb_set(f.options, '{choices}', (
        select coalesce(jsonb_agg(
          case
            when c ? 'kind' then c
            when lower(c->>'value') ~ '(^|_)(won|closed_won)$' then c || '{"kind":"won","probability":100}'
            when lower(c->>'value') ~ '(^|_)(lost|closed_lost)$' then c || '{"kind":"lost","probability":0}'
            when lower(c->>'value') = 'lead' then c || '{"kind":"open","probability":10}'
            when lower(c->>'value') = 'qualified' then c || '{"kind":"open","probability":25}'
            when lower(c->>'value') = 'proposal' then c || '{"kind":"open","probability":50}'
            when lower(c->>'value') = 'negotiation' then c || '{"kind":"open","probability":75}'
            else c || '{"kind":"open"}'
          end order by ord), '[]'::jsonb)
        from jsonb_array_elements(f.options->'choices') with ordinality as t(c, ord)))
      from object_types o
      where f.object_type_id = o.id and o.slug = 'deals' and f.key = 'stage' and f.options ? 'choices';
    `,
  },
  {
    id: 6,
    name: "activity_soft_delete",
    sql: /* sql */ `
      -- Deleting an activity hides it instead, so the delete can be undone from the audit log.
      alter table activities add column deleted_at timestamptz;
      drop index activities_open_tasks_idx;
      create index activities_open_tasks_idx on activities (due_at) where kind = 'task' and done_at is null and deleted_at is null;
    `,
  },
  {
    id: 7,
    name: "date_fields_as_days",
    sql: /* sql */ `
      -- Date fields hold YYYY-MM-DD. Older writes stored some as full timestamps; keep their
      -- date part, which is what filters and the dashboard already compared on.
      update records r set data = r.data || (
        select jsonb_object_agg(f.key, left(r.data->>f.key, 10)) from field_defs f
        where f.object_type_id = r.object_type_id and f.type = 'date' and r.data->>f.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T')
      where exists (
        select 1 from field_defs f
        where f.object_type_id = r.object_type_id and f.type = 'date' and r.data->>f.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T');
    `,
  },
  {
    id: 8,
    name: "change_sources",
    sql: /* sql */ `
      -- Where a write came from ({url, label}), e.g. the email an agent acted on.
      alter table audit_log add column source jsonb;
      alter table activities add column source jsonb;
    `,
  },
  {
    id: 9,
    name: "key_require_source",
    sql: /* sql */ `
      -- A key with this set can't write records or activities without a source link.
      alter table api_keys add column require_source boolean not null default false;
    `,
  },
];

export async function migrate() {
  await sql`create table if not exists _migrations (id int primary key, name text not null, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ id: number }[]>`select id from _migrations`).map((r) => r.id));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx`insert into _migrations (id, name) values (${m.id}, ${m.name})`;
    });
    console.log(`[db] applied migration ${m.id} ${m.name}`);
  }
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const [row] = await sql<{ value: T }[]>`select value from settings where key = ${key}`;
  return row?.value;
}

export async function setSetting(key: string, value: unknown) {
  await sql`insert into settings (key, value) values (${key}, ${json(value)}::jsonb)
            on conflict (key) do update set value = excluded.value`;
}
