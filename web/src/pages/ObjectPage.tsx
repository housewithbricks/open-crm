import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import FieldsTab, { AddFieldModal } from "../components/FieldsTab";
import FilterBar, { isComplete } from "../components/FilterBar";
import { FieldInput, FieldValue } from "../components/fields";
import ImportModal from "../components/ImportModal";
import StageEditor from "../components/StageEditor";
import { Select } from "../components/select";
import { Table, Td, Th, Tr } from "../components/table";
import { Button, btnClass, ErrorBox, Label, Modal, ModalActions, ObjIcon, PageHead, Segmented, inputClass } from "../components/ui";
import { api, invalidateAll, type CrmRecord, type FieldDef, type ObjectType, type RecordList, type SavedView, type ViewConfig } from "../lib/api";
import { cn, dot, fmtDate, fmtMoney } from "../lib/format";
import { useOpenRecord } from "../lib/nav";
import { useObject } from "../lib/schema";
import type { ObjectSearch } from "../routes/o.$slug";

function defaultKind(slug: string): "table" | "board" {
  try {
    const k = localStorage.getItem(`kind:${slug}`);
    if (k === "table" || k === "board") return k;
  } catch {}
  return slug === "deals" ? "board" : "table";
}

const sameCfg = (a: ViewConfig, b: ViewConfig) => {
  const n = (c: ViewConfig) => JSON.stringify({ kind: c.kind ?? "table", q: c.q || "", filters: (c.filters ?? []).filter(isComplete), sort: c.sort ?? "", dir: c.sort ? c.dir ?? "desc" : "", group_by: c.group_by ?? "" });
  return n(a) === n(b);
};

const tabClass = (on: boolean) =>
  cn("-mb-px h-[34px] border-b-2 font-medium", on ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink");

export default function ObjectPage() {
  const { slug } = useParams({ from: "/o/$slug" });
  const search = useSearch({ from: "/o/$slug" });
  const navigate = useNavigate({ from: "/o/$slug" });
  const obj = useObject(slug);
  const { data: views } = useQuery({ queryKey: ["views", slug], queryFn: () => api<SavedView[]>(`/objects/${slug}/views`) });
  const active = views?.find((v) => v.id === search.v);
  const hasSelect = !!obj?.fields.some((f) => f.type === "select");
  const tab = search.tab === "fields" ? "fields" : "records";
  const setSearch = (patch: Partial<ObjectSearch>) => navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const [cfg, setCfg] = useState<ViewConfig>({ kind: defaultKind(slug) });
  const [modal, setModal] = useState<"new" | "import" | "stages" | null>(null);

  // Saved view, or filters/kind passed in the URL (e.g. a drill-down from Home).
  const linkKey = JSON.stringify([search.f ?? null, search.k ?? null]);
  useEffect(() => {
    if (active) setCfg({ kind: "table", ...active.config });
    else if (!search.v) setCfg({ kind: search.k ?? (search.f ? "table" : defaultKind(slug)), ...(search.f ? { filters: search.f } : {}) });
  }, [slug, search.v, active?.id, linkKey]);

  const selectView = (id: string | null) => navigate({ search: id ? { v: id } : {} });
  const setKind = (kind: "table" | "board") => {
    setCfg((c) => ({ ...c, kind }));
    if (!active) try { localStorage.setItem(`kind:${slug}`, kind); } catch {}
  };

  const config = () => ({ ...cfg, filters: cfg.filters?.filter(isComplete) });
  const saveNew = useMutation({
    mutationFn: (name: string) => api<SavedView>(`/objects/${slug}/views`, { body: { name, config: config() } }),
    onSuccess: (v) => { invalidateAll(); selectView(v.id); },
  });
  const saveExisting = useMutation({
    mutationFn: () => api(`/views/${active!.id}`, { method: "PATCH", body: { config: config() } }),
    onSuccess: invalidateAll,
  });
  const removeView = useMutation({
    mutationFn: () => api(`/views/${active!.id}`, { method: "DELETE" }),
    onSuccess: () => { invalidateAll(); selectView(null); },
  });

  if (!obj) return <div className="text-muted">Loading…</div>;
  const kind = cfg.kind === "board" && hasSelect ? "board" : "table";
  const dirty = active ? !sameCfg(cfg, active.config) : (cfg.filters?.filter(isComplete).length ?? 0) > 0 || !!cfg.q || !!cfg.sort;

  return (
    <>
      <PageHead title={<><ObjIcon slug={obj.slug} size={24} />{obj.label_plural}</>}>
        <Button variant={tab === "fields" ? "default" : "ghost"} title="Fields, colors and object settings"
          onClick={() => setSearch({ tab: tab === "fields" ? undefined : "fields" })}>
          {tab === "fields" ? "Done" : "Customize"}
        </Button>
        <Button variant="ghost" onClick={() => setModal("import")}>Import</Button>
        <a className={btnClass("ghost")} href={`/api/objects/${slug}/export.csv`}>Export</a>
        <Button variant="primary" onClick={() => setModal("new")}>New {obj.label.toLowerCase()}</Button>
      </PageHead>

      <div className="mb-3 flex flex-wrap items-center gap-[18px] border-b border-line">
        <button type="button" className={tabClass(tab === "records" && !active)} onClick={() => selectView(null)}>All {obj.label_plural.toLowerCase()}</button>
        {views?.map((v) => (
          <button key={v.id} type="button" className={tabClass(tab === "records" && active?.id === v.id)} onClick={() => selectView(v.id)}
            title={v.created_by !== "You" ? `Created by ${v.created_by}` : undefined}>
            {v.name}
          </button>
        ))}
        {tab === "records" && dirty && (
          <span className="-ml-1.5 flex gap-1.5">
            {active && <Button size="sm" onClick={() => saveExisting.mutate()}>Update “{active.name}”</Button>}
            <Button size="sm" onClick={() => { const n = prompt("Name this view"); if (n?.trim()) saveNew.mutate(n.trim()); }}>Save as view</Button>
          </span>
        )}
        {tab === "records" && active && !dirty && (
          <Button size="sm" variant="ghost" className="-ml-1.5 text-danger" onClick={() => confirm(`Delete view “${active.name}”?`) && removeView.mutate()}>Delete view</Button>
        )}
        <div className="flex-1" />
        <button type="button" className={tabClass(tab === "fields")} onClick={() => setSearch({ tab: "fields" })}>Fields &amp; settings</button>
      </div>

      {tab === "records" && (
        <div className="mb-3 flex flex-wrap items-start gap-2">
          <input className={cn(inputClass, "w-[220px]")} placeholder="Search…" value={cfg.q ?? ""} onChange={(e) => setCfg((c) => ({ ...c, q: e.target.value }))} />
          <FilterBar obj={obj} filters={cfg.filters ?? []} onChange={(filters) => setCfg((c) => ({ ...c, filters }))} />
          <div className="flex-1" />
          {kind === "board" && <GroupBy obj={obj} cfg={cfg} onGroup={(group_by) => setCfg((c) => ({ ...c, group_by }))} />}
          {kind === "board" && <Button variant="ghost" onClick={() => setModal("stages")}>Edit stages</Button>}
          {hasSelect && <Segmented value={kind} onChange={setKind} options={[{ value: "table", label: "Table" }, { value: "board", label: "Board" }]} />}
        </div>
      )}
      <ErrorBox error={saveNew.error || saveExisting.error} />

      {tab === "records" && kind === "table" && <TableView obj={obj} cfg={cfg} onSort={(sort, dir) => setCfg((c) => ({ ...c, sort, dir }))} />}
      {tab === "records" && kind === "board" && <BoardView obj={obj} cfg={cfg} />}
      {tab === "fields" && <FieldsTab obj={obj} />}
      {modal === "new" && <NewRecordModal obj={obj} onClose={() => setModal(null)} />}
      {modal === "import" && <ImportModal obj={obj} onClose={() => setModal(null)} />}
      {modal === "stages" && groupField(obj, cfg) && <StageEditor obj={obj} field={groupField(obj, cfg)!} onClose={() => setModal(null)} />}
    </>
  );
}

const PAGE = 200;

/** Query string for the current search and complete filters (shared by records and board totals). */
function queryParams(cfg: ViewConfig) {
  const params: Record<string, string> = {};
  if (cfg.q) params.q = cfg.q;
  const ready = cfg.filters?.filter(isComplete) ?? [];
  if (ready.length) params.filters = JSON.stringify(ready);
  return params;
}

/** Records page by page; loadMore appends the next page (the server caps a page at 500). */
function useRecords(obj: ObjectType, cfg: ViewConfig) {
  const params = queryParams(cfg);
  if (cfg.sort) { params.sort = cfg.sort; params.dir = cfg.dir ?? "desc"; }
  const qs = new URLSearchParams(params).toString();
  const q = useInfiniteQuery({
    queryKey: ["records", obj.slug, qs],
    queryFn: ({ pageParam }) => api<RecordList>(`/objects/${obj.slug}/records?${qs}&limit=${PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.records.length, 0);
      return loaded < last.total && last.records.length ? loaded : undefined;
    },
    placeholderData: (prev) => prev,
  });
  const data = useMemo<RecordList | undefined>(() => {
    const pages = q.data?.pages;
    if (!pages?.length) return undefined;
    return {
      object: obj.slug,
      total: pages[pages.length - 1].total,
      records: pages.flatMap((p) => p.records),
      refs: Object.assign({}, ...pages.map((p) => p.refs)),
    };
  }, [q.data, obj.slug]);
  return { data, error: q.error, hasMore: !!q.hasNextPage, loadMore: () => q.fetchNextPage(), loadingMore: q.isFetchingNextPage };
}

function LoadMore({ shown, total, onMore, busy, noun }: { shown: number; total: number; onMore: () => void; busy: boolean; noun: string }) {
  return (
    <p className="mt-2 flex items-center gap-3 text-xs text-muted">
      {shown < total ? `Showing ${shown} of ${total}` : `${total} ${noun}`}
      {shown < total && <Button size="sm" onClick={onMore} disabled={busy}>{busy ? "Loading…" : `Load ${Math.min(PAGE, total - shown)} more`}</Button>}
    </p>
  );
}

const isNum = (f?: FieldDef) => f?.type === "number" || f?.type === "currency";

function TableView({ obj, cfg, onSort }: { obj: ObjectType; cfg: ViewConfig; onSort: (sort: string, dir: "asc" | "desc") => void }) {
  const sort = { key: cfg.sort ?? "updated_at", dir: cfg.dir ?? "desc" };
  const { data, error, loadMore, loadingMore } = useRecords(obj, cfg);
  const openRecord = useOpenRecord();
  const cols = obj.fields.filter((f) => f.type !== "long_text").slice(0, 10);
  const [addingField, setAddingField] = useState(false);
  const head = (key: string, label: string, f?: FieldDef) => (
    <Th key={key} num={isNum(f)} onClick={() => onSort(key, sort.key === key && sort.dir === "asc" ? "desc" : "asc")}>
      {label}{sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
    </Th>
  );
  const filtered = !!cfg.q || !!cfg.filters?.length;
  return (
    <>
      <ErrorBox error={error} />
      <Table>
        <thead>
          <tr>
            {cols.map((f) => head(f.key, f.label, f))}
            {head("updated_at", "Updated")}
            <Th className="w-10 px-0 text-center">
              <button type="button" title="Add a field" aria-label="Add a field" onClick={() => setAddingField(true)}
                className="size-[26px] rounded-[5px] border border-dashed border-line-2 text-[15px] leading-none text-muted hover:border-solid hover:border-accent hover:text-accent">+</button>
            </Th>
          </tr>
        </thead>
        <tbody>
          {data?.records.map((r) => (
            <Tr key={r.id} onClick={() => openRecord(r.id)} label={`Open ${r.display_name || "(untitled)"}`}>
              {cols.map((f) => (
                <Td key={f.key} num={isNum(f)} className={f.key === obj.primary_field ? "font-medium" : undefined}>
                  <FieldValue field={f} value={r.data[f.key]} refs={data.refs} onOpen={openRecord} />
                </Td>
              ))}
              <Td className="text-muted">{fmtDate(r.updated_at)}</Td>
              <Td />
            </Tr>
          ))}
        </tbody>
      </Table>
      {data && !data.records.length && (
        <div className="py-12 text-center text-muted">
          {filtered ? "Nothing matches these filters." : <>No {obj.label_plural.toLowerCase()} yet. Add one, import a CSV, or connect an agent.</>}
        </div>
      )}
      {addingField && <AddFieldModal obj={obj} onClose={() => setAddingField(false)} />}
      {data && (
        <LoadMore shown={data.records.length} total={data.total} onMore={loadMore} busy={loadingMore}
          noun={data.total === 1 ? obj.label.toLowerCase() : obj.label_plural.toLowerCase()} />
      )}
    </>
  );
}

/** The select field the board groups by (stage, if there is one). */
function groupField(obj: ObjectType, cfg: ViewConfig) {
  const selects = obj.fields.filter((f) => f.type === "select");
  return selects.find((f) => f.key === cfg.group_by) ?? selects.find((f) => f.key === "stage") ?? selects[0];
}

function GroupBy({ obj, cfg, onGroup }: { obj: ObjectType; cfg: ViewConfig; onGroup: (key: string) => void }) {
  const selects = obj.fields.filter((f) => f.type === "select");
  if (selects.length < 2) return null;
  const cur = cfg.group_by ?? selects.find((f) => f.key === "stage")?.key ?? selects[0].key;
  return (
    <Select size="sm" value={cur} ariaLabel="Group by" onChange={(v) => v && onGroup(v)}
      options={selects.map((f) => ({ value: f.key, label: `Group by ${f.label.toLowerCase()}` }))} />
  );
}

function BoardView({ obj, cfg }: { obj: ObjectType; cfg: ViewConfig }) {
  const selects = obj.fields.filter((f) => f.type === "select");
  const groupKey = cfg.group_by ?? selects.find((f) => f.key === "stage")?.key ?? selects[0].key;
  const group = selects.find((f) => f.key === groupKey) ?? selects[0];
  const amountField = obj.fields.find((f) => f.type === "currency");
  const subField = obj.fields.find((f) => f.type === "relation");
  const { data, error, hasMore, loadMore, loadingMore } = useRecords(obj, cfg);
  // Column counts and totals come from the server, so they're right even when not every card is loaded.
  const gqs = new URLSearchParams({ ...queryParams(cfg), field: group.key, ...(amountField ? { sum: amountField.key } : {}) }).toString();
  const { data: groups } = useQuery({
    queryKey: ["records", obj.slug, "groups", gqs],
    queryFn: () => api<{ groups: { value: string | null; count: number; sum: number; known: boolean }[] }>(`/objects/${obj.slug}/groups?${gqs}`),
    placeholderData: (prev) => prev,
  });
  const openRecord = useOpenRecord();
  const [dragOver, setDragOver] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string | null }) => api(`/records/${id}`, { method: "PATCH", body: { [group.key]: value } }),
    onSettled: invalidateAll,
  });

  const columns = useMemo(() => {
    type Col = { value: string | null; label: string; color?: string; probability?: number; unknown?: boolean };
    const cols: Col[] = [
      ...(group.options.choices ?? []).map((c) => ({ value: c.value as string | null, label: c.label, color: c.color, probability: c.kind === "open" || !c.kind ? c.probability : undefined })),
      // Values that are no longer options (e.g. a removed stage) still hold records: show them so they can be moved out.
      ...(groups?.groups ?? []).filter((g) => !g.known && g.value !== null).map((g) => ({ value: g.value, label: g.value!, color: "gray", unknown: true })),
      { value: null, label: "No " + group.label.toLowerCase(), color: "gray" },
    ];
    return cols.map((c) => {
      const records = (data?.records ?? []).filter((r) => (r.data[group.key] ?? null) === c.value);
      const g = groups?.groups.find((x) => x.value === c.value);
      const count = g?.count ?? records.length;
      const amount = g ? g.sum : amountField ? records.reduce((s, r) => s + (Number(r.data[amountField.key]) || 0), 0) : 0;
      return { ...c, records, count, amount };
    });
  }, [data, groups, group, amountField]);

  return (
    <>
      <ErrorBox error={error} />
      <div className="flex items-start gap-3 overflow-x-auto pb-3">
        {columns.filter((c) => (c.value !== null && !c.unknown) || c.count).map((c) => {
          const key = c.value ?? "_none";
          const droppable = !c.unknown; // a removed option can't be set again
          return (
            <div key={key}
              className={cn("min-h-40 w-[264px] flex-none rounded-lg p-0.5", dragOver === key && "bg-accent-soft")}
              onDragOver={droppable ? (e) => { e.preventDefault(); setDragOver(key); } : undefined}
              onDragLeave={() => setDragOver(null)}
              onDrop={droppable ? (e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData("text/plain");
                const rec = data?.records.find((r) => r.id === id);
                if (rec && (rec.data[group.key] ?? null) !== c.value) move.mutate({ id, value: c.value });
              } : undefined}>
              <h4 className="m-0 mb-2 flex items-center gap-[7px] px-1.5 py-1 text-[13px] font-medium" title={c.unknown ? "No longer an option. Move these to another column." : undefined}>
                <i className="size-2 rounded-full" style={{ background: dot(c.color) }} />
                <span className={cn(c.unknown && "text-muted italic")}>{c.label}</span>
                <span className="font-normal text-faint">{c.count}</span>
                {c.probability !== undefined && <span className="rounded bg-hover px-1 text-[11px] font-normal text-muted" title="Win probability">{c.probability}%</span>}
                {amountField && c.count > 0 && <span className="ml-auto font-normal text-muted tabular-nums">{fmtMoney(c.amount, amountField.options.currency)}</span>}
              </h4>
              {c.unknown && <p className="m-0 mb-2 px-1.5 text-xs text-muted">Removed option. Drag these to another column.</p>}
              {!c.count && <div className="grid h-16 place-items-center rounded-lg border border-dashed border-line-2 text-xs text-faint">Drop here</div>}
              {c.records.map((r) => (
                <div key={r.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)} onClick={() => openRecord(r.id)}
                  role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); openRecord(r.id); } }}
                  className="mb-2 cursor-grab rounded-lg border border-line bg-panel px-3 py-2.5 transition-colors hover:border-line-2 hover:shadow-[0_1px_3px_rgba(0,0,0,.05)] focus-visible:outline-2 focus-visible:outline-accent">
                  <b className="mb-1 block font-medium">{r.display_name || "(untitled)"}</b>
                  <div className="flex justify-between gap-2 text-xs text-muted">
                    <span>{subField && r.data[subField.key] ? data?.refs[r.data[subField.key]]?.display_name : ""}</span>
                    <span className="text-ink-2 tabular-nums">{amountField && r.data[amountField.key] != null && fmtMoney(r.data[amountField.key], amountField.options.currency)}</span>
                  </div>
                </div>
              ))}
              {c.records.length < c.count && (
                <div className="px-1.5 text-xs text-muted">
                  Showing {c.records.length} of {c.count}.{" "}
                  {hasMore && <button type="button" className="text-accent hover:underline" disabled={loadingMore} onClick={() => loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {data && hasMore && <LoadMore shown={data.records.length} total={data.total} onMore={loadMore} busy={loadingMore} noun="" />}
      <ErrorBox error={move.error} />
    </>
  );
}

function NewRecordModal({ obj, onClose }: { obj: ObjectType; onClose: () => void }) {
  const [data, setData] = useState<Record<string, any>>({});
  const openRecord = useOpenRecord();
  const create = useMutation({
    mutationFn: () => api<CrmRecord>(`/objects/${obj.slug}/records`, { body: data }),
    onSuccess: (r) => { invalidateAll(); onClose(); openRecord(r.id); },
  });
  return (
    <Modal title={`New ${obj.label.toLowerCase()}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        {obj.fields.map((f, i) => (
          <div key={f.key}>
            <Label>{f.label}{f.required && " *"}</Label>
            <FieldInput field={f} value={data[f.key]} autoFocus={i === 0} onChange={(v) => setData((d) => ({ ...d, [f.key]: v }))} />
          </div>
        ))}
        <ErrorBox error={create.error} />
        <ModalActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>Create</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
