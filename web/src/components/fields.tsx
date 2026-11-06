import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type FieldDef, type RecordList, type Ref } from "../lib/api";
import { cn, dot, fmtDate, fmtMoney } from "../lib/format";
import { Select } from "./select";
import { inputClass, refClass, Tag } from "./ui";

export function ChoiceTag({ field, value }: { field: FieldDef; value: string }) {
  const c = field.options.choices?.find((x) => x.value === value);
  return <Tag label={c?.label ?? value} color={c?.color} />;
}

/** Toggleable option list used by multi-select inputs and filters. */
export function ChoiceToggles({ field, value, onChange }: { field: FieldDef; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
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
      return <>{fmtDate(value)}</>;
    case "boolean":
      return <>{value ? "Yes" : "No"}</>;
    case "select":
      return <ChoiceTag field={field} value={value} />;
    case "multi_select":
      return <>{(value as string[]).map((v) => <ChoiceTag key={v} field={field} value={v} />)}</>;
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
              <span className={refClass} onClick={(e) => { e.stopPropagation(); onOpen?.(id); }}>{refs?.[id]?.display_name || "(missing)"}</span>
            </span>
          ))}
        </>
      );
    }
    default:
      return <>{String(value)}</>;
  }
}

export function RelationPicker({ field, value, refs, onChange }: { field: FieldDef; value: any; refs?: Record<string, Ref>; onChange: (v: any) => void }) {
  const [q, setQ] = useState("");
  const { data } = useQuery({
    queryKey: ["records", field.options.target, { q, limit: 8 }],
    queryFn: () => api<RecordList>(`/objects/${field.options.target}/records?limit=8&q=${encodeURIComponent(q)}`),
  });
  const many = !!field.options.multiple;
  const selected: string[] = value ? (Array.isArray(value) ? value : [value]) : [];
  const nameOf = (id: string) => refs?.[id]?.display_name ?? data?.records.find((r) => r.id === id)?.display_name ?? "…";
  return (
    <div>
      {selected.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selected.map((id) => (
            <span key={id} className="inline-flex h-[26px] items-center gap-1 rounded-ctl border border-line-2 bg-panel pl-2 text-xs">
              {nameOf(id)}
              <button type="button" aria-label="Remove" className="size-5 rounded text-faint hover:bg-hover hover:text-ink" onClick={() => onChange(many ? selected.filter((x) => x !== id) : null)}>×</button>
            </span>
          ))}
        </div>
      )}
      <input className={inputClass} autoFocus placeholder={`Search ${field.options.target}…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-1 max-h-[200px] overflow-y-auto">
        {data?.records.filter((r) => !selected.includes(r.id)).map((r) => (
          <div key={r.id} className="flex h-[30px] cursor-pointer items-center rounded-ctl px-2 hover:bg-hover"
            onMouseDown={(e) => { e.preventDefault(); onChange(many ? [...selected, r.id] : r.id); }}>
            {r.display_name}
          </div>
        ))}
      </div>
    </div>
  );
}

export function FieldInput({ field, value, refs, onChange, onCommit, autoFocus }: {
  field: FieldDef; value: any; refs?: Record<string, Ref>; onChange: (v: any) => void; onCommit?: () => void; autoFocus?: boolean;
}) {
  const key = (e: React.KeyboardEvent) => { if (e.key === "Enter" && field.type !== "long_text") onCommit?.(); };
  const common = { className: inputClass, autoFocus, onBlur: onCommit, onKeyDown: key };
  switch (field.type) {
    case "long_text":
      return <textarea {...common} className={cn(inputClass, "h-auto min-h-[72px] py-2")} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "number":
    case "currency":
      return <input {...common} type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "date":
      return <input {...common} type="date" value={value ? String(value).slice(0, 10) : ""} onChange={(e) => onChange(e.target.value || null)} />;
    case "boolean":
      return (
        <Select autoFocus={autoFocus} defaultOpen={autoFocus && !!onCommit} onClose={onCommit} value={value === true ? "true" : value === false ? "false" : ""} clearable="Not set"
          options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} onChange={(v) => onChange(v === "" ? null : v === "true")} />
      );
    case "select":
      return (
        <Select autoFocus={autoFocus} defaultOpen={autoFocus && !!onCommit} onClose={onCommit} value={value ?? ""} clearable="None"
          options={(field.options.choices ?? []).map((c) => ({ value: c.value, label: c.label, dot: dot(c.color) }))} onChange={(v) => onChange(v || null)} />
      );
    case "multi_select":
      return <ChoiceToggles field={field} value={value ?? []} onChange={onChange} />;
    case "relation":
      return <RelationPicker field={field} value={value} refs={refs} onChange={onChange} />;
    default:
      return <input {...common} type={field.type === "email" ? "email" : "text"} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}
