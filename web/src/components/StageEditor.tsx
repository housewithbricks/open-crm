import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, invalidateAll, type Choice, type FieldDef, type ObjectType } from "../lib/api";
import { cn, dot } from "../lib/format";
import { Select } from "./select";
import { Button, ColorSwatches, ErrorBox, Hint, inputClass, Modal, ModalActions } from "./ui";

type Draft = { value: string; label: string; color: string; kind: "open" | "won" | "lost"; probability: string; removed?: boolean; isNew?: boolean };

const KIND_OPTIONS = [
  { value: "open", label: "Open", hint: "In progress" },
  { value: "won", label: "Won", hint: "Closed won" },
  { value: "lost", label: "Lost", hint: "Closed lost" },
] as const;

const guessKind = (c: Choice): Draft["kind"] =>
  c.kind ?? (/\b(won|closed.?won)\b/i.test(c.label) ? "won" : /\b(lost|closed.?lost)\b/i.test(c.label) ? "lost" : "open");

/**
 * Edit a pipeline: the stages of a select field (e.g. Deal → Stage), in order,
 * with which ones close the deal (won/lost) and each stage's win probability.
 */
export default function StageEditor({ obj, field, onClose }: { obj: ObjectType; field: FieldDef; onClose: () => void }) {
  const [rows, setRows] = useState<Draft[]>(
    (field.options.choices ?? []).map((c) => ({
      value: c.value, label: c.label, color: c.color ?? "gray", kind: guessKind(c),
      probability: c.probability !== undefined ? String(c.probability) : guessKind(c) === "won" ? "100" : guessKind(c) === "lost" ? "0" : "",
    })),
  );
  const [picking, setPicking] = useState<number | null>(null);
  const set = (i: number, patch: Partial<Draft>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) => setRows((r) => {
    const j = i + d;
    if (j < 0 || j >= r.length) return r;
    const next = [...r];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const toChoice = (r: Draft) => ({
    ...(r.isNew ? {} : { value: r.value }), label: r.label.trim(), color: r.color, kind: r.kind,
    ...(r.probability.trim() !== "" ? { probability: Number(r.probability) } : {}),
  });

  const save = useMutation({
    mutationFn: async () => {
      const live = rows.filter((r) => !r.removed);
      const url = `/objects/${obj.slug}/fields/${field.key}`;
      const updated = await api<FieldDef>(url, {
        method: "PATCH",
        body: {
          choices: live.filter((r) => !r.isNew).map(toChoice),
          add_choices: live.filter((r) => r.isNew).map(toChoice),
          remove_choices: rows.filter((r) => r.removed && !r.isNew).map((r) => r.value),
        },
      });
      // New stages are appended by the server; put everything in the order shown here.
      if (live.some((r) => r.isNew)) {
        const byLabel = (l: string) => updated.options.choices?.find((c) => c.label === l.trim());
        const ordered = live.map((r) => (r.isNew ? byLabel(r.label) : updated.options.choices?.find((c) => c.value === r.value))).filter(Boolean);
        await api(url, { method: "PATCH", body: { choices: ordered } });
      }
    },
    onSuccess: () => { invalidateAll(); onClose(); },
  });

  const bad = rows.some((r) => !r.removed && (!r.label.trim() || (r.probability !== "" && !(Number(r.probability) >= 0 && Number(r.probability) <= 100))));
  const live = rows.filter((r) => !r.removed);

  return (
    <Modal title={`${obj.label} stages`} onClose={onClose} wide>
      <p className="mt-0 mb-3 text-muted">
        The steps a {obj.label.toLowerCase()} moves through, in order. Mark the stages that close it as Won or Lost, and give open stages a win probability for the weighted forecast on Home.
      </p>
      <div className="grid grid-cols-[52px_minmax(0,1fr)_120px_84px_72px] items-center gap-x-2 border-b border-line pb-1.5 text-xs font-medium text-muted max-sm:hidden">
        <span>Order</span><span>Stage</span><span>Type</span><span>Win %</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={i} className={cn("border-b border-line py-1.5", r.removed && "opacity-45")}>
          <div className="grid grid-cols-[52px_minmax(0,1fr)_120px_84px_72px] items-center gap-x-2 max-sm:grid-cols-[52px_minmax(0,1fr)_72px]">
            <span className="inline-flex">
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="size-6 rounded text-muted hover:bg-hover hover:text-ink disabled:opacity-30">↑</button>
              <button type="button" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="size-6 rounded text-muted hover:bg-hover hover:text-ink disabled:opacity-30">↓</button>
            </span>
            <span className="flex items-center gap-2">
              <button type="button" aria-label="Change color" className="size-3.5 flex-none rounded-full" style={{ background: dot(r.color) }} onClick={() => setPicking(picking === i ? null : i)} />
              <input className={cn(inputClass, "h-7", r.removed && "line-through")} value={r.label} disabled={r.removed} onChange={(e) => set(i, { label: e.target.value })} />
            </span>
            <span className="max-sm:hidden">
              <Select size="sm" width="100%" value={r.kind} ariaLabel="Stage type" options={KIND_OPTIONS.map((k) => ({ ...k }))}
                onChange={(k) => k && set(i, { kind: k as Draft["kind"], probability: k === "won" ? "100" : k === "lost" ? "0" : r.probability })} />
            </span>
            <span className="relative max-sm:hidden">
              <input className={cn(inputClass, "h-7 pr-6 text-right tabular-nums")} inputMode="numeric" placeholder="—" value={r.probability} disabled={r.removed || r.kind !== "open"}
                onChange={(e) => set(i, { probability: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })} />
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted">%</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => (r.isNew ? setRows((x) => x.filter((_, j) => j !== i)) : set(i, { removed: !r.removed }))}>{r.removed ? "Keep" : "Remove"}</Button>
          </div>
          {picking === i && <div className="pt-2 pb-1 pl-[60px]"><ColorSwatches value={r.color} onChange={(c) => { set(i, { color: c }); setPicking(null); }} /></div>}
        </div>
      ))}
      <Button size="sm" className="mt-2.5" onClick={() => {
        const lastOpen = rows.map((r) => r.kind).lastIndexOf("open");
        const at = lastOpen + 1; // new stages go after the last open stage, before Won/Lost
        setRows((r) => [...r.slice(0, at), { value: "", label: "New stage", color: "blue", kind: "open", probability: "", isNew: true }, ...r.slice(at)]);
      }}>+ Add stage</Button>

      {!live.some((r) => r.kind === "won") && <Hint>No stage is marked Won yet, so Home can't count wins or the win rate.</Hint>}
      {rows.some((r) => r.removed && !r.isNew) && <Hint>Deals in a removed stage keep it until you move them, but it won't be offered anymore.</Hint>}
      <ErrorBox error={save.error} />
      <ModalActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={bad || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save stages"}</Button>
      </ModalActions>
    </Modal>
  );
}
