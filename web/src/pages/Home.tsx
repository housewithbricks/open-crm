import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { BarRows, StackedColumns, youSeriesColor, type Series } from "../components/charts";
import { Card, CardHead, Link2, ObjIcon } from "../components/ui";
import { api, type Filter } from "../lib/api";
import { dot, fmtMoney, fmtMoneyCompact } from "../lib/format";
import { useSchema } from "../lib/schema";
import { useAppearance } from "../lib/theme";

type Stage = { value: string; label: string; color: string; count: number; amount: number; kind: "open" | "won" | "lost"; probability: number | null; unknown?: boolean };
type Dashboard = {
  growth: { slug: string; total: number; this_week: number; last_week: number }[];
  activity: { day: string; user: number; agent: number }[];
  tasks: { overdue: number; today: number };
  pending_approvals: number;
  pipeline: null | {
    object: string; label: string; stage_field: string; currency: string;
    stages: Stage[];
    open: { count: number; amount: number };
    weighted: number | null;
    avg_open_deal: number | null;
    cycle_days: number | null;
    won_this_month: { n: number; amount: number };
    win_rate_90d: number | null; won_90d: number; lost_90d: number;
    monthly: { month: string; won_n: number; won_amount: number; lost_n: number }[];
    weekly_created: { week: string; n: number; amount: number }[];
    stale: { id: string }[];
  };
};

// Chart colors, each pair checked with the palette validator on light and dark surfaces.
const SERIES_AGENT = "#0d9488";
const SERIES_WON = "#16a34a";
const SERIES_LOST = "#ea580c";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-line bg-panel px-4 py-3.5">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-[26px] leading-tight font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function Legend({ items }: { items: Series[] }) {
  return (
    <div className="inline-flex gap-3.5 text-xs text-ink-2">
      {items.map((s) => <span key={s.key} className="inline-flex items-center gap-1.5"><i className="size-2.5 rounded-[3px]" style={{ background: s.color }} />{s.label}</span>)}
    </div>
  );
}

const monthLabel = (m: string) => new Date(m + "-15T12:00:00Z").toLocaleDateString(undefined, { month: "short" });
const dayLabel = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });

export default function Home() {
  const { data: schema } = useSchema();
  const navigate = useNavigate();
  const ui = useAppearance();
  const { data: d } = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/dashboard"), refetchInterval: 60_000 });
  const p = d?.pipeline;
  const youColor = youSeriesColor(ui?.accent, SERIES_AGENT);
  const empty = schema && Object.values(schema.counts).every((n) => n === 0);
  const openList = (slug: string, f: Filter[]) => navigate({ to: "/o/$slug", params: { slug }, search: { k: "table", f } });
  // Filters only accept current options; values of removed options are shown on the board instead.
  const closedValues = p?.stages.filter((s) => s.kind !== "open" && !s.unknown).map((s) => s.value) ?? [];
  const isUnknown = (v: string) => !!p?.stages.find((s) => s.value === v)?.unknown;
  const money = (n: number) => fmtMoneyCompact(n, p?.currency);

  const summary: { text: string; go: () => void }[] = [];
  if (d?.tasks.overdue) summary.push({ text: `${d.tasks.overdue} overdue ${d.tasks.overdue === 1 ? "task" : "tasks"}`, go: () => navigate({ to: "/tasks" }) });
  if (d?.pending_approvals) summary.push({ text: `${d.pending_approvals} to approve`, go: () => navigate({ to: "/approvals" }) });
  if (p?.stale.length) {
    summary.push({
      text: `${p.stale.length} ${p.label.toLowerCase()} going quiet`,
      go: () => openList(p.object, [
        ...(closedValues.length ? [{ field: p.stage_field, op: "not_in" as const, value: closedValues }] : []),
        { field: "updated_at", op: "lt", value: "today-14" },
      ]),
    });
  }

  const hasWinData = !!p && p.monthly.some((m) => m.won_n || m.lost_n);
  const hasNewData = !!p && p.weekly_created.some((w) => w.amount);

  return (
    <div className="flex max-w-[1120px] flex-col gap-5">
      <header>
        <h1 className="mt-1 mb-0.5 text-[22px]">{greeting()}</h1>
        <p className="m-0 text-muted">
          {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          {d && (summary.length
            ? summary.map((s) => <Fragment key={s.text}> · <Link2 onClick={s.go}>{s.text}</Link2></Fragment>)
            : " · Nothing needs you right now.")}
        </p>
      </header>

      {empty && (
        <Card>
          <h3 className="mt-0 mb-1 text-[13px]">Get started</h3>
          <p className="m-0 text-muted">
            Add records, import a CSV, or <Link2 onClick={() => navigate({ to: "/settings/keys" })}>connect an agent</Link2> and let it fill in your CRM.
          </p>
        </Card>
      )}

      {d && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-3">
          {p ? (
            <>
              <Kpi label="Open pipeline" value={money(p.open.amount)}
                sub={`${p.open.count} open ${p.label.toLowerCase()}${p.avg_open_deal ? ` · avg ${money(p.avg_open_deal)}` : ""}`} />
              <Kpi label="Weighted forecast" value={p.weighted === null ? "—" : money(p.weighted)}
                sub={p.weighted === null ? "Set stage win % in Edit stages" : "Open value × stage win %"} />
              <Kpi label="Won this month" value={money(p.won_this_month.amount)} sub={`${p.won_this_month.n} closed won`} />
              <Kpi label="Win rate · 90 days" value={p.win_rate_90d === null ? "—" : `${Math.round(p.win_rate_90d * 100)}%`}
                sub={p.win_rate_90d === null ? "No closed deals yet" : `${p.won_90d} won · ${p.lost_90d} lost${p.cycle_days !== null ? ` · ${Math.round(p.cycle_days)} days to close` : ""}`} />
            </>
          ) : (
            (schema?.objects ?? []).slice(0, 4).map((o) => {
              const g = d.growth.find((x) => x.slug === o.slug);
              return <Kpi key={o.slug} label={o.label_plural} value={String(g?.total ?? 0)} sub={g?.this_week ? `+${g.this_week} this week` : "No new this week"} />;
            })
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
        {p && (
          <Card>
            <CardHead title={<><ObjIcon slug={p.object} size={18} />Pipeline by stage</>}
              action={<Link2 onClick={() => navigate({ to: "/o/$slug", params: { slug: p.object }, search: { k: "board" } })}>Open board →</Link2>} />
            <BarRows
              format={(v) => money(v)}
              onPick={(stage) => stage && isUnknown(stage)
                ? navigate({ to: "/o/$slug", params: { slug: p.object }, search: { k: "board" } })
                : openList(p.object, stage ? [{ field: p.stage_field, op: "in", value: [stage] }] : [{ field: p.stage_field, op: "is_empty" }])}
              rows={p.stages.filter((s) => s.kind === "open").map((s) => ({
                key: s.value, value: s.amount, color: dot(s.color),
                detail: `${s.count} ${s.count === 1 ? "deal" : "deals"}${s.probability !== null ? ` · ${s.probability}%` : ""}`,
                label: <><i className="size-2 flex-none rounded-full" style={{ background: dot(s.color) }} /><span className={s.unknown ? "text-muted italic" : undefined} title={s.unknown ? "No longer an option" : undefined}>{s.label}</span></>,
              }))}
            />
          </Card>
        )}

        {p && (
          <Card>
            <CardHead title="Won vs lost · 6 months">
              <Legend items={[{ key: "won", label: "Won", color: SERIES_WON }, { key: "lost", label: "Lost", color: SERIES_LOST }]} />
            </CardHead>
            {hasWinData ? (
              <StackedColumns height={170} ariaLabel="Deals won and lost per month"
                data={p.monthly.map((m) => ({ key: m.month, won: m.won_n, lost: m.lost_n }))}
                series={[{ key: "won", label: "Won", color: SERIES_WON }, { key: "lost", label: "Lost", color: SERIES_LOST }]}
                formatKey={monthLabel} />
            ) : (
              <EmptyChart>No deals marked won or lost yet. Move a deal to a Won or Lost stage and it shows up here.</EmptyChart>
            )}
          </Card>
        )}

        {p && (
          <Card>
            <CardHead title="New pipeline · 8 weeks">
              <span className="text-xs text-muted">{money(p.weekly_created.reduce((t, w) => t + w.amount, 0))} added</span>
            </CardHead>
            {hasNewData ? (
              <StackedColumns height={170} ariaLabel="New pipeline value per week"
                data={p.weekly_created.map((w) => ({ key: w.week, value: w.amount, deals: w.n }))}
                series={[{ key: "value", label: "New value", color: youColor }]}
                formatKey={dayLabel} formatValue={(v) => (v >= 1000 ? fmtMoneyCompact(v, p.currency) : fmtMoney(v, p.currency))} />
            ) : (
              <EmptyChart>No new {p.label.toLowerCase()} in the last 8 weeks.</EmptyChart>
            )}
          </Card>
        )}

        <Card>
          <CardHead title="Activity · 30 days">
            <Legend items={[{ key: "user", label: "You", color: youColor }, { key: "agent", label: "Agents", color: SERIES_AGENT }]} />
          </CardHead>
          {d && (
            <StackedColumns height={170} ariaLabel="Changes per day by you and by agents"
              data={d.activity.map((a) => ({ key: a.day, user: a.user, agent: a.agent }))}
              series={[{ key: "user", label: "You", color: youColor }, { key: "agent", label: "Agents", color: SERIES_AGENT }]}
              formatKey={dayLabel} />
          )}
        </Card>
      </div>
    </div>
  );
}

function EmptyChart({ children }: { children: ReactNode }) {
  return <div className="grid h-[170px] place-items-center rounded-lg border border-dashed border-line px-6 text-center text-muted">{children}</div>;
}
