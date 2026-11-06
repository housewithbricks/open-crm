import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Button, Card, ColorSwatches, ErrorBox, Link2, ObjIcon, PageHead, Segmented } from "../components/ui";
import { api, invalidateAll } from "../lib/api";
import { cn, objColor } from "../lib/format";
import { useSchema } from "../lib/schema";
import { ACCENTS, useAppearance, useSaveAppearance } from "../lib/theme";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-4 border-b border-line py-4 first:pt-0 last:border-0 last:pb-0 max-md:grid-cols-1 max-md:gap-2">
      <div className="pt-1.5 font-medium text-ink-2">{label}{hint && <small className="mt-0.5 block font-normal text-muted">{hint}</small>}</div>
      <div>{children}</div>
    </div>
  );
}

export default function Appearance() {
  const ui = useAppearance();
  const save = useSaveAppearance();
  const navigate = useNavigate();
  const { data: schema } = useSchema();
  const setObjColor = useMutation({
    mutationFn: ({ slug, color }: { slug: string; color: string }) => api(`/objects/${slug}`, { method: "PATCH", body: { color } }),
    onSuccess: invalidateAll,
  });
  if (!ui) return null;
  const custom = !ACCENTS.some((a) => a.hex === ui.accent);
  const ring = "ring-2 ring-ink ring-offset-2 ring-offset-bg";

  return (
    <div className="max-w-[760px]">
      <PageHead title="Appearance" />
      <Card>
        <Row label="Theme">
          <Segmented value={ui.theme} onChange={(theme) => save.mutate({ theme })}
            options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          <p className="mt-1 mb-0 text-xs text-muted">System follows your device and switches automatically.</p>
        </Row>
        <Row label="Accent color" hint="Buttons, links, selection and focus">
          <div className="flex flex-wrap items-center gap-1.5">
            {ACCENTS.map((a) => (
              <button key={a.hex} type="button" title={a.name} onClick={() => save.mutate({ accent: a.hex })}
                className={cn("size-7 rounded-full transition-transform hover:scale-110", ui.accent === a.hex && ring)} style={{ background: a.hex }} />
            ))}
            <label title="Custom color" className={cn("relative size-7 cursor-pointer overflow-hidden rounded-full", custom && ring)}
              style={{ background: custom ? ui.accent : "conic-gradient(#ef4444,#f59e0b,#22c55e,#14b8a6,#3b82f6,#8b5cf6,#ec4899,#ef4444)" }}>
              <input type="color" value={ui.accent} onChange={(e) => save.mutate({ accent: e.target.value })} aria-label="Custom accent color"
                className="absolute inset-0 size-full cursor-pointer opacity-0" />
            </label>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary">Primary button</Button>
            <Link2>A link</Link2>
            <input type="checkbox" checked readOnly aria-label="Example checkbox" />
          </div>
        </Row>
        <Row label="Object colors" hint="Used in links, search and the sidebar">
          {schema?.objects.map((o) => (
            <div key={o.slug} className="flex items-center gap-2 py-1">
              <span className="inline-flex w-[150px] items-center gap-2"><ObjIcon slug={o.slug} />{o.label_plural}</span>
              <ColorSwatches value={objColor(o)} onChange={(color) => setObjColor.mutate({ slug: o.slug, color })} />
            </div>
          ))}
          <p className="mt-1 mb-0 text-xs text-muted">
            Option colors (like deal stages) are set per field in <Link2 onClick={() => navigate({ to: "/settings/objects" })}>Objects &amp; fields</Link2>.
          </p>
        </Row>
        <ErrorBox error={save.error || setObjColor.error} />
      </Card>
    </div>
  );
}
