import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Table, Td, Th, Tr } from "../components/table";
import { Button, Card, Copyable, ErrorBox, Hint, Input, Label, Modal, ModalActions, PageHead, Segmented } from "../components/ui";
import { api, invalidateAll, type ApiKey } from "../lib/api";
import { timeAgo } from "../lib/format";

const SCOPES = [
  { id: "read", label: "Read", hint: "Search and view records" },
  { id: "write", label: "Write", hint: "Create and update records, notes and tasks" },
  { id: "schema", label: "Schema", hint: "Add objects and fields. Destructive changes still need your approval." },
];

export default function Keys() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api<{ mcp_url: string }>("/me") });
  const { data: keys } = useQuery({ queryKey: ["keys"], queryFn: () => api<ApiKey[]>("/keys") });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(ApiKey & { key: string }) | null>(null);
  const revoke = useMutation({ mutationFn: (id: string) => api(`/keys/${id}`, { method: "DELETE" }), onSuccess: invalidateAll });
  const url = me?.mcp_url ?? `${location.origin}/mcp`;

  return (
    <div className="max-w-[760px]">
      <PageHead title="API keys & MCP" desc="Give each agent its own key. Its changes show up under the key's name.">
        <Button variant="primary" onClick={() => setCreating(true)}>New key</Button>
      </PageHead>

      {created && (
        <Card className="mb-4 border-transparent bg-warn-soft">
          <b>Copy your new key now.</b> <span className="text-muted">It won't be shown again.</span>
          <Copyable text={created.key} />
        </Card>
      )}

      <Table>
        <thead><tr><Th>Name</Th><Th>Key</Th><Th>Scopes</Th><Th>Last used</Th><Th /></tr></thead>
        <tbody>
          {keys?.map((k) => (
            <Tr key={k.id}>
              <Td className="font-medium">{k.name}</Td>
              <Td><code>{k.prefix}…</code></Td>
              <Td className="text-muted">{k.scopes.join(", ")}</Td>
              <Td className="text-muted">{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</Td>
              <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => confirm(`Revoke key "${k.name}"? Agents using it will lose access.`) && revoke.mutate(k.id)}>Revoke</Button></Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {keys && !keys.length && <div className="py-8 text-center text-muted">No keys yet. Create one to connect an agent.</div>}

      <ConnectGuide url={url} keyText={created?.key ?? "ocrm_…"} />
      <Sessions />
      {creating && <NewKeyModal onClose={() => setCreating(false)} onCreated={(k) => { setCreated(k); setCreating(false); }} />}
    </div>
  );
}

/** Sign out every browser at once, e.g. after using a shared computer. API keys are not affected. */
function Sessions() {
  const out = useMutation({ mutationFn: () => api("/logout-all", { body: {} }), onSuccess: () => invalidateAll() });
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <b className="font-medium">Signed-in browsers</b>
          <div className="text-muted">Sign out on every device, including this one. API keys keep working. Changing ADMIN_PASSWORD does this too.</div>
        </div>
        <Button onClick={() => confirm("Sign out on every device, including this one?") && out.mutate()} disabled={out.isPending}>Sign out everywhere</Button>
      </div>
      <ErrorBox error={out.error} />
    </Card>
  );
}

const CLIENTS = ["Claude Code", "Claude", "ChatGPT", "Cursor", "VS Code", "Other"] as const;

function ConnectGuide({ url, keyText }: { url: string; keyText: string }) {
  const [client, setClient] = useState<(typeof CLIENTS)[number]>("Claude Code");
  const urlWithKey = `${url}?key=${keyText}`;
  const label = (t: string) => <div className="mt-3 text-xs font-medium text-muted">{t}</div>;
  return (
    <section className="mt-7">
      <h3 className="mb-2 text-[13px]">Connect an agent</h3>
      <p className="mt-0 mb-2.5 text-muted">
        MCP endpoint (Streamable HTTP): <code>{url}</code>. {keyText === "ocrm_…" ? "Create a key above and it's filled in below." : "Your new key is filled in below."}
      </p>
      <Segmented className="mb-1 flex-wrap" value={client} onChange={setClient} options={CLIENTS.map((c) => ({ value: c, label: c }))} />
      {client === "Claude Code" && <Copyable text={`claude mcp add --transport http open-crm ${url} \\\n  --header "Authorization: Bearer ${keyText}"`} />}
      {client === "Claude" && (
        <>
          {label("Settings → Connectors → Add custom connector, with this URL:")}
          <Copyable text={urlWithKey} />
          <Hint>Connectors take a URL, not headers, so the key is in the URL. Treat it like a password.</Hint>
        </>
      )}
      {client === "ChatGPT" && (
        <>
          {label("Settings → Apps & Connectors → Advanced → Developer mode, then create a connector with No authentication:")}
          <Copyable text={urlWithKey} />
          {label("OpenAI API (Responses API) tool:")}
          <Copyable text={JSON.stringify({ type: "mcp", server_label: "open_crm", server_url: url, headers: { Authorization: `Bearer ${keyText}` }, require_approval: "never" }, null, 2)} />
        </>
      )}
      {client === "Cursor" && (
        <>
          {label("~/.cursor/mcp.json")}
          <Copyable text={JSON.stringify({ mcpServers: { "open-crm": { url, headers: { Authorization: `Bearer ${keyText}` } } } }, null, 2)} />
        </>
      )}
      {client === "VS Code" && (
        <>
          {label(".vscode/mcp.json (GitHub Copilot agent mode)")}
          <Copyable text={JSON.stringify({ servers: { "open-crm": { type: "http", url, headers: { Authorization: `Bearer ${keyText}` } } } }, null, 2)} />
        </>
      )}
      {client === "Other" && (
        <>
          {label("Any MCP client with remote (HTTP) servers")}
          <Copyable text={`URL     ${url}\nHeader  Authorization: Bearer ${keyText}`} />
          {label("Client takes only a URL")}
          <Copyable text={urlWithKey} />
          {label("Client supports only local (stdio) servers")}
          <Copyable text={`npx -y mcp-remote ${url} --header "Authorization:Bearer ${keyText}"`} />
          {label("REST API")}
          <Copyable text={`curl -H "Authorization: Bearer ${keyText}" ${url.replace(/\/mcp$/, "")}/api/schema`} />
        </>
      )}
    </section>
  );
}

function NewKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (k: ApiKey & { key: string }) => void }) {
  const id = useId();
  const [name, setName] = useState("Claude");
  const [scopes, setScopes] = useState(["read", "write", "schema"]);
  const create = useMutation({
    mutationFn: () => api<ApiKey & { key: string }>("/keys", { body: { name, scopes } }),
    onSuccess: (k) => { invalidateAll(); onCreated(k); },
  });
  return (
    <Modal title="New API key" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input id={`${id}-name`} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <Hint>Shown as the author of this agent's changes.</Hint>
        <Label id={`${id}-scopes`}>Permissions</Label>
        <div role="group" aria-labelledby={`${id}-scopes`}>
        {SCOPES.map((s) => (
          <label key={s.id} className="flex cursor-pointer items-start gap-2 py-1">
            <input type="checkbox" className="square mt-0.5" checked={scopes.includes(s.id)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))} />
            <span><span className="font-medium">{s.label}</span><br /><span className="text-muted">{s.hint}</span></span>
          </label>
        ))}
        </div>
        <ErrorBox error={create.error} />
        <ModalActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !scopes.length || create.isPending}>Create key</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
