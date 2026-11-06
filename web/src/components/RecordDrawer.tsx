import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, invalidateAll, type FieldDef, type RecordDetail, type Ref, type TimelineItem } from "../lib/api";
import { cn, fmtDate, timeAgo } from "../lib/format";
import { useObject } from "../lib/schema";
import { undoEntry } from "../lib/undo";
import { FieldInput, FieldValue } from "./fields";
import { LinkChips, LinkPicker } from "./links";
import { Select } from "./select";
import { Avatar, Button, DueDate, ErrorBox, List, ObjIcon, Pill, Who } from "./ui";

export default function RecordDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ["record", id], queryFn: () => api<RecordDetail>(`/records/${id}`) });
  const obj = useObject(data?.record.object);
  const navigate = useNavigate();
  const open = (rid: string, slug: string) => navigate({ to: "/o/$slug", params: { slug }, search: { r: rid } });

  useEffect(() => {
    // Esc closes the drawer, unless a dialog or dropdown on top of it should take it.
    const h = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".select-menu, [data-modal]") && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const archive = useMutation({
    mutationFn: () => api(`/records/${id}`, { method: "DELETE" }),
    onSuccess: () => { invalidateAll(); onClose(); },
  });

  return (
    <>
      <div className="fixed inset-0 z-20 bg-black/20" onClick={onClose} />
      <aside aria-label="Record" className="fixed inset-y-0 right-0 z-21 w-[min(580px,100vw)] overflow-y-auto border-l border-line bg-bg shadow-pop">
        <div className="sticky top-0 z-2 flex h-12 items-center gap-1.5 border-b border-line bg-bg px-4 text-muted">
          <span className="inline-flex items-center gap-2">{obj && <ObjIcon slug={obj.slug} />}{obj?.label ?? "Record"}</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => confirm("Archive this record? You can undo this from the audit log.") && archive.mutate()}>Archive</Button>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">Close</Button>
        </div>
        <div className="px-6 pt-5 pb-10 max-md:p-4">
          <ErrorBox error={error} />
          {data && obj && (
            <>
              <TitleEdit id={id} field={obj.primary_field} value={data.record.display_name} />
              <small className="text-xs text-muted">
                Created by <Who name={data.record.created_by} /> {timeAgo(data.record.created_at)}
                {data.record.updated_at !== data.record.created_at && <> · updated by <Who name={data.record.updated_by} /> {timeAgo(data.record.updated_at)}</>}
              </small>

              <div className="mt-5 mb-2 grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 max-md:grid-cols-[110px_minmax(0,1fr)]">
                {obj.fields.filter((f) => f.key !== obj.primary_field).map((f) => (
                  <EditableField key={f.key} field={f} detail={data} onOpen={(rid) => open(rid, f.options.target!)} />
                ))}
              </div>

              {data.related.map((rel) => (
                <section className="mt-7" key={rel.object + rel.field}>
                  <h3 className="mb-2 flex items-center gap-2 text-[13px]">{rel.label} <span className="font-normal text-muted">{rel.records.length}</span></h3>
                  <List>
                    {rel.records.map((r) => (
                      <button key={r.id} type="button" className="w-full text-left hover:bg-hover" onClick={() => open(r.id, r.object)}>{r.display_name || "Untitled"}</button>
                    ))}
                  </List>
                </section>
              ))}

              <Timeline recordId={id} fields={obj.fields} />
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function TitleEdit({ id, field, value }: { id: string; field: string; value: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const save = useMutation({
    mutationFn: (v: string) => api(`/records/${id}`, { method: "PATCH", body: { [field]: v } }),
    onSuccess: () => { invalidateAll(); setEditing(false); },
  });
  const commit = () => (draft.trim() && draft !== value ? save.mutate(draft.trim()) : setEditing(false));
  if (!editing) {
    return (
      <h2 title="Click to rename" onClick={() => { setDraft(value); setEditing(true); }}
        className="m-0 mb-1 cursor-text rounded text-xl hover:bg-hover hover:shadow-[0_0_0_4px_var(--hover)]">
        {value || "Untitled"}
      </h2>
    );
  }
  return (
    <>
      <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        className="m-0 mb-1 w-full border-0 bg-transparent p-0 text-xl font-semibold tracking-[-0.01em] text-ink outline-none"
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} />
      <ErrorBox error={save.error} />
    </>
  );
}

function EditableField({ field, detail, onOpen }: { field: FieldDef; detail: RecordDetail; onOpen: (id: string) => void }) {
  const value = detail.record.data[field.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(value);
  const save = useMutation({
    mutationFn: (v: any) => api(`/records/${detail.record.id}`, { method: "PATCH", body: { [field.key]: v } }),
    onSuccess: () => { invalidateAll(); setEditing(false); },
  });
  const commit = (v = draft) => {
    if (JSON.stringify(v ?? null) === JSON.stringify(value ?? null)) return setEditing(false);
    save.mutate(v);
  };
  const instant = field.type === "relation" || field.type === "select" || field.type === "boolean" || field.type === "date";
  const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
  return (
    <>
      <div className="py-[7px] text-muted" title={field.description || undefined}>{field.label}</div>
      <div onClick={() => { if (!editing) { setDraft(value); setEditing(true); } }}
        className={cn("-ml-2 min-h-8 rounded-ctl py-[5px] pl-2 [overflow-wrap:anywhere]",
          editing ? "block" : "flex cursor-text flex-wrap items-center hover:bg-hover", empty && !editing && "text-faint")}>
        {editing ? (
          <div onClick={(e) => e.stopPropagation()}>
            <FieldInput field={field} value={draft} refs={detail.refs} autoFocus
              onChange={(v) => { setDraft(v); if (instant) commit(v); }} onCommit={() => commit()} />
            {(field.type === "relation" || field.type === "multi_select") && (
              <div className="mt-1.5 flex gap-2">
                {field.type === "multi_select" && <Button size="sm" variant="primary" onClick={() => commit()}>Save</Button>}
                <Button size="sm" onClick={() => setEditing(false)}>Done</Button>
              </div>
            )}
            <ErrorBox error={save.error} />
          </div>
        ) : empty ? "Empty" : (
          <FieldValue field={field} value={value} refs={detail.refs} onOpen={onOpen} />
        )}
      </div>
    </>
  );
}

function describeChange(item: Extract<TimelineItem, { type: "change" }>, fields: FieldDef[]) {
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? k;
  const show = (k: string, v: any) => {
    if (v == null || v === "") return "empty";
    const f = fields.find((x) => x.key === k);
    if (f?.options.choices) {
      const arr = Array.isArray(v) ? v : [v];
      return arr.map((x) => f.options.choices!.find((c) => c.value === x)?.label ?? x).join(", ");
    }
    if (f?.type === "relation") return "a linked record";
    if (f?.type === "currency") return Number(v).toLocaleString(undefined, { style: "currency", currency: f.options.currency ?? "USD", maximumFractionDigits: 0 });
    if (f?.type === "date") return fmtDate(v);
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  switch (item.action) {
    case "record.create": return { line: "created this record" };
    case "record.archive": return { line: "archived this record" };
    case "record.restore": return { line: "restored this record" };
    case "record.update": {
      const keys = Object.keys(item.after ?? {});
      return {
        line: <>changed {keys.map((k, i) => <span key={k}>{i > 0 && ", "}<b className="font-medium text-ink">{label(k)}</b></span>)}</>,
        diff: keys.map((k) => `${show(k, item.before?.[k])} → ${show(k, item.after[k])}`).join(" · "),
      };
    }
    default: return { line: item.action };
  }
}

const KINDS = ["note", "call", "meeting", "email", "task"] as const;
const KIND_ICON = { note: "✎", call: "☏", meeting: "◷", email: "✉", task: "✓" } as const;

function Timeline({ recordId, fields }: { recordId: string; fields: FieldDef[] }) {
  const { data } = useQuery({ queryKey: ["timeline", recordId], queryFn: () => api<TimelineItem[]>(`/records/${recordId}/timeline`) });
  const [kind, setKind] = useState<(typeof KINDS)[number]>("note");
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [extra, setExtra] = useState<Ref[]>([]);
  const add = useMutation({
    mutationFn: () => api(`/records/${recordId}/activities`, {
      body: { kind, ...(kind === "task" ? { title: text, due_at: due || null } : { body: text }), record_ids: extra.map((l) => l.id) },
    }),
    onSuccess: () => { setText(""); setDue(""); setExtra([]); invalidateAll(); },
  });
  const toggle = useMutation({
    mutationFn: (a: { id: string; done: boolean }) => api(`/activities/${a.id}`, { method: "PATCH", body: { done: a.done } }),
    onSuccess: invalidateAll,
  });

  return (
    <section className="mt-7">
      <h3 className="mb-2 text-[13px]">Activity</h3>
      <div className="rounded-lg border border-line-2 bg-panel focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
        <textarea placeholder={kind === "task" ? "What needs doing?" : `Write a ${kind}…`} value={text} rows={kind === "task" ? 1 : 3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) add.mutate(); }}
          className="block w-full resize-y border-0 bg-transparent px-3 py-2.5 leading-normal outline-none placeholder:text-faint" />
        <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
          <Select size="sm" value={kind} ariaLabel="Type" onChange={(v) => setKind(v as typeof kind)}
            options={KINDS.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1), icon: KIND_ICON[k] }))} />
          <LinkPicker value={extra} onChange={setExtra} placeholder="Also link…" />
          {kind === "task" && (
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date"
              className="h-[26px] rounded-[5px] border border-line bg-panel px-1.5 text-xs" />
          )}
          <Button size="sm" variant="primary" disabled={!text.trim() || add.isPending} onClick={() => add.mutate()}>{kind === "task" ? "Add task" : "Save"}</Button>
        </div>
      </div>
      <ErrorBox error={add.error} />
      <ul className="mt-2 list-none p-0">
        {data?.map((t) => {
          if (t.type === "activity") {
            return (
              <li key={"a" + t.id} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5 border-b border-line py-2.5 last:border-0">
                <Avatar type={t.actor_type} name={t.actor_name} />
                <div>
                  {t.kind === "task" ? (
                    <>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input type="checkbox" checked={!!t.done_at} onChange={(e) => toggle.mutate({ id: t.id, done: e.target.checked })} />
                        <span className={t.done_at ? "text-muted line-through" : ""}>{t.title}</span>
                        {t.due_at && <DueDate due={t.due_at} done={!!t.done_at} />}
                      </label>
                      <div className="text-xs text-muted"><Who type={t.actor_type} name={t.actor_name} /> · {timeAgo(t.created_at)}</div>
                    </>
                  ) : (
                    <div className="text-ink-2">
                      <b className="font-medium text-ink"><Who type={t.actor_type} name={t.actor_name} /></b> logged a {t.kind}
                      {t.title && <>: <b className="font-medium text-ink">{t.title}</b></>}
                      <span className="ml-1.5 text-xs whitespace-nowrap text-faint">{timeAgo(t.created_at)}</span>
                    </div>
                  )}
                  {t.body && <div className="mt-1 whitespace-pre-wrap">{t.body}</div>}
                  {t.links?.some((l) => l.id !== recordId) && <div className="mt-1 flex flex-wrap gap-1"><LinkChips links={t.links} exclude={recordId} /></div>}
                </div>
              </li>
            );
          }
          const d = describeChange(t, fields);
          return (
            <li key={"c" + t.id} className={cn("grid grid-cols-[22px_minmax(0,1fr)] gap-2.5 border-b border-line py-2.5 last:border-0", t.undone_at && "opacity-50")}>
              <Avatar type={t.actor_type} name={t.actor_name} />
              <div>
                <div className="text-ink-2">
                  <b className="font-medium text-ink"><Who type={t.actor_type} name={t.actor_name} /></b> {d.line}
                  <span className="ml-1.5 text-xs whitespace-nowrap text-faint">{timeAgo(t.created_at)}</span>
                  {t.undone_at ? <Pill>undone</Pill>
                    : t.action === "record.update" && <Button size="sm" variant="ghost" className="ml-1 h-5" onClick={() => undoEntry(t.id)}>Undo</Button>}
                </div>
                {d.diff && <div className="mt-0.5 text-xs text-muted">{d.diff}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
