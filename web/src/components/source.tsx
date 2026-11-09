import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Source, type SourceCheck } from "../lib/api";
import { cn } from "../lib/format";
import { Button, ErrorBox, Hint, Label, Modal, ModalActions, refClass, Segmented, SourceLink, Textarea } from "./ui";


/**
 * A change's or note's source link, plus, when the write fingerprinted the source, a way to
 * check whether the source still reads the same.
 */
export function SourceLine({ source, kind, id }: { source: Source; kind: "change" | "activity"; id: string }) {
  const [open, setOpen] = useState(false);
  const d = source.digest;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <SourceLink source={source} />
      {d && (
        <button type="button" onClick={() => setOpen(true)}
          title={d.by === "crm" ? "Open CRM fingerprinted the text sent with this change (it kept a keyed, salted hash, not the text)." : `The caller reported a ${d.canon} hash of the source. Open CRM didn't see the text.`}
          className={cn(refClass, "text-xs text-muted hover:text-ink")}>
          {d.by === "crm" ? "fingerprinted" : "fingerprint (reported)"} · check
        </button>
      )}
      {open && d && <CheckSource kind={kind} id={id} source={source} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CheckSource({ kind, id, source, onClose }: { kind: "change" | "activity"; id: string; source: Source; onClose: () => void }) {
  const d = source.digest!;
  // Pasted text only works for text-v1: a text box changes bytes (line endings), so "raw" and
  // custom canons are compared hash to hash. Open CRM's own (keyed) fingerprints only take text.
  const canText = d.canon === "text-v1";
  const canDigest = d.alg === "sha256";
  const [mode, setMode] = useState<"text" | "digest">(canText ? "text" : "digest");
  const byText = mode === "text";
  const [input, setInput] = useState("");
  const check = useMutation({
    mutationFn: () =>
      api<SourceCheck>(`/${kind === "change" ? "audit" : "activities"}/${encodeURIComponent(id)}/check-source`, {
        body: byText ? { text: input } : { digest: input.trim() },
      }),
  });
  const r = check.data;
  return (
    <Modal title="Has the source changed?" onClose={onClose}>
      <p className="m-0 text-muted">
        When this change was made, {d.by === "crm" ? "Open CRM hashed the source's text" : "the caller reported a hash of the source"}. Open CRM kept the hash, not the text.{" "}
        {canText ? "Paste the source as it reads now to compare." : `It was hashed as "${d.canon}", which can't be redone from pasted text. Paste a hash made the same way, by the same tool.`}
      </p>
      {canText && canDigest && (
        <Segmented className="mt-3" value={mode} onChange={(m) => { setMode(m); setInput(""); check.reset(); }}
          options={[{ value: "text", label: "Paste text" }, { value: "digest", label: "Paste hash" }]} />
      )}
      <div className="mt-2"><SourceLink source={source} /></div>
      <Label htmlFor="src-check">{byText ? "Source text now" : "Hash now"}</Label>
      <Textarea id="src-check" rows={byText ? 8 : 2} value={input} onChange={(e) => { setInput(e.target.value); check.reset(); }}
        placeholder={byText ? "Open the link, copy the email or page text, paste it here" : `sha256:${d.canon}:…`} />
      {byText && d.canon === "text-v1" && <Hint>Runs of spaces and line breaks count as one space. Any other difference shows as a mismatch, including invisible characters a copy can pick up.</Hint>}
      <ErrorBox error={check.error} />
      {r && (
        <div className={cn("mt-3 rounded-ctl px-2.5 py-2", r.match ? "bg-hover text-ink" : "bg-danger-soft text-danger")}>
          {r.match
            ? "Matches what was fingerprinted when the change was made."
            : `Doesn't match what was fingerprinted. Either the source was edited, or this copy differs from what ${d.by === "crm" ? "the agent sent (it may not have copied the source exactly)" : "was hashed"}: quoted replies, a signature, a different part of the email. To rule that out, fetch it the same way as before and check again.`}
        </div>
      )}
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={(byText ? input === "" : !input.trim()) || check.isPending} onClick={() => check.mutate()}>Check</Button>
      </ModalActions>
    </Modal>
  );
}
