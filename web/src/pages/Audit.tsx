import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Select } from "../components/select";
import { Avatar, Button, Empty, ErrorBox, Hint, Input, Label, List, Modal, ModalActions, PageHead, Pill, refClass, Segmented, SourceLink, Who } from "../components/ui";
import { api, invalidateAll, type AuditEntry } from "../lib/api";
import { describeAudit } from "../lib/describe";
import { cn, timeAgo } from "../lib/format";
import { useSchema } from "../lib/schema";
import { undoEntry } from "../lib/undo";

export default function Audit() {
  const [who, setWho] = useState<"all" | "agent" | "user">("all");
  const { data } = useQuery({ queryKey: ["audit", "page"], queryFn: () => api<AuditEntry[]>("/audit?limit=500") });
  const { data: schema } = useSchema();
  const navigate = useNavigate();
  const undo = useMutation({ mutationFn: undoEntry });
  const [bulk, setBulk] = useState(false);
  const rows = data?.filter((a) => who === "all" || a.actor_type === who);
  return (
    <div className="max-w-[880px]">
      <PageHead title="Audit log" desc="Every change, by you or an agent. Record, activity and most field and object changes can be undone; type changes and removed options can't.">
        <Segmented value={who} onChange={setWho} options={[{ value: "all", label: "Everyone" }, { value: "agent", label: "Agents" }, { value: "user", label: "You" }]} />
        <Button onClick={() => setBulk(true)}>Undo an agent's changes</Button>
      </PageHead>
      {bulk && <BulkUndo onClose={() => setBulk(false)} />}
      <List>
        {rows && !rows.length && <Empty>Nothing here yet.</Empty>}
        {rows?.map((a) => {
          const d = describeAudit(a, schema?.objects);
          const openable = a.action.startsWith("record.") && a.action !== "record.archive" && a.target_id && !a.undone_at;
          return (
            <div key={a.id} className={cn("group !items-start", a.undone_at && "opacity-50")}>
              <Avatar type={a.actor_type} name={a.actor_name} />
              <div className="min-w-0 flex-1">
                <div>
                  <b className="font-medium"><Who type={a.actor_type} name={a.actor_name} /></b> <span className="text-muted">{d.text}</span>
                  {openable && <> · <button type="button" className={refClass} onClick={() => navigate({ to: "/o/$slug", params: { slug: a.object_slug! }, search: { r: a.target_id! } })}>Open</button></>}
                </div>
                {d.diff?.map((line, i) => <div key={i} className="text-xs text-muted">{line}</div>)}
                {a.source && <div className="mt-0.5"><SourceLink source={a.source} /></div>}
              </div>
              <span className="pt-px text-xs whitespace-nowrap text-muted">{timeAgo(a.created_at)}</span>
              {a.undone_at ? <Pill>Undone</Pill> : a.undoable ? (
                <Button size="sm" className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" disabled={undo.isPending} onClick={() => undo.mutate(a.id)}>Undo</Button>
              ) : <span className="w-[52px]" />}
            </div>
          );
        })}
      </List>
    </div>
  );
}

type Plan = { actor: string; since: string; until: string; undo: AuditEntry[]; conflicts: (AuditEntry & { changed_by: { actor_type: string; actor_name: string; at: string } })[]; not_undoable: AuditEntry[] };
type Applied = { undone: string[]; failed: { id: string; action: string; error: string }[]; conflicts: number; not_undoable: number };

const WINDOWS = [
  { value: "1h", label: "Last hour", ms: 36e5 },
  { value: "24h", label: "Last 24 hours", ms: 864e5 },
  { value: "7d", label: "Last 7 days", ms: 7 * 864e5 },
  { value: "custom", label: "Custom", ms: 0 },
] as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2026-11-08T09:30" for a datetime-local input, in local time. */
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);

/**
 * Undo everything one agent did in a time window. Always previews first: what will be undone,
 * and what is left alone because someone changed it since.
 */
function BulkUndo({ onClose }: { onClose: () => void }) {
  const { data: schema } = useSchema();
  const { data: actors } = useQuery({
    queryKey: ["audit", "actors"],
    queryFn: () => api<{ actor_type: string; actor_name: string; changes: number; last_at: string }[]>("/audit/actors"),
  });
  const agents = actors?.filter((a) => a.actor_type === "agent") ?? [];
  const [actor, setActor] = useState<string>("");
  const [win, setWin] = useState<(typeof WINDOWS)[number]["value"]>("1h");
  const [from, setFrom] = useState(() => localInput(new Date(Date.now() - 36e5)));
  const [to, setTo] = useState(() => localInput(new Date()));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<Applied | null>(null);

  const range = () => {
    if (win === "custom") return { since: new Date(from).toISOString(), until: new Date(to).toISOString() };
    return { since: new Date(Date.now() - WINDOWS.find((w) => w.value === win)!.ms).toISOString() };
  };
  const preview = useMutation({
    mutationFn: () => api<Plan>("/audit/undo-batch", { body: { actor, ...range() } }),
    onSuccess: (p) => { setPlan(p); setDone(null); },
  });
  const apply = useMutation({
    mutationFn: () => api<Applied>("/audit/undo-batch", { body: { actor: plan!.actor, since: plan!.since, until: plan!.until, apply: true } }),
    onSuccess: async (r) => { setDone(r); setPlan(null); await invalidateAll(); },
  });
  const reset = () => { setPlan(null); setDone(null); };

  return (
    <Modal title="Undo an agent's changes" onClose={onClose} wide>
      <Label>Agent</Label>
      <Select value={actor || undefined} ariaLabel="Agent" placeholder={agents.length ? "Pick an agent…" : "No agent changes yet"}
        options={agents.map((a) => ({ value: a.actor_name, label: `${a.actor_name} · ${plural(a.changes, "change")}, last ${timeAgo(a.last_at)}` }))}
        onChange={(v) => { setActor(v ?? ""); reset(); }} />
      <Label>When</Label>
      <Segmented className="flex-wrap" value={win} onChange={(v) => { setWin(v); reset(); }} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
      {win === "custom" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Input type="datetime-local" aria-label="From" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} className="w-auto" />
          <Input type="datetime-local" aria-label="To" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} className="w-auto" />
        </div>
      )}
      <Hint>Nothing changes until you confirm. Changes someone else edited afterwards are left alone.</Hint>
      <ErrorBox error={preview.error ?? apply.error} />

      {plan && (
        <div className="mt-4">
          <p className="my-2">
            <b className="font-medium">{plural(plan.undo.length, "change")} will be undone</b>
            {plan.conflicts.length > 0 && <span className="text-muted"> · {plan.conflicts.length} left alone because {plan.conflicts.length === 1 ? "it was" : "they were"} edited since</span>}
            {plan.not_undoable.length > 0 && <span className="text-muted"> · {plan.not_undoable.length} can't be undone</span>}
          </p>
          <List className="max-h-[320px] overflow-y-auto">
            {plan.undo.map((a) => <PlanRow key={a.id} a={a} text={describeAudit(a, schema?.objects).text} />)}
            {plan.conflicts.map((a) => (
              <PlanRow key={a.id} a={a} muted text={describeAudit(a, schema?.objects).text}
                note={`Kept: edited since by ${a.changed_by.actor_type === "user" ? "you" : a.changed_by.actor_name} ${timeAgo(a.changed_by.at)}`} />
            ))}
            {plan.not_undoable.map((a) => <PlanRow key={a.id} a={a} muted text={describeAudit(a, schema?.objects).text} note="Kept: can't be undone" />)}
            {!plan.undo.length && !plan.conflicts.length && !plan.not_undoable.length && <Empty>No changes by {plan.actor} in this window.</Empty>}
          </List>
        </div>
      )}

      {done && (
        <div className="mt-4">
          <p className="my-2"><b className="font-medium">Undid {plural(done.undone.length, "change")}.</b>
            {done.conflicts > 0 && <span className="text-muted"> Left {done.conflicts} that {done.conflicts === 1 ? "was" : "were"} edited since.</span>}</p>
          {done.failed.length > 0 && (
            <List>{done.failed.map((f) => <div key={f.id} className="text-xs"><span className="text-muted">{f.action} #{f.id}:</span>&nbsp;{f.error}</div>)}</List>
          )}
        </div>
      )}

      <ModalActions>
        <Button onClick={onClose}>{done ? "Close" : "Cancel"}</Button>
        {plan && plan.undo.length > 0 ? (
          <Button variant="primary" disabled={apply.isPending}
            onClick={() => confirm(`Undo ${plural(plan.undo.length, "change")} by ${plan.actor}?`) && apply.mutate()}>
            Undo {plural(plan.undo.length, "change")}
          </Button>
        ) : (
          <Button variant="primary" disabled={!actor || preview.isPending} onClick={() => preview.mutate()}>Preview</Button>
        )}
      </ModalActions>
    </Modal>
  );
}

function PlanRow({ a, text, note, muted }: { a: AuditEntry; text: ReactNode; note?: string; muted?: boolean }) {
  return (
    <div className={cn("!items-start", muted && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <div className="text-muted">{text}</div>
        {note && <div className="text-xs text-muted">{note}</div>}
      </div>
      <span className="pt-px text-xs whitespace-nowrap text-muted">{timeAgo(a.created_at)}</span>
    </div>
  );
}
