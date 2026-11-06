import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Table, Td, Th, Tr } from "../components/table";
import { Button, ErrorBox, Input, Label, Modal, ModalActions, PageHead, refClass } from "../components/ui";
import { api, invalidateAll, type Webhook } from "../lib/api";
import { cn, timeAgo } from "../lib/format";

const PAYLOAD = `POST <your url>
x-opencrm-event: record.updated
x-opencrm-signature: sha256=<hmac of body>

{
  "event": "record.updated",
  "actor": { "type": "agent", "name": "Claude" },
  "object": "deals",
  "target_id": "…",
  "before": { "stage": "proposal" },
  "after":  { "stage": "won" },
  "at": "2026-11-06T20:00:00Z"
}`;

export default function Webhooks() {
  const { data } = useQuery({ queryKey: ["webhooks"], queryFn: () => api<{ webhooks: Webhook[]; events: string[] }>("/webhooks") });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const toggle = useMutation({ mutationFn: (w: Webhook) => api(`/webhooks/${w.id}`, { method: "PATCH", body: { active: !w.active } }), onSuccess: invalidateAll });
  const remove = useMutation({ mutationFn: (id: string) => api(`/webhooks/${id}`, { method: "DELETE" }), onSuccess: invalidateAll });
  const test = useMutation({ mutationFn: (id: string) => api<{ status: number | null; error: string | null }>(`/webhooks/${id}/test`, { body: {} }), onSuccess: invalidateAll });

  return (
    <div className="max-w-[880px]">
      <PageHead title="Webhooks" desc="Get a POST when anything changes, so automations and agents can react.">
        <Button variant="primary" onClick={() => setCreating(true)}>New webhook</Button>
      </PageHead>
      <Table>
        <thead><tr><Th>URL</Th><Th>Events</Th><Th>Last delivery</Th><Th>Secret</Th><Th /></tr></thead>
        <tbody>
          {data?.webhooks.map((w) => (
            <Tr key={w.id}>
              <Td className={cn("font-medium", !w.active && "opacity-55")}>{w.url}</Td>
              <Td className="text-muted">{w.events.map((e) => (e === "*" ? "All events" : e)).join(", ")}</Td>
              <Td>{w.last_at ? <span className={w.last_error ? "text-danger" : "text-agent"}>{w.last_error ?? w.last_status} · {timeAgo(w.last_at)}</span> : <span className="text-muted">Never</span>}</Td>
              <Td>{revealed === w.id ? <code>{w.secret}</code> : <button type="button" className={refClass} onClick={() => setRevealed(w.id)}>Reveal</button>}</Td>
              <Td className="text-right">
                <span className="inline-flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => test.mutate(w.id)}>Send test</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle.mutate(w)}>{w.active ? "Pause" : "Resume"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm("Delete this webhook?") && remove.mutate(w.id)}>Delete</Button>
                </span>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {data && !data.webhooks.length && <div className="py-8 text-center text-muted">No webhooks yet.</div>}
      <ErrorBox error={test.error} />

      <section className="mt-7">
        <h3 className="mb-2 text-[13px]">Payload</h3>
        <pre>{PAYLOAD}</pre>
        <p className="m-0 text-muted">Verify the signature: HMAC-SHA256 of the raw body using the endpoint's secret. Failed deliveries are retried twice.</p>
      </section>
      {creating && data && <NewWebhookModal events={data.events} onClose={() => setCreating(false)} onCreated={(id) => { setRevealed(id); setCreating(false); }} />}
    </div>
  );
}

function NewWebhookModal({ events: allEvents, onClose, onCreated }: { events: string[]; onClose: () => void; onCreated: (id: string) => void }) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["*"]);
  const all = events.includes("*");
  const create = useMutation({
    mutationFn: () => api<Webhook>("/webhooks", { body: { url, events } }),
    onSuccess: (w) => { invalidateAll(); onCreated(w.id); },
  });
  const check = "flex cursor-pointer items-center gap-2 py-1";
  return (
    <Modal title="New webhook" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Label htmlFor={`${id}-url`}>URL</Label>
        <Input id={`${id}-url`} autoFocus placeholder="https://example.com/hooks/crm" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Label id={`${id}-events`}>Events</Label>
        <div role="group" aria-labelledby={`${id}-events`}>
        <label className={check}><input type="checkbox" className="square" checked={all} onChange={(e) => setEvents(e.target.checked ? ["*"] : [])} /> All events</label>
        {!all && allEvents.map((ev) => (
          <label key={ev} className={check}>
            <input type="checkbox" className="square" checked={events.includes(ev)} onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))} />
            <code>{ev}</code>
          </label>
        ))}
        </div>
        <ErrorBox error={create.error} />
        <ModalActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!url || !events.length || create.isPending}>Add webhook</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
