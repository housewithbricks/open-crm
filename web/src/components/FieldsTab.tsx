import { useMutation } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { api, invalidateAll, type Choice, type FieldDef, type FieldType, type ObjectType } from "../lib/api";
import { cn, dot, objColor, tint } from "../lib/format";
import { useSchema } from "../lib/schema";
import { ChoiceTag } from "./fields";
import StageEditor from "./StageEditor";
import { Select } from "./select";
import { Table, Td, Th, Tr } from "./table";
import { Button, Card, ColorSwatches, ErrorBox, Hint, Input, inputClass, Label, Modal, ModalActions, ObjIcon, Pill, SwitchRow, Textarea, Who } from "./ui";

export const TYPE_INFO: { type: FieldType; label: string; desc: string; glyph: string; color: string; placeholder: string }[] = [
  { type: "text", label: "Text", desc: "A short line, like a title or code", glyph: "Aa", color: "gray", placeholder: "e.g. Job title" },
  { type: "select", label: "Select", desc: "Pick one option from a list", glyph: "◉", color: "violet", placeholder: "e.g. Lead source" },
  { type: "multi_select", label: "Multi-select", desc: "Several options, like tags", glyph: "☰", color: "pink", placeholder: "e.g. Interests" },
  { type: "relation", label: "Link to record", desc: "Connect to a person, company…", glyph: "⇄", color: "blue", placeholder: "e.g. Account owner" },
  { type: "date", label: "Date", desc: "Deadlines, renewals, birthdays", glyph: "▦", color: "amber", placeholder: "e.g. Renewal date" },
  { type: "currency", label: "Currency", desc: "Money amounts", glyph: "$", color: "green", placeholder: "e.g. Annual value" },
  { type: "number", label: "Number", desc: "Counts, scores, quantities", glyph: "#", color: "teal", placeholder: "e.g. Employees" },
  { type: "boolean", label: "Yes / no", desc: "A simple checkbox", glyph: "✓", color: "green", placeholder: "e.g. Newsletter opt-in" },
  { type: "long_text", label: "Long text", desc: "Notes and paragraphs", glyph: "¶", color: "gray", placeholder: "e.g. Background" },
  { type: "email", label: "Email", desc: "Validated email address", glyph: "@", color: "orange", placeholder: "e.g. Billing email" },
  { type: "url", label: "URL", desc: "A website or link", glyph: "↗", color: "blue", placeholder: "e.g. Website" },
  { type: "phone", label: "Phone", desc: "A phone number", glyph: "☏", color: "red", placeholder: "e.g. Mobile" },
];
export const TYPE_LABEL = Object.fromEntries(TYPE_INFO.map((t) => [t.type, t.label])) as Record<FieldType, string>;

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "INR", "BRL", "MXN"];
const OPTION_COLORS = ["blue", "violet", "green", "amber", "orange", "red", "teal", "pink", "gray"];

/** Colored type glyph, e.g. "Aa" for text. */
export function TypeGlyph({ type, size = 32 }: { type: FieldType; size?: number }) {
  const t = TYPE_INFO.find((x) => x.type === type)!;
  const c = dot(t.color);
  return (
    <span className="grid flex-none place-items-center rounded-[7px] font-mono font-semibold"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), color: c, background: tint(c, 14) }}>{t.glyph}</span>
  );
}

export default function FieldsTab({ obj }: { obj: ObjectType }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FieldDef | null>(null);
  return (
    <div className="max-w-[920px]">
      <ObjectSettings obj={obj} />
      <section className="mt-7">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="m-0 text-[13px]">Fields <span className="font-normal text-muted">{obj.fields.length}</span></h3>
          <div className="flex-1" />
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add field</Button>
        </div>
        <p className="mt-0 mb-2.5 text-muted">Click a field to rename it, change its options and colors, or archive it. Agents with the schema scope can add fields too.</p>
        <Table>
          <thead><tr><Th>Field</Th><Th>Type</Th><Th>Options</Th><Th>Added by</Th></tr></thead>
          <tbody>
            {obj.fields.map((f) => (
              <Tr key={f.key} onClick={() => setEditing(f)}>
                <Td className="font-medium">
                  {f.label}
                  {f.key === obj.primary_field && <Pill>Name field</Pill>}
                  {f.required && f.key !== obj.primary_field && <Pill>Required</Pill>}
                  {f.is_unique && <Pill>Unique</Pill>}
                </Td>
                <Td className="text-muted"><span className="inline-flex items-center gap-2"><TypeGlyph type={f.type} size={18} />{TYPE_LABEL[f.type]}{f.type === "relation" && ` → ${f.options.target}`}</span></Td>
                <Td className="whitespace-normal">
                  {f.options.choices?.map((c) => <ChoiceTag key={c.value} field={f} value={c.value} />)}
                  {!f.options.choices && f.description && <span className="text-muted">{f.description}</span>}
                </Td>
                <Td className="text-muted"><Who name={f.created_by} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </section>
      {adding && <AddFieldModal obj={obj} onClose={() => setAdding(false)} />}
      {editing && <EditFieldModal obj={obj} field={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SettingRow({ label, hint, children, first }: { label: string; hint?: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={cn("grid grid-cols-[180px_minmax(0,1fr)] items-start gap-4 border-b border-line py-4 last:border-0 max-md:grid-cols-1 max-md:gap-2", first && "pt-1")}>
      <div className="pt-1.5 font-medium text-ink-2">{label}{hint && <small className="mt-0.5 block font-normal text-muted">{hint}</small>}</div>
      <div>{children}</div>
    </div>
  );
}

function ObjectSettings({ obj }: { obj: ObjectType }) {
  const [label, setLabel] = useState(obj.label);
  const [plural, setPlural] = useState(obj.label_plural);
  const [description, setDescription] = useState(obj.description);
  const [primary, setPrimary] = useState(obj.primary_field);
  const save = useMutation({
    mutationFn: (patch: Record<string, string>) => api(`/objects/${obj.slug}`, { method: "PATCH", body: patch }),
    onSuccess: invalidateAll,
  });
  const archive = useMutation({
    mutationFn: () => api(`/objects/${obj.slug}`, { method: "DELETE" }),
    onSuccess: () => { invalidateAll(); location.href = "/"; },
  });
  const dirty = label !== obj.label || plural !== obj.label_plural || description !== obj.description || primary !== obj.primary_field;
  const textFields = obj.fields.filter((f) => ["text", "email", "url", "phone"].includes(f.type));
  return (
    <Card>
      <h3 className="mt-0 mb-2.5 text-[13px]">Object settings</h3>
      <SettingRow label="Name" first>
        <div className="flex gap-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Singular name" placeholder="Singular" />
          <Input value={plural} onChange={(e) => setPlural(e.target.value)} aria-label="Plural name" placeholder="Plural" />
        </div>
      </SettingRow>
      <SettingRow label="Color" hint="Used in links, search and the sidebar">
        <div className="flex items-center gap-2.5">
          <ObjIcon slug={obj.slug} size={24} />
          <ColorSwatches value={objColor(obj)} onChange={(color) => save.mutate({ color })} />
        </div>
      </SettingRow>
      <SettingRow label="Description" hint="Shown to you and to agents">
        <Textarea className="min-h-14" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`What is ${/^[aeiou]/i.test(obj.label) ? "an" : "a"} ${obj.label.toLowerCase()}?`} />
      </SettingRow>
      <SettingRow label="Name field" hint="The field used as each record's title">
        <Select width={260} value={primary} ariaLabel="Name field" onChange={(v) => v && setPrimary(v)} options={textFields.map((f) => ({ value: f.key, label: f.label }))} />
      </SettingRow>
      <ErrorBox error={save.error || archive.error} />
      <div className="mt-3 flex items-center gap-2">
        {!obj.is_system && (
          <Button variant="ghost" onClick={() => confirm(`Archive ${obj.label_plural}? Its records are hidden but kept, and you can undo this from the audit log.`) && archive.mutate()}>Archive object</Button>
        )}
        <div className="flex-1" />
        <Button variant="primary" disabled={!dirty || !label.trim() || !plural.trim() || save.isPending}
          onClick={() => save.mutate({ label: label.trim(), label_plural: plural.trim(), description, primary_field: primary })}>
          Save changes
        </Button>
      </div>
    </Card>
  );
}

/** One option row: color dot (click to recolor), editable label, remove. */
function OptionRow({ label, color, removed, onLabel, onColor, onRemove, removeText = "×" }: {
  label: string; color: string; removed?: boolean; onLabel: (v: string) => void; onColor: (c: string) => void; onRemove: () => void; removeText?: string;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-line py-1.5 last:border-0">
      <button type="button" aria-label="Change color" onClick={() => setPicking(!picking)} className="size-3.5 rounded-full" style={{ background: dot(color) }} />
      <input aria-label="Option" className={cn(inputClass, "h-7", removed && "text-faint line-through")} value={label} disabled={removed} onChange={(e) => onLabel(e.target.value)} />
      <Button size="sm" variant="ghost" aria-label="Remove option" onClick={onRemove}>{removeText}</Button>
      {picking && <div className="col-span-3 pt-1 pb-0.5 pl-[22px]"><ColorSwatches value={color} onChange={(c) => { onColor(c); setPicking(false); }} /></div>}
    </div>
  );
}

function NewOptionRow({ onAdd, placeholder }: { onAdd: (labels: string[]) => void; placeholder: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const parts = text.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length) { onAdd(parts); setText(""); }
  };
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 py-1.5">
      <span className="size-3.5 rounded-full bg-line-2" />
      <input aria-label="New option" className={cn(inputClass, "h-7")} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <Button size="sm" disabled={!text.trim()} onClick={add}>Add</Button>
    </div>
  );
}

export function AddFieldModal({ obj, onClose }: { obj: ObjectType; onClose: () => void }) {
  const id = useId();
  const { data: schema } = useSchema();
  const [type, setType] = useState<FieldType | null>(null);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [required, setRequired] = useState(false);
  const [unique, setUnique] = useState(false);
  const [target, setTarget] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [opts, setOpts] = useState<{ label: string; color: string }[]>([]);
  const info = TYPE_INFO.find((t) => t.type === type);
  const isSelect = type === "select" || type === "multi_select";

  const add = useMutation({
    mutationFn: () =>
      api(`/objects/${obj.slug}/fields`, {
        body: {
          label: label.trim(), type, description, required, unique,
          ...(isSelect ? { choices: opts } : {}),
          ...(type === "relation" ? { target, multiple } : {}),
          ...(type === "currency" ? { currency } : {}),
        },
      }),
    onSuccess: () => { invalidateAll(); onClose(); },
  });

  if (!info) {
    return (
      <Modal title={`New field on ${obj.label_plural}`} onClose={onClose} wide>
        <p className="mt-0 mb-3.5 text-muted">What kind of information is it?</p>
        <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-2">
          {TYPE_INFO.map((t) => (
            <button key={t.type} type="button" onClick={() => setType(t.type)}
              className="flex items-center gap-2.5 rounded-lg border border-line bg-panel p-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft">
              <TypeGlyph type={t.type} />
              <span className="flex min-w-0 flex-col"><b className="font-medium">{t.label}</b><small className="mt-px text-xs leading-snug text-muted">{t.desc}</small></span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`New field on ${obj.label_plural}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <div className="mt-1.5 mb-0.5 flex items-center justify-between">
          <span className="inline-flex items-center gap-2.5"><TypeGlyph type={info.type} size={28} /><b className="font-medium">{info.label}</b></span>
          <Button size="sm" variant="ghost" onClick={() => setType(null)}>Change type</Button>
        </div>

        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input id={`${id}-name`} autoFocus placeholder={info.placeholder} value={label} onChange={(e) => setLabel(e.target.value)} />

        {isSelect && (
          <>
            <Label id={`${id}-options`}>Options</Label>
            <div role="group" aria-labelledby={`${id}-options`} className="rounded-lg border border-line px-2.5 py-0.5">
              {opts.map((o, i) => (
                <OptionRow key={i} label={o.label} color={o.color}
                  onLabel={(v) => setOpts((x) => x.map((y, j) => (j === i ? { ...y, label: v } : y)))}
                  onColor={(c) => setOpts((x) => x.map((y, j) => (j === i ? { ...y, color: c } : y)))}
                  onRemove={() => setOpts((x) => x.filter((_, j) => j !== i))} />
              ))}
              <NewOptionRow placeholder={opts.length ? "Add another option" : "Type an option and press Enter (or paste a comma list)"}
                onAdd={(labels) => setOpts((o) => [...o, ...labels.map((l, i) => ({ label: l, color: OPTION_COLORS[(o.length + i) % OPTION_COLORS.length] }))])} />
            </div>
          </>
        )}

        {type === "relation" && (
          <>
            <Label htmlFor={`${id}-target`}>Links to</Label>
            <Select id={`${id}-target`} value={target} placeholder="Choose an object…" ariaLabel="Links to" onChange={setTarget}
              options={(schema?.objects ?? []).map((o) => ({ value: o.slug, label: o.label_plural, icon: <ObjIcon slug={o.slug} size={16} /> }))} />
            <SwitchRow title="Allow several" hint="e.g. a deal with several contacts" checked={multiple} onChange={setMultiple} />
          </>
        )}

        {type === "currency" && (
          <>
            <Label htmlFor={`${id}-currency`}>Currency</Label>
            <Select id={`${id}-currency`} width={160} value={currency} ariaLabel="Currency" onChange={(v) => v && setCurrency(v)} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
          </>
        )}

        <Label htmlFor={`${id}-desc`}>Description <span className="font-normal text-muted">optional</span></Label>
        <Input id={`${id}-desc`} placeholder="What goes here? Helps you and your agents fill it in." value={description} onChange={(e) => setDescription(e.target.value)} />

        <div className="mt-3.5 border-t border-line">
          <SwitchRow title="Required" hint="Every record must have a value" checked={required} onChange={setRequired} />
          {!["boolean", "long_text", "multi_select"].includes(type!) && (
            <SwitchRow title="Unique" hint="No two records can share a value. Imports and agents use it to avoid duplicates." checked={unique} onChange={setUnique} />
          )}
        </div>

        <ErrorBox error={add.error} />
        <ModalActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!label.trim() || (type === "relation" && !target) || add.isPending}>{add.isPending ? "Adding…" : "Add field"}</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

type OptDraft = Choice & { removed?: boolean; isNew?: boolean };

function EditFieldModal({ obj, field, onClose }: { obj: ObjectType; field: FieldDef; onClose: () => void }) {
  const id = useId();
  const [label, setLabel] = useState(field.label);
  const [description, setDescription] = useState(field.description);
  const [required, setRequired] = useState(field.required);
  const [opts, setOpts] = useState<OptDraft[]>(field.options.choices?.map((c) => ({ ...c })) ?? []);
  const isSelect = field.type === "select" || field.type === "multi_select";
  const [stages, setStages] = useState(false);
  const setOpt = (i: number, patch: Partial<OptDraft>) => setOpts((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = useMutation({
    mutationFn: () => {
      // Keep stage kind and win probability: the server replaces the whole option list.
      const kept = opts.filter((o) => !o.removed && !o.isNew).map(({ removed: _r, isNew: _n, ...c }) => c);
      const added = opts.filter((o) => o.isNew && !o.removed).map((o) => ({ label: o.label, color: o.color }));
      return api(`/objects/${obj.slug}/fields/${field.key}`, {
        method: "PATCH",
        body: {
          label, description, required,
          ...(isSelect ? { choices: kept, add_choices: added, remove_choices: opts.filter((o) => o.removed && !o.isNew).map((o) => o.value) } : {}),
        },
      });
    },
    onSuccess: () => { invalidateAll(); onClose(); },
  });
  const archive = useMutation({
    mutationFn: () => api(`/objects/${obj.slug}/fields/${field.key}`, { method: "DELETE" }),
    onSuccess: () => { invalidateAll(); onClose(); },
  });

  return (
    <Modal title={`Edit “${field.label}”`} onClose={onClose}>
      <p className="m-0 text-muted">{TYPE_LABEL[field.type]} · key <code>{field.key}</code> · added by <Who name={field.created_by} /></p>
      <Label htmlFor={`${id}-name`}>Name</Label>
      <Input id={`${id}-name`} value={label} onChange={(e) => setLabel(e.target.value)} />
      <Label htmlFor={`${id}-desc`}>Description</Label>
      <Input id={`${id}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Helps you and your agents fill it in" />
      {field.key !== obj.primary_field && (
        <div className="mt-3.5 border-t border-line">
          <SwitchRow title="Required" hint="Every record must have a value" checked={required} onChange={setRequired} />
        </div>
      )}
      {isSelect && (
        <>
          <Label id={`${id}-options`}>
            Options <span className="font-normal text-muted">· click a dot to change its color</span>
            {field.type === "select" && <button type="button" className="float-right font-normal text-accent hover:underline" onClick={() => setStages(true)}>Edit as pipeline stages →</button>}
          </Label>
          <div role="group" aria-labelledby={`${id}-options`} className="rounded-lg border border-line px-2.5 py-0.5">
            {opts.map((o, i) => (
              <OptionRow key={i} label={o.label} color={o.color ?? "gray"} removed={o.removed} removeText={o.removed ? "Keep" : "Remove"}
                onLabel={(v) => setOpt(i, { label: v })} onColor={(c) => setOpt(i, { color: c })} onRemove={() => setOpt(i, { removed: !o.removed })} />
            ))}
            <NewOptionRow placeholder="New option"
              onAdd={(labels) => setOpts((o) => [...o, ...labels.map((l, i) => ({ value: "", label: l, color: OPTION_COLORS[(o.length + i) % OPTION_COLORS.length], isNew: true }))])} />
          </div>
          {opts.some((o) => o.removed && !o.isNew) && <Hint>Records using removed options keep their value, but it won't be offered anymore.</Hint>}
        </>
      )}
      {stages && <StageEditor obj={obj} field={field} onClose={() => { setStages(false); onClose(); }} />}
      <ErrorBox error={save.error || archive.error} />
      <ModalActions>
        {field.key !== obj.primary_field && (
          <Button variant="ghost" className="mr-auto" onClick={() => confirm(`Archive field “${field.label}”? Existing values are kept and you can undo this from the audit log.`) && archive.mutate()}>
            Archive field
          </Button>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => save.mutate()} disabled={!label.trim() || save.isPending}>Save</Button>
      </ModalActions>
    </Modal>
  );
}
