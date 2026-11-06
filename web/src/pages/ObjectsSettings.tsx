import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { TYPE_INFO } from "../components/FieldsTab";
import NewObjectModal from "../components/NewObjectModal";
import { Button, ObjIcon, PageHead, Who } from "../components/ui";
import { dot, tint } from "../lib/format";
import { useSchema } from "../lib/schema";

const MAX_PILLS = 7;

export default function ObjectsSettings() {
  const { data: schema } = useSchema();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  return (
    <div className="max-w-[1080px]">
      <PageHead title="Objects & fields" desc="Each object is a kind of record with its own fields. Open one to rename it, recolor it, or add and edit fields.">
        <Button variant="primary" onClick={() => setCreating(true)}>New object</Button>
      </PageHead>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
        {schema?.objects.map((o) => {
          const extra = o.fields.length - MAX_PILLS;
          const n = schema.counts[o.slug] ?? 0;
          return (
            <button key={o.slug} type="button" onClick={() => navigate({ to: "/o/$slug", params: { slug: o.slug }, search: { tab: "fields" } })}
              className="flex flex-col gap-3 rounded-[10px] border border-line bg-panel p-4 text-left transition hover:border-[color-mix(in_srgb,var(--accent)_50%,var(--line))] hover:shadow-[0_1px_3px_rgba(0,0,0,.06)]">
              <div className="flex items-center gap-3">
                <ObjIcon slug={o.slug} size={32} />
                <span className="text-[15px] font-semibold tracking-[-0.01em]">{o.label_plural}</span>
                <span className="ml-auto text-xs whitespace-nowrap text-muted"><b className="mr-0.5 text-sm font-semibold text-ink tabular-nums">{n}</b>{n === 1 ? "record" : "records"}</span>
              </div>
              {o.description && <p className="-mt-1 mb-0 line-clamp-2 text-muted">{o.description}</p>}
              <div className="flex flex-wrap gap-1.5">
                {o.fields.slice(0, MAX_PILLS).map((f) => {
                  const t = TYPE_INFO.find((x) => x.type === f.type);
                  const c = dot(t?.color);
                  return (
                    <span key={f.key} title={t?.label} className="inline-flex h-6 items-center gap-1.5 rounded-ctl bg-hover pr-2 pl-1 text-xs whitespace-nowrap text-ink-2">
                      <span className="grid size-4 place-items-center rounded font-mono text-[10px] font-semibold" style={{ color: c, background: tint(c) }}>{t?.glyph}</span>
                      {f.label}
                    </span>
                  );
                })}
                {extra > 0 && <span className="inline-flex h-6 items-center rounded-ctl border border-dashed border-line-2 px-2 text-xs text-muted">+{extra} more</span>}
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
                <span>{o.fields.length} fields · by <Who name={o.created_by} /></span>
                <span className="font-medium text-accent">Edit →</span>
              </div>
            </button>
          );
        })}
        <button type="button" onClick={() => setCreating(true)}
          className="flex min-h-40 flex-col items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line bg-panel p-4 text-muted hover:text-accent">
          <span className="text-[22px] leading-none">+</span>
          New object
          <span className="text-xs">e.g. Investors, Projects, Properties</span>
        </button>
      </div>
      {creating && <NewObjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}
