import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch, type LinkProps } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { api, invalidateAll, type ChangeRequest, type Ref } from "../lib/api";
import { cn } from "../lib/format";
import { useOpenRecord } from "../lib/nav";
import { useSchema } from "../lib/schema";
import { useAppearance } from "../lib/theme";
import NewObjectModal from "./NewObjectModal";
import RecordDrawer from "./RecordDrawer";
import { Mark, Modal, ObjIcon } from "./ui";

const navItem = "flex h-[30px] items-center justify-between gap-1.5 rounded-ctl px-2 text-ink-2 hover:bg-hover hover:text-ink";
const navActive = { className: "bg-active text-ink font-medium" };

function NavItem(props: LinkProps & { children: ReactNode }) {
  return <Link {...props} className={navItem} activeProps={navActive} activeOptions={{ exact: props.to === "/", includeSearch: false }} />;
}

const Section = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="flex items-center justify-between px-2 pt-4 pb-1 text-xs text-muted max-md:hidden">{children}{action}</div>
);

/** Signed-in app frame: sidebar, page outlet, record drawer, ⌘K search. */
export default function Shell({ children }: { children: ReactNode }) {
  useAppearance();
  const { data: schema } = useSchema();
  const { data: pending } = useQuery({ queryKey: ["changes", "pending"], queryFn: () => api<ChangeRequest[]>("/changes?status=pending"), refetchInterval: 30_000 });
  const { data: tasks } = useQuery({ queryKey: ["tasks"], queryFn: () => api<unknown[]>("/tasks") });
  const search = useSearch({ strict: false }) as { r?: string };
  const openRecord = useOpenRecord();
  const [cmdk, setCmdk] = useState(false);
  const [newObj, setNewObj] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdk((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div className="grid h-full grid-cols-[224px_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[auto_1fr]">
      <nav className="flex flex-col gap-px overflow-y-auto border-r border-line bg-sidebar px-2 py-3 max-md:flex-row max-md:items-center max-md:border-r-0 max-md:border-b max-md:p-1.5 max-md:[&>*]:flex-none">
        <div className="flex items-center gap-2 px-2 pt-1 pb-3 text-sm font-semibold max-md:p-1.5"><Mark size={20} /><span className="max-md:hidden">Open CRM</span></div>
        <button type="button" className={cn(navItem, "max-md:hidden")} onClick={() => setCmdk(true)}>Search <kbd className="font-sans text-[11px] text-faint">⌘K</kbd></button>
        <button type="button" className={cn(navItem, "md:hidden")} aria-label="Search" title="Search" onClick={() => setCmdk(true)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" strokeLinecap="round" /></svg>
        </button>
        <NavItem to="/">Home</NavItem>
        <NavItem to="/tasks">Tasks {!!tasks?.length && <small className="text-xs text-faint tabular-nums">{tasks.length}</small>}</NavItem>
        <NavItem to="/approvals">
          Approvals {!!pending?.length && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-ink">{pending.length}</span>}
        </NavItem>
        <Section action={<button type="button" title="New object" className="text-[15px] leading-none text-muted hover:text-ink" onClick={() => setNewObj(true)}>+</button>}>Objects</Section>
        {schema?.objects.map((o) => (
          <NavItem key={o.slug} to="/o/$slug" params={{ slug: o.slug }}>
            <span className="inline-flex min-w-0 items-center gap-2"><ObjIcon slug={o.slug} />{o.label_plural}</span>
            <small className="text-xs text-faint tabular-nums">{schema.counts[o.slug] ?? 0}</small>
          </NavItem>
        ))}
        <Section>Settings</Section>
        <NavItem to="/settings/objects">Objects &amp; fields</NavItem>
        <NavItem to="/settings/appearance">Appearance</NavItem>
        <NavItem to="/settings/keys">API keys &amp; MCP</NavItem>
        <NavItem to="/settings/webhooks">Webhooks</NavItem>
        <NavItem to="/settings/audit">Audit log</NavItem>
        <div className="flex-1" />
        <button type="button" className={cn(navItem, "text-muted")} onClick={async () => { await api("/logout", { body: {} }); invalidateAll(); }}>Sign out</button>
      </nav>
      <main className="h-full min-w-0 overflow-auto">
        <div className="max-w-[1280px] px-7 pt-5 pb-12 max-md:p-4">{children}</div>
      </main>
      {search.r && <RecordDrawer id={search.r} onClose={() => openRecord(null)} />}
      {cmdk && <CommandK onClose={() => setCmdk(false)} />}
      {newObj && <NewObjectModal onClose={() => setNewObj(false)} />}
    </div>
  );
}

function CommandK({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const { data: schema } = useSchema();
  const { data } = useQuery({
    queryKey: ["search", q],
    queryFn: () => api<(Ref & { label: string })[]>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
  });
  const objects = (schema?.objects ?? []).filter((o) => o.label_plural.toLowerCase().includes(q.toLowerCase()));
  const items = [
    ...(q ? (data ?? []).map((r) => ({ key: r.id, label: r.display_name || "(untitled)", hint: r.label, slug: r.object, go: () => navigate({ to: "/o/$slug", params: { slug: r.object }, search: { r: r.id } }) })) : []),
    ...objects.map((o) => ({ key: o.slug, label: `Go to ${o.label_plural}`, hint: "Object", slug: o.slug, go: () => navigate({ to: "/o/$slug", params: { slug: o.slug } }) })),
  ];
  return (
    <Modal onClose={onClose} bare>
      <div className="w-[min(560px,calc(100vw-32px))]">
        <input autoFocus placeholder="Search people, companies, deals…" value={q}
          className="h-12 w-full border-0 border-b border-line bg-transparent px-4 text-[15px] outline-none placeholder:text-faint"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, items.length - 1));
            if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            if (e.key === "Enter" && items[sel]) { items[sel].go(); onClose(); }
          }} />
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.map((it, i) => (
            <div key={it.key} onMouseEnter={() => setSel(i)} onClick={() => { it.go(); onClose(); }}
              className={cn("flex h-9 cursor-pointer items-center justify-between rounded-ctl px-2.5", i === sel && "bg-hover")}>
              <span className="inline-flex min-w-0 items-center gap-2.5"><ObjIcon slug={it.slug} size={18} />{it.label}</span>
              <span className="text-xs text-faint">{it.hint}</span>
            </div>
          ))}
          {q && data && !data.length && <div className="px-2.5 py-2 text-muted">No matches</div>}
          {!q && !items.length && <div className="px-2.5 py-2 text-muted">Type to search</div>}
        </div>
      </div>
    </Modal>
  );
}
