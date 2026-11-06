import { sql } from "../db.js";
import { numField } from "./records.js";
import { loadSchema } from "./schema.js";
import type { FieldDef, ObjectType } from "./types.js";

const DAY = 864e5;
const WON = /\b(won|closed[ _-]?won|signed|customer)\b/i;
const LOST = /\b(lost|closed[ _-]?lost|churned|dead|disqualified)\b/i;

/**
 * Find the object that behaves like a sales pipeline: a select field called stage/status
 * plus a currency field. Prefers "deals". Returns null when the schema has none.
 */
function findPipeline(objects: ObjectType[]) {
  const candidates = objects
    .map((o) => {
      const stage = o.fields.find((f) => f.type === "select" && /stage|status|pipeline/i.test(f.key + f.label));
      const amount = o.fields.find((f) => f.type === "currency") ?? o.fields.find((f) => f.type === "number");
      const close = o.fields.find((f) => f.type === "date" && /close|due|expected|end/i.test(f.key + f.label)) ?? o.fields.find((f) => f.type === "date");
      return stage && amount ? { obj: o, stage, amount, close } : null;
    })
    .filter((x): x is { obj: ObjectType; stage: FieldDef; amount: FieldDef; close: FieldDef | undefined } => !!x);
  return candidates.find((c) => c.obj.slug === "deals") ?? candidates[0] ?? null;
}

export async function dashboard() {
  const objects = await loadSchema();
  const now = Date.now();
  const since30 = new Date(now - 29 * DAY);
  since30.setUTCHours(0, 0, 0, 0);

  /* --------------------------- records per object --------------------------- */
  const growth = await sql<{ slug: string; total: number; this_week: number; last_week: number }[]>`
    select o.slug,
      count(r.id)::int as total,
      count(r.id) filter (where r.created_at >= now() - interval '7 days')::int as this_week,
      count(r.id) filter (where r.created_at >= now() - interval '14 days' and r.created_at < now() - interval '7 days')::int as last_week
    from object_types o left join records r on r.object_type_id = o.id and r.deleted_at is null
    where o.archived_at is null group by o.slug, o.position order by o.position`;

  /* ------------------------------ activity (30d) ----------------------------- */
  const activityRows = await sql<{ day: string; actor_type: string; n: number }[]>`
    select to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD') as day, actor_type, count(*)::int as n
    from audit_log
    where created_at >= ${since30} and action not like 'view.%' and undone_at is null
    group by 1, 2`;
  const activity = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(since30.getTime() + i * DAY).toISOString().slice(0, 10);
    const pick = (t: string) => activityRows.find((r) => r.day === day && r.actor_type === t)?.n ?? 0;
    return { day, user: pick("user"), agent: pick("agent") };
  });

  const agents = await sql<{ name: string; actions: number; records_touched: number; last_at: string }[]>`
    select actor_name as name, count(*)::int as actions, count(distinct target_id) filter (where action like 'record.%')::int as records_touched, max(created_at) as last_at
    from audit_log where actor_type = 'agent' and created_at >= now() - interval '7 days' and undone_at is null
    group by actor_name order by actions desc limit 6`;

  /* ---------------------------------- tasks --------------------------------- */
  const [tasks] = await sql<{ open: number; overdue: number; today: number; week: number; done_week: number }[]>`
    select
      count(*) filter (where done_at is null)::int as open,
      count(*) filter (where done_at is null and due_at::date < current_date)::int as overdue,
      count(*) filter (where done_at is null and due_at::date = current_date)::int as today,
      count(*) filter (where done_at is null and due_at::date > current_date and due_at::date <= current_date + 7)::int as week,
      count(*) filter (where done_at >= now() - interval '7 days')::int as done_week
    from activities where kind = 'task' and deleted_at is null`;

  const [{ pending }] = await sql<{ pending: number }[]>`select count(*)::int as pending from change_requests where status = 'pending'`;

  /* --------------------------------- pipeline -------------------------------- */
  const p = findPipeline(objects);
  let pipeline = null;
  if (p) {
    const { obj, stage, amount, close } = p;
    const choices = stage.options.choices ?? [];
    // Explicit stage kinds (set in "Edit stages") win; otherwise fall back to the stage name.
    const choiceOf = (v: string) => choices.find((c) => c.value === v);
    const isWon = (v: string) => (choiceOf(v)?.kind ? choiceOf(v)!.kind === "won" : WON.test(v) || WON.test(choiceOf(v)?.label ?? ""));
    const isLost = (v: string) => (choiceOf(v)?.kind ? choiceOf(v)!.kind === "lost" : LOST.test(v) || LOST.test(choiceOf(v)?.label ?? ""));
    const wonValues = choices.filter((c) => isWon(c.value)).map((c) => c.value);
    const lostValues = choices.filter((c) => isLost(c.value)).map((c) => c.value);

    const byStage = await sql<{ stage: string | null; n: number; value: number }[]>`
      select data->>${stage.key} as stage, count(*)::int as n, coalesce(sum(${numField(amount.key)}), 0)::float as value
      from records where object_type_id = ${obj.id} and deleted_at is null group by 1`;
    const stages = [
      ...choices.map((c) => {
        const row = byStage.find((r) => r.stage === c.value);
        return {
          value: c.value, label: c.label, color: c.color ?? "gray", count: row?.n ?? 0, amount: row?.value ?? 0,
          kind: isWon(c.value) ? "won" : isLost(c.value) ? "lost" : "open", probability: c.probability ?? null,
        };
      }),
      // Values that are no longer options (e.g. a removed stage) still hold deals: show them as-is
      // so their totals aren't lost and they can be moved.
      ...byStage.filter((r) => r.stage !== null && !choiceOf(r.stage)).map((r) => ({
        value: r.stage!, label: r.stage!, color: "gray", count: r.n, amount: r.value,
        kind: isWon(r.stage!) ? "won" : isLost(r.stage!) ? "lost" : "open", probability: null, unknown: true,
      })),
      ...byStage.filter((r) => r.stage === null).map((r) => ({ value: "", label: `No ${stage.label.toLowerCase()}`, color: "gray", count: r.n, amount: r.value, kind: "open", probability: null })),
    ];
    const open = stages.filter((s) => s.kind === "open");

    // Stage moves into won/lost, from the audit log (a record counts once, at its latest move).
    const moves = async (values: string[], days: number) => {
      if (!values.length) return { n: 0, amount: 0 };
      const [r] = await sql<{ n: number; amount: number }[]>`
        select count(distinct a.target_id)::int as n, coalesce(sum(distinct_amount), 0)::float as amount from (
          select distinct on (a.target_id) a.target_id, ${numField(amount.key, "r.data")} as distinct_amount
          from audit_log a join records r on r.id::text = a.target_id
          where a.object_slug = ${obj.slug} and a.action in ('record.create', 'record.update') and a.undone_at is null
            and a.after->>${stage.key} = any(${values}::text[]) and a.created_at >= now() - make_interval(days => ${days})
            and r.deleted_at is null and r.data->>${stage.key} = any(${values}::text[])
          order by a.target_id, a.created_at desc) a`;
      return r;
    };
    const startOfMonth = Math.ceil((now - new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1).getTime()) / DAY);
    const wonMonth = await moves(wonValues, startOfMonth);
    const won90 = await moves(wonValues, 90);
    const lost90 = await moves(lostValues, 90);

    const openFilter = sql`object_type_id = ${obj.id} and deleted_at is null
      and coalesce(data->>${stage.key}, '') <> all(${[...wonValues, ...lostValues]}::text[])`;
    const closing = close
      ? await sql<{ id: string; name: string; close: string; amount: number | null; stage: string | null }[]>`
          select id, display_name as name, left(data->>${close.key}, 10) as close, ${numField(amount.key)}::float as amount, data->>${stage.key} as stage
          from records where ${openFilter}
            and left(data->>${close.key}, 10) between to_char(current_date - 30, 'YYYY-MM-DD') and to_char(current_date + 30, 'YYYY-MM-DD')
          order by data->>${close.key} limit 6`
      : [];
    const stale = await sql<{ id: string; name: string; updated_at: string; amount: number | null; stage: string | null }[]>`
      select id, display_name as name, updated_at, ${numField(amount.key)}::float as amount, data->>${stage.key} as stage
      from records where ${openFilter} and updated_at < now() - interval '14 days'
        and not exists (select 1 from activity_links l join activities a on a.id = l.activity_id
                        where l.record_id = records.id and a.deleted_at is null and a.created_at > now() - interval '14 days')
      order by updated_at limit 5`;

    // Weighted forecast: open value × stage win probability (only when stages have probabilities).
    const hasProb = open.some((s) => s.probability !== null);
    const weighted = hasProb ? open.reduce((t, s) => t + s.amount * ((s.probability ?? 0) / 100), 0) : null;

    // Won vs lost per month (last 6 months), from stage moves in the audit log.
    const monthly = await sql<{ month: string; won_n: number; won_amount: number; lost_n: number }[]>`
      with moves as (
        select distinct on (a.target_id, date_trunc('month', a.created_at)) a.target_id, date_trunc('month', a.created_at) as m, a.after->>${stage.key} as st
        from audit_log a
        where a.object_slug = ${obj.slug} and a.action in ('record.create', 'record.update') and a.undone_at is null
          and a.after ? ${stage.key} and a.created_at >= date_trunc('month', now()) - interval '5 months'
        order by a.target_id, date_trunc('month', a.created_at), a.created_at desc)
      select to_char(m, 'YYYY-MM') as month,
        count(*) filter (where st = any(${wonValues}::text[]))::int as won_n,
        coalesce(sum(${numField(amount.key, "r.data")}) filter (where st = any(${wonValues}::text[])), 0)::float as won_amount,
        count(*) filter (where st = any(${lostValues}::text[]))::int as lost_n
      from moves join records r on r.id::text = moves.target_id and r.deleted_at is null
      group by 1`;
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - (5 - i));
      const month = d.toISOString().slice(0, 7);
      const row = monthly.find((x) => x.month === month);
      return { month, won_n: row?.won_n ?? 0, won_amount: row?.won_amount ?? 0, lost_n: row?.lost_n ?? 0 };
    });

    // New pipeline added per week (last 8 weeks), by record creation.
    const created = await sql<{ week: string; n: number; amount: number }[]>`
      select to_char(date_trunc('week', created_at), 'YYYY-MM-DD') as week, count(*)::int as n,
        coalesce(sum(${numField(amount.key)}), 0)::float as amount
      from records where object_type_id = ${obj.id} and deleted_at is null and created_at >= date_trunc('week', now()) - interval '7 weeks'
      group by 1`;
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const d = new Date();
      const dow = (d.getUTCDay() + 6) % 7; // Monday-based, like date_trunc('week')
      d.setUTCDate(d.getUTCDate() - dow - (7 - i) * 7);
      const week = d.toISOString().slice(0, 10);
      const row = created.find((x) => x.week === week);
      return { week, n: row?.n ?? 0, amount: row?.amount ?? 0 };
    });

    // Average days from creation to won, for deals won in the last 90 days.
    const [cycle] = wonValues.length
      ? await sql<{ days: number | null }[]>`
          select avg(extract(epoch from (w.won_at - r.created_at)) / 86400)::float as days
          from (select a.target_id, max(a.created_at) as won_at from audit_log a
                where a.object_slug = ${obj.slug} and a.undone_at is null and a.after->>${stage.key} = any(${wonValues}::text[])
                  and a.created_at >= now() - interval '90 days' group by a.target_id) w
          join records r on r.id::text = w.target_id and r.deleted_at is null
          where w.won_at >= r.created_at`
      : [{ days: null }];

    pipeline = {
      object: obj.slug,
      label: obj.label_plural,
      stage_field: stage.key,
      amount_field: amount.key,
      close_field: close?.key ?? null,
      currency: amount.options.currency ?? "USD",
      stages,
      open: { count: open.reduce((s, x) => s + x.count, 0), amount: open.reduce((s, x) => s + x.amount, 0) },
      weighted,
      avg_open_deal: open.reduce((s, x) => s + x.count, 0) ? open.reduce((s, x) => s + x.amount, 0) / open.reduce((s, x) => s + x.count, 0) : null,
      cycle_days: cycle?.days ?? null,
      monthly: months,
      weekly_created: weeks,
      won_this_month: wonMonth,
      win_rate_90d: won90.n + lost90.n > 0 ? won90.n / (won90.n + lost90.n) : null,
      won_90d: won90.n,
      lost_90d: lost90.n,
      closing,
      stale,
    };
  }

  return { generated_at: new Date().toISOString(), growth, activity, agents, tasks, pending_approvals: pending, pipeline };
}
