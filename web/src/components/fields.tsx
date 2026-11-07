import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, type FieldDef, type RecordList, type Ref } from "../lib/api";
import { cn, dot, fmtDay, fmtMoney } from "../lib/format";
import { Select } from "./select";
import { inputClass, refClass, Tag } from "./ui";

export function ChoiceTag({ field, value }: { field: FieldDef; value: string }) {
  const c = field.options.choices?.find((x) => x.value === value);
  return <Tag label={c?.label ?? value} color={c?.color} />;
}

/** Toggleable option list used by multi-select inputs and filters. */
export function ChoiceToggles({ field, value, onChange }: { field: FieldDef; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div role="group" aria-label={field.label} className="flex flex-wrap gap-1">
      {field.options.choices?.map((c) => {
        const on = value.includes(c.value);
        return (
          <button key={c.value} type="button" onClick={() => onChange(on ? value.filter((x) => x !== c.value) : [...value, c.value])}
            className={cn("inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2 text-xs",
              on ? "border-ink-2 text-ink" : "border-dashed border-line-2 text-muted")}>
            <i className="size-[7px] rounded-full" style={{ background: on ? dot(c.color) : "var(--line-2)" }} />
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

export function FieldValue({ field, value, refs, onOpen }: { field: FieldDef; value: any; refs?: Record<string, Ref>; onOpen?: (id: string) => void }) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return <span className="text-faint">—</span>;
  switch (field.type) {
    case "currency":
      return <>{fmtMoney(Number(value), field.options.currency)}</>;
    case "number":
      return <>{Number(value).toLocaleString()}</>;
    case "date":
      return <>{fmtDay(String(value))}</>;
    case "boolean":
      return <>{value ? "Yes" : "No"}</>;
    case "select":
      return <ChoiceTag field={field} value={value} />;
    case "multi_select":
      // A scalar can be left over from before a type change; show it rather than crash.
      return <>{(Array.isArray(value) ? value : [value]).map((v) => <ChoiceTag key={v} field={field} value={v} />)}</>;
    case "email":
      return <a className={refClass} href={`mailto:${value}`} onClick={(e) => e.stopPropagation()}>{value}</a>;
    case "url": {
      const href = /^https?:\/\//.test(value) ? value : `https://${value}`;
      return <a className={refClass} href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{String(value).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a>;
    }
    case "relation": {
      const ids: string[] = Array.isArray(value) ? value : [value];
      return (
        <>
          {ids.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <button type="button" className={cn(refClass, "text-left")} onClick={(e) => { e.stopPropagation(); onOpen?.(id); }}
                onKeyDown={(e) => e.stopPropagation()}>{refs?.[id]?.display_name || "(missing)"}</button>
            </span>
          ))}
        </>
      );
    }
    default:
      return <>{String(value)}</>;
  }
}

export function RelationPicker({ field, value, refs, onChange, id }: { field: FieldDef; value: any; refs?: Record<string, Ref>; onChange: (v: any) => void; id?: string }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const { data } = useQuery({
    queryKey: ["records", field.options.target, { q, limit: 8 }],
    queryFn: () => api<RecordList>(`/objects/${field.options.target}/records?limit=8&q=${encodeURIComponent(q)}`),
  });
  const many = !!field.options.multiple;
  const selected: string[] = value ? (Array.isArray(value) ? value : [value]) : [];
  const nameOf = (id: string) => refs?.[id]?.display_name ?? data?.records.find((r) => r.id === id)?.display_name ?? "…";
  const options = data?.records.filter((r) => !selected.includes(r.id)) ?? [];
  const cur = Math.min(active, Math.max(options.length - 1, 0));
  const pick = (id: string) => { onChange(many ? [...selected, id] : id); setActive(0); };
  return (
    <div>
      {selected.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selected.map((id) => (
            <span key={id} className="inline-flex h-[26px] items-center gap-1 rounded-ctl border border-line-2 bg-panel pl-2 text-xs">
              {nameOf(id)}
              <button type="button" aria-label={`Remove ${nameOf(id)}`} className="size-5 rounded text-faint hover:bg-hover hover:text-ink" onClick={() => onChange(many ? selected.filter((x) => x !== id) : null)}>×</button>
            </span>
          ))}
        </div>
      )}
      <input id={id} className={inputClass} autoFocus placeholder={`Search ${field.options.target}…`} value={q}
        role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={options[cur] ? `${listId}-${options[cur].id}` : undefined}
        onChange={(e) => { setQ(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(cur + 1, options.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(cur - 1, 0)); }
          else if (e.key === "Enter" && options[cur]) { e.preventDefault(); e.stopPropagation(); pick(options[cur].id); }
        }} />
      <div id={listId} role="listbox" aria-label={`${field.label} options`} className="mt-1 max-h-[200px] overflow-y-auto">
        {options.map((r, i) => (
          <div key={r.id} id={`${listId}-${r.id}`} role="option" aria-selected={i === cur}
            className={cn("flex h-[30px] cursor-pointer items-center rounded-ctl px-2 hover:bg-hover", i === cur && "bg-hover")}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => { e.preventDefault(); pick(r.id); }}>
            {r.display_name}
          </div>
        ))}
      </div>
    </div>
  );
}

/** An editor for one field. `id` goes on the focusable control, for a <label htmlFor>. */
export function FieldInput({ field, value, refs, onChange, onCommit, autoFocus, id }: {
  field: FieldDef; value: any; refs?: Record<string, Ref>; onChange: (v: any) => void; onCommit?: () => void; autoFocus?: boolean; id?: string;
}) {
  const key = (e: React.KeyboardEvent) => { if (e.key === "Enter" && field.type !== "long_text") onCommit?.(); };
  const common = { id, className: inputClass, autoFocus, onBlur: onCommit, onKeyDown: key };
  switch (field.type) {
    case "long_text":
      return <textarea {...common} className={cn(inputClass, "h-auto min-h-[72px] py-2")} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "number":
    case "currency":
      return <input {...common} type="number" step="any" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "date":
      return <input {...common} type="date" value={value ? String(value).slice(0, 10) : ""} onChange={(e) => onChange(e.target.value || null)} />;
    case "boolean":
      return (
        <Select id={id} autoFocus={autoFocus} defaultOpen={autoFocus && !!onCommit} onClose={onCommit} value={value === true ? "true" : value === false ? "false" : ""} clearable="Not set"
          options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} onChange={(v) => onChange(v === "" ? null : v === "true")} />
      );
    case "select":
      return (
        <Select id={id} autoFocus={autoFocus} defaultOpen={autoFocus && !!onCommit} onClose={onCommit} value={value ?? ""} clearable="None"
          options={(field.options.choices ?? []).map((c) => ({ value: c.value, label: c.label, dot: dot(c.color) }))} onChange={(v) => onChange(v || null)} />
      );
    case "multi_select":
      return <ChoiceToggles field={field} value={value ?? []} onChange={onChange} />;
    case "relation":
      return <RelationPicker id={id} field={field} value={value} refs={refs} onChange={onChange} />;
    default:
      return <input {...common} type={field.type === "email" ? "email" : "text"} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}
