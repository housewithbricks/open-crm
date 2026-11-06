import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type FieldDef, type FieldType, type Filter, type FilterOp, type ObjectType, type RecordDetail, type RecordList } from "../lib/api";
import { cn, dot, fmtDate, fmtMoney } from "../lib/format";
import { btnClass, inputClass, Segmented } from "./ui";
import { Select } from "./select";

/* Popover styles */
const POP = "animate-menu absolute top-[calc(100%+6px)] left-0 z-30 min-w-60 max-w-[min(320px,90vw)] rounded-[10px] border border-line bg-panel p-1.5 text-[13px] shadow-pop";
const POP_SEARCH = "mb-1 h-8 w-full border-0 border-b border-line bg-transparent px-2 outline-none placeholder:text-faint";
const POP_LIST = "flex max-h-[280px] flex-col overflow-y-auto";
const popItem = (active?: boolean) => cn("flex min-h-[30px] cursor-pointer items-center gap-2 rounded-ctl px-2 text-left text-ink hover:bg-hover", active && "bg-hover");
const POP_EMPTY = "p-2 text-xs text-muted";
const Radio = ({ on }: { on: boolean }) => <span className={cn("size-3.5 flex-none rounded-full", on ? "border-4 border-accent" : "border-[1.5px] border-line-2")} />;

/* -------------------------------------------------------------------------- */
/* Field model: object fields plus record metadata                             */
/* -------------------------------------------------------------------------- */

type FField = { key: string; label: string; type: FieldType | "meta_date"; def?: FieldDef };

function filterFields(obj: ObjectType): FField[] {
  return [
    ...obj.fields.filter((f) => f.type !== "long_text").map((f) => ({ key: f.key, label: f.label, type: f.type, def: f })),
    { key: "created_at", label: "Created", type: "meta_date" as const },
    { key: "updated_at", label: "Last updated", type: "meta_date" as const },
  ];
}

const kindOf = (t: FField["type"]) =>
  t === "select" || t === "multi_select" ? "options"
    : t === "relation" ? "relation"
    : t === "number" || t === "currency" ? "number"
    : t === "date" || t === "meta_date" ? "date"
    : t === "boolean" ? "boolean"
    : "text";

/** A filter is applied only once it has what it needs. */
export function isComplete(f: Filter) {
  if (f.op === "is_empty" || f.op === "not_empty") return true;
  if (f.op === "in" || f.op === "not_in") return Array.isArray(f.value) && f.value.length > 0;
  if (f.op === "between") return Array.isArray(f.value) && f.value.every((v) => v !== "" && v != null);
  return f.value !== "" && f.value !== null && f.value !== undefined;
}

function newFilter(ff: FField): Filter {
  switch (kindOf(ff.type)) {
    case "options": case "relation": return { field: ff.key, op: "in", value: [] };
    case "number": return { field: ff.key, op: "gte", value: "" };
    case "date": return { field: ff.key, op: "between", value: ["today", "today+7"] };
    case "boolean": return { field: ff.key, op: "eq", value: true };
    default: return { field: ff.key, op: "contains", value: "" };
  }
}

/* -------------------------------------------------------------------------- */
/* Human-readable summaries                                                    */
/* -------------------------------------------------------------------------- */

const DATE_PRESETS: { label: string; f: Omit<Filter, "field"> }[] = [
  { label: "Overdue / in the past", f: { op: "lt", value: "today" } },
  { label: "Today", f: { op: "eq", value: "today" } },
  { label: "Next 7 days", f: { op: "between", value: ["today", "today+7"] } },
  { label: "Next 30 days", f: { op: "between", value: ["today", "today+30"] } },
  { label: "Last 7 days", f: { op: "between", value: ["today-7", "today"] } },
  { label: "Last 30 days", f: { op: "between", value: ["today-30", "today"] } },
  { label: "More than 30 days ago", f: { op: "lt", value: "today-30" } },
];

const relDate = (v: unknown) => {
  const m = typeof v === "string" ? /^today(?:([+-])(\d+))?$/.exec(v) : null;
  if (!m) return typeof v === "string" ? fmtDate(v) : String(v);
  if (!m[1]) return "today";
  return m[1] === "+" ? `in ${m[2]} days` : `${m[2]} days ago`;
};

function presetLabel(f: Filter) {
  return DATE_PRESETS.find((p) => p.f.op === f.op && JSON.stringify(p.f.value) === JSON.stringify(f.value))?.label;
}

function RefName({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ["record", id], queryFn: () => api<RecordDetail>(`/records/${id}`), staleTime: 60_000 });
  return <>{data?.record.display_name ?? "…"}</>;
}

function summary(ff: FField | undefined, f: Filter): ReactNode {
  if (!ff) return f.op;
  const k = kindOf(ff.type);
  if (f.op === "is_empty") return "is empty";
  if (f.op === "not_empty") return "is not empty";
  if (k === "date") return presetLabel(f)?.toLowerCase() ?? (f.op === "between" ? `${relDate((f.value as unknown[])[0])} – ${relDate((f.value as unknown[])[1])}` : `${{ eq: "is", neq: "is not", gt: "after", gte: "on or after", lt: "before", lte: "on or before" }[f.op as string] ?? f.op} ${relDate(f.value)}`);
  if (k === "boolean") return f.value ? "is yes" : "is no";
  if (k === "options") {
    const vals = (f.value as string[]) ?? [];
    return <>{f.op === "not_in" ? "is not " : vals.length > 1 ? "is any of " : "is "}
      {vals.map((v, i) => {
        const c = ff.def?.options.choices?.find((x) => x.value === v || x.label === v);
        return <span key={v} className="ml-0.5 inline-flex items-center gap-1"><i className="size-[7px] rounded-full" style={{ background: dot(c?.color) }} />{c?.label ?? v}{i < vals.length - 1 ? "," : ""}</span>;
      })}</>;
  }
  if (k === "relation") {
    const ids = (f.value as string[]) ?? [];
    return <>{f.op === "not_in" ? "is not " : "is "}{ids.length > 2 ? `${ids.length} records` : ids.map((id, i) => <span key={id}><RefName id={id} />{i < ids.length - 1 ? ", " : ""}</span>)}</>;
  }
  const num = (v: unknown) => (ff.type === "currency" ? fmtMoney(Number(v), ff.def?.options.currency) : Number(v).toLocaleString());
  if (k === "number") {
    if (f.op === "between") return `between ${num((f.value as unknown[])[0])} and ${num((f.value as unknown[])[1])}`;
    return `${{ eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" }[f.op as string]} ${num(f.value)}`;
  }
  return `${{ contains: "contains", eq: "is", neq: "is not" }[f.op as string] ?? f.op} “${f.value}”`;
}

/* -------------------------------------------------------------------------- */
/* Bar                                                                         */
/* -------------------------------------------------------------------------- */

export default function FilterBar({ obj, filters, onChange }: { obj: ObjectType; filters: Filter[]; onChange: (f: Filter[]) => void }) {
  const fields = filterFields(obj);
  const [open, setOpen] = useState<number | "new" | null>(null);
  const update = (i: number, f: Filter | null) => onChange(f ? filters.map((x, j) => (j === i ? f : x)) : filters.filter((_, j) => j !== i));

  // Drop filters that were left incomplete when their popover closes.
  const close = () => {
    setOpen(null);
    if (filters.some((f) => !isComplete(f))) onChange(filters.filter(isComplete));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((f, i) => {
        const ff = fields.find((x) => x.key === f.field);
        return (
          <Popover key={i} open={open === i} onClose={close}
            anchor={
              <span className={cn("inline-flex h-[26px] items-center rounded-ctl border bg-panel pr-0.5 text-xs text-ink-2",
                open === i ? "border-accent ring-3 ring-accent-soft" : "border-line-2", !isComplete(f) && "border-dashed")}>
                <button type="button" className="inline-flex h-6 items-center gap-1 pr-1 pl-2.5" onClick={() => setOpen(open === i ? null : i)}>
                  <b className="font-medium text-ink">{ff?.label ?? f.field}</b> <span className="text-muted">{summary(ff, f)}</span>
                </button>
                <button type="button" className="size-5 rounded text-faint hover:bg-hover hover:text-ink" title="Remove filter" onClick={() => update(i, null)}>×</button>
              </span>
            }>
            {ff && <FilterEditor ff={ff} filter={f} onChange={(nf) => update(i, nf)} />}
          </Popover>
        );
      })}
      <Popover open={open === "new"} onClose={close}
        anchor={<button type="button" className={btnClass("ghost")} onClick={() => setOpen(open === "new" ? null : "new")}>+ Filter</button>}>
        <FieldMenu fields={fields} onPick={(ff) => { onChange([...filters, newFilter(ff)]); setOpen(filters.length); }} />
      </Popover>
      {filters.length > 1 && <button type="button" className={btnClass("ghost")} onClick={() => onChange([])}>Clear</button>}
    </div>
  );
}

function Popover({ open, onClose, anchor, children }: { open: boolean; onClose: () => void; anchor: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Dropdown menus are portalled to <body>; clicks and Esc inside them belong to this popover.
    const inMenu = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.(".select-menu");
    const click = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && !inMenu(e.target) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".select-menu")) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key, true); };
  }, [open, onClose]);
  return (
    <div className="relative inline-flex" ref={ref}>
      {anchor}
      {open && <div className={POP}>{children}</div>}
    </div>
  );
}

const TYPE_GLYPH: Record<string, string> = {
  text: "Aa", long_text: "¶", email: "@", url: "↗", phone: "☏", number: "#", currency: "$", date: "▦", meta_date: "◷",
  boolean: "✓", select: "◉", multi_select: "☰", relation: "⇄",
};

function FieldMenu({ fields, onPick }: { fields: FField[]; onPick: (f: FField) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const shown = fields.filter((f) => f.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div style={{ width: 240 }}>
      <input className={POP_SEARCH} autoFocus placeholder="Filter by…" value={q}
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          if (e.key === "Enter" && shown[sel]) onPick(shown[sel]);
        }} />
      <div className={POP_LIST}>
        {shown.map((f, i) => (
          <button key={f.key} type="button" className={popItem(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => onPick(f)}>
            <span className="w-[18px] text-center font-mono text-xs text-muted">{TYPE_GLYPH[f.type]}</span>{f.label}
          </button>
        ))}
        {!shown.length && <div className={POP_EMPTY}>No matching fields</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editors: one per kind of field, applied live                                */
/* -------------------------------------------------------------------------- */

function FilterEditor({ ff, filter, onChange }: { ff: FField; filter: Filter; onChange: (f: Filter) => void }) {
  const set = (patch: Partial<Filter>) => onChange({ ...filter, ...patch });
  const k = kindOf(ff.type);
  const emptyOps: FilterOp[] = ff.type === "meta_date" ? [] : ["is_empty", "not_empty"];
  const isEmptyOp = filter.op === "is_empty" || filter.op === "not_empty";

  const opSelect = (ops: [FilterOp, string][]) => (
    <Select size="sm" value={filter.op} ariaLabel="Condition"
      options={[...ops, ...emptyOps.map((o) => [o, o === "is_empty" ? "is empty" : "is not empty"] as [FilterOp, string])].map(([o, l]) => ({ value: o, label: l }))}
      onChange={(v) => {
        const op = v as FilterOp;
        const wasList = Array.isArray(filter.value);
        const needsList = op === "in" || op === "not_in" || op === "between";
        set({ op, value: needsList === wasList ? filter.value : needsList ? (op === "between" ? ["", ""] : []) : "" });
      }} />
  );

  return (
    <div className="flex w-[280px] flex-col gap-1.5 p-0.5">
      <div className="px-1.5 pt-1 text-xs text-muted"><b className="font-semibold text-ink">{ff.label}</b></div>

      {k === "options" && (
        <>
          {opSelect([["in", "is any of"], ["not_in", "is none of"]])}
          {!isEmptyOp && (
            <div className={POP_LIST}>
              {ff.def?.options.choices?.map((c) => {
                const vals = (filter.value as string[]) ?? [];
                const on = vals.includes(c.value);
                return (
                  <label key={c.value} className={popItem()}>
                    <input type="checkbox" checked={on} onChange={() => set({ value: on ? vals.filter((v) => v !== c.value) : [...vals, c.value] })} />
                    <i className="size-2 flex-none rounded-full" style={{ background: dot(c.color) }} />{c.label}
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}

      {k === "relation" && (
        <>
          {opSelect([["in", "is any of"], ["not_in", "is none of"]])}
          {!isEmptyOp && <RelationOptions target={ff.def!.options.target!} value={(filter.value as string[]) ?? []} onChange={(value) => set({ value })} />}
        </>
      )}

      {k === "boolean" && (
        <Segmented className="mt-1 self-start"
          value={filter.op === "is_empty" ? "unset" : filter.value === false ? "no" : "yes"}
          onChange={(v) => set(v === "unset" ? { op: "is_empty", value: undefined } : { op: "eq", value: v === "yes" })}
          options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "unset", label: "Not set" }]} />
      )}

      {k === "text" && (
        <>
          {opSelect([["contains", "contains"], ["eq", "is"], ["neq", "is not"]])}
          {!isEmptyOp && <input className={inputClass} autoFocus placeholder="Type a value…" value={String(filter.value ?? "")} onChange={(e) => set({ value: e.target.value })} />}
        </>
      )}

      {k === "number" && (
        <>
          {opSelect([["gte", "≥ at least"], ["lte", "≤ at most"], ["between", "between"], ["eq", "= equals"], ["gt", "> more than"], ["lt", "< less than"], ["neq", "≠ not"]])}
          {!isEmptyOp && (filter.op === "between" ? (
            <div className="flex gap-2">
              {[0, 1].map((i) => (
                <input key={i} className={inputClass} type="number" placeholder={i ? "Max" : "Min"} value={String((filter.value as unknown[])?.[i] ?? "")}
                  onChange={(e) => { const v = [...((filter.value as unknown[]) ?? ["", ""])]; v[i] = e.target.value === "" ? "" : Number(e.target.value); set({ value: v }); }} />
              ))}
            </div>
          ) : (
            <input className={inputClass} type="number" autoFocus placeholder="Amount" value={String(filter.value ?? "")} onChange={(e) => set({ value: e.target.value === "" ? "" : Number(e.target.value) })} />
          ))}
        </>
      )}

      {k === "date" && <DateEditor filter={filter} set={set} allowEmpty={ff.type !== "meta_date"} />}
    </div>
  );
}

function DateEditor({ filter, set, allowEmpty }: { filter: Filter; set: (p: Partial<Filter>) => void; allowEmpty: boolean }) {
  const preset = presetLabel(filter);
  const [custom, setCustom] = useState(!preset && filter.op !== "is_empty" && filter.op !== "not_empty");
  const iso = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "");
  return (
    <>
      <div className={POP_LIST}>
        {DATE_PRESETS.map((p) => (
          <button key={p.label} type="button" className={popItem()} onClick={() => { setCustom(false); set(p.f); }}>
            <Radio on={preset === p.label && !custom} />{p.label}
          </button>
        ))}
        {allowEmpty && (["is_empty", "not_empty"] as const).map((op) => (
          <button key={op} type="button" className={popItem()} onClick={() => { setCustom(false); set({ op, value: undefined }); }}>
            <Radio on={filter.op === op} />{op === "is_empty" ? "No date" : "Has a date"}
          </button>
        ))}
        <button type="button" className={popItem()} onClick={() => { setCustom(true); set({ op: "gte", value: "" }); }}>
          <Radio on={custom} />Custom…
        </button>
      </div>
      {custom && (
        <div style={{ padding: "6px 2px 2px" }}>
          <div style={{ marginBottom: 6 }}>
            <Select size="sm" value={filter.op} ariaLabel="Condition"
              options={[{ value: "gte", label: "on or after" }, { value: "lte", label: "on or before" }, { value: "eq", label: "on" }, { value: "between", label: "between" }]}
              onChange={(v) => { const op = v as FilterOp; set({ op, value: op === "between" ? ["", ""] : "" }); }} />
          </div>
          {filter.op === "between" ? (
            <div className="flex gap-2">
              {[0, 1].map((i) => (
                <input key={i} className={inputClass} type="date" value={iso((filter.value as unknown[])?.[i])}
                  onChange={(e) => { const v = [...((filter.value as unknown[]) ?? ["", ""])]; v[i] = e.target.value; set({ value: v }); }} />
              ))}
            </div>
          ) : (
            <input className={inputClass} type="date" value={iso(filter.value)} onChange={(e) => set({ value: e.target.value })} />
          )}
        </div>
      )}
    </>
  );
}

function RelationOptions({ target, value, onChange }: { target: string; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const { data } = useQuery({
    queryKey: ["records", target, "pick", q],
    queryFn: () => api<RecordList>(`/objects/${target}/records?limit=8&sort=display_name&dir=asc&q=${encodeURIComponent(q)}`),
  });
  const rows = data?.records ?? [];
  const extra = value.filter((id) => !rows.some((r) => r.id === id));
  return (
    <>
      <input className={POP_SEARCH} autoFocus placeholder={`Search ${target}…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className={POP_LIST}>
        {extra.map((id) => (
          <label key={id} className={popItem()}>
            <input type="checkbox" checked onChange={() => onChange(value.filter((v) => v !== id))} /><RefName id={id} />
          </label>
        ))}
        {rows.map((r) => {
          const on = value.includes(r.id);
          return (
            <label key={r.id} className={popItem()}>
              <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((v) => v !== r.id) : [...value, r.id])} />
              {r.display_name || "Untitled"}
            </label>
          );
        })}
        {data && !rows.length && !extra.length && <div className={POP_EMPTY}>No matches</div>}
      </div>
    </>
  );
}
