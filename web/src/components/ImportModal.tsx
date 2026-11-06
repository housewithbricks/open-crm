import { useMutation } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { api, invalidateAll, type ImportResult, type ObjectType } from "../lib/api";
import { parseCsv } from "../lib/csv";
import { Select } from "./select";
import { Button, ErrorBox, Label, Modal, ModalActions } from "./ui";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export default function ImportModal({ obj, onClose }: { obj: ObjectType; onClose: () => void }) {
  const id = useId();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<string[]>([]);
  const uniqueish = obj.fields.filter((f) => f.is_unique || ["email", "url"].includes(f.type) || f.key === obj.primary_field);
  const [matchOn, setMatchOn] = useState(obj.fields.find((f) => f.is_unique)?.key ?? "");
  const [addOptions, setAddOptions] = useState(true);
  const [createRel, setCreateRel] = useState(true);

  const load = async (file: File) => {
    const parsed = parseCsv(await file.text());
    setFileName(file.name);
    setRows(parsed);
    const header = parsed[0] ?? [];
    setMapping(header.map((h) => {
      const f = obj.fields.find((x) => norm(x.key) === norm(h) || norm(x.label) === norm(h));
      return f?.key ?? "";
    }));
  };

  const body = useMemo(() => {
    if (!rows) return [];
    return rows.slice(1).map((r) => {
      const o: Record<string, string> = {};
      mapping.forEach((k, i) => { if (k && r[i]?.trim()) o[k] = r[i].trim(); });
      return o;
    });
  }, [rows, mapping]);

  const run = useMutation({
    mutationFn: () => api<ImportResult>(`/objects/${obj.slug}/import`, {
      body: { rows: body, match_on: matchOn || undefined, add_missing_options: addOptions, create_missing_relations: createRel },
    }),
    onSuccess: invalidateAll,
  });

  const header = rows?.[0] ?? [];
  const mappedCount = mapping.filter(Boolean).length;
  const res = run.data;

  return (
    <Modal title={`Import ${obj.label_plural.toLowerCase()} from CSV`} onClose={onClose}>
      {!rows && (
        <>
          <p className="mt-0 text-muted">The first row must be a header. Columns are matched to fields by name. Relation columns can hold names, e.g. a company name.</p>
          <label className="block cursor-pointer rounded-lg border border-dashed border-line-2 p-8 text-center text-muted hover:border-accent hover:text-ink">
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
            Choose a CSV file…
          </label>
        </>
      )}
      {rows && !res && (
        <>
          <p className="mt-0 text-muted">{fileName}: {rows.length - 1} rows, {mappedCount} of {header.length} columns mapped.</p>
          <div className="mt-2 grid max-h-[260px] gap-1.5 overflow-y-auto">
            {header.map((h, i) => (
              <div key={i} className="grid grid-cols-2 items-center gap-2.5">
                <span className="truncate" title={rows[1]?.[i]}>{h || <i className="text-muted">(blank)</i>}<small className="text-muted">{rows[1]?.[i] ? ` e.g. ${rows[1][i].slice(0, 24)}` : ""}</small></span>
                <Select value={mapping[i]} clearable="Skip column" ariaLabel={`Map ${h}`}
                  options={obj.fields.map((f) => ({ value: f.key, label: f.label }))}
                  onChange={(v) => setMapping((m) => m.map((x, j) => (j === i ? v : x)))} />
              </div>
            ))}
          </div>
          <Label htmlFor={`${id}-match`}>Update existing records that match on</Label>
          <Select id={`${id}-match`} value={matchOn} clearable="Don't match (always create)" ariaLabel="Match on"
            options={uniqueish.map((f) => ({ value: f.key, label: f.label }))} onChange={setMatchOn} />
          <label className="mt-2.5 flex cursor-pointer items-center gap-2"><input type="checkbox" className="square" checked={addOptions} onChange={(e) => setAddOptions(e.target.checked)} /> Add unknown select values as new options</label>
          <label className="mt-1.5 flex cursor-pointer items-center gap-2"><input type="checkbox" className="square" checked={createRel} onChange={(e) => setCreateRel(e.target.checked)} /> Create related records that don't exist yet</label>
          <ErrorBox error={run.error} />
          <ModalActions>
            <Button onClick={() => setRows(null)}>Back</Button>
            <Button variant="primary" disabled={!mappedCount || run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? "Importing…" : `Import ${rows.length - 1} rows`}
            </Button>
          </ModalActions>
        </>
      )}
      {res && (
        <>
          <div className="my-1 mb-4 flex gap-8 [&_b]:block [&_b]:text-[22px] [&_b]:font-semibold [&_b]:tabular-nums [&_span]:text-muted">
            <div><b>{res.created}</b><span>created</span></div>
            <div><b>{res.updated}</b><span>updated</span></div>
            <div><b className={res.failed ? "text-danger" : undefined}>{res.failed}</b><span>failed</span></div>
          </div>
          {res.errors.length > 0 && (
            <div className="max-h-[200px] overflow-y-auto rounded-lg border border-line p-4">
              {res.errors.map((e) => <div key={e.row}><code>row {e.row + 2}</code> {e.error}</div>)}
            </div>
          )}
          <ModalActions><Button variant="primary" onClick={onClose}>Done</Button></ModalActions>
        </>
      )}
    </Modal>
  );
}
