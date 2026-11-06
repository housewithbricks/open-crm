import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api, type Ref } from "../lib/api";
import { cn, dot, objColor } from "../lib/format";
import { useSchema } from "../lib/schema";
import { ObjIcon, refClass } from "./ui";

/** "Name · Object" references to records of any object, optionally removable. */
export function LinkChips({ links, onRemove, exclude }: { links: Ref[]; onRemove?: (id: string) => void; exclude?: string }) {
  const { data: schema } = useSchema();
  const navigate = useNavigate();
  const obj = (slug: string) => schema?.objects.find((o) => o.slug === slug);
  const shown = links.filter((l) => l.id !== exclude);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((l) => {
        const c = dot(objColor(obj(l.object), l.object));
        return (
          <span key={l.id} className={cn("inline-flex h-[22px] max-w-[260px] items-center gap-1.5 whitespace-nowrap rounded-[5px] border pl-2 text-xs", onRemove ? "pr-0.5" : "pr-2")}
            style={{ borderColor: `color-mix(in srgb, ${c} 30%, var(--line-2))`, background: `color-mix(in srgb, ${c} 9%, var(--panel))` }}>
            <i className="size-[7px] flex-none rounded-full" style={{ background: c }} />
            <span className={cn(refClass, "overflow-hidden text-ellipsis")}
              onClick={(e) => { e.stopPropagation(); navigate({ to: "/o/$slug", params: { slug: l.object }, search: { r: l.id } }); }}>
              {l.display_name || "Untitled"}
            </span>
            <span style={{ color: `color-mix(in srgb, ${c} 75%, var(--muted))` }}>{obj(l.object)?.label ?? l.object}</span>
            {onRemove && (
              <button type="button" aria-label="Remove link" className="size-[18px] rounded-[3px] text-faint hover:bg-hover hover:text-ink" onClick={() => onRemove(l.id)}>×</button>
            )}
          </span>
        );
      })}
    </>
  );
}

/** Search box that finds records across every object and adds them as links. */
export function LinkPicker({ value, onChange, placeholder = "Link a record…" }: { value: Ref[]; onChange: (v: Ref[]) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const { data: schema } = useSchema();
  const { data } = useQuery({
    queryKey: ["search", q],
    queryFn: () => api<(Ref & { label: string })[]>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
  });
  const results = (data ?? []).filter((r) => !value.some((v) => v.id === r.id)).slice(0, 8);

  useEffect(() => {
    const h = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const add = (r: Ref) => {
    onChange([...value, { id: r.id, object: r.object, display_name: r.display_name }]);
    setQ("");
    setSel(0);
  };

  return (
    <div ref={box} className="relative flex min-w-[180px] flex-1 flex-wrap items-center gap-1">
      <LinkChips links={value} onRemove={(id) => onChange(value.filter((v) => v.id !== id))} />
      <input value={q} placeholder={placeholder}
        className="h-[26px] min-w-[120px] flex-1 border-0 bg-transparent px-1 text-xs outline-none placeholder:text-faint"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          if (e.key === "Enter" && open && results[sel]) { e.preventDefault(); add(results[sel]); }
          if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
          if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
        }} />
      {open && q.trim() && (
        <div className="animate-menu absolute top-[calc(100%+4px)] left-0 z-30 w-80 max-w-[90vw] rounded-lg border border-line bg-panel p-1 shadow-pop">
          {results.map((r, i) => (
            <div key={r.id} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); add(r); }}
              className={cn("flex h-8 cursor-pointer items-center justify-between gap-3 rounded-[5px] px-2", i === sel && "bg-hover")}>
              <span className="inline-flex min-w-0 items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap"><ObjIcon slug={r.object} size={16} />{r.display_name || "Untitled"}</span>
              <span className="text-muted">{schema?.objects.find((o) => o.slug === r.object)?.label ?? r.object}</span>
            </div>
          ))}
          {data && !results.length && <div className="px-2 py-2 text-muted">No matches</div>}
        </div>
      )}
    </div>
  );
}

