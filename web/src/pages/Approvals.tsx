import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Empty, ErrorBox, List, PageHead } from "../components/ui";
import { api, invalidateAll, type ChangeRequest } from "../lib/api";
import { timeAgo } from "../lib/format";

export function ChangeRow({ c }: { c: ChangeRequest }) {
  const decide = useMutation({
    mutationFn: (d: "approve" | "reject") => api(`/changes/${c.id}/${d}`, { body: {} }),
    onSuccess: invalidateAll,
  });
  return (
    <div className="!items-start">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{c.summary}</div>
        <div className="text-xs text-muted">
          Requested by <span className="text-agent">{c.actor_name}</span> · {timeAgo(c.created_at)}
          {c.reason && <> · “{c.reason}”</>}
        </div>
        <ErrorBox error={decide.error} />
      </div>
      {c.status === "pending" ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => decide.mutate("reject")} disabled={decide.isPending}>Reject</Button>
          <Button size="sm" variant="primary" onClick={() => decide.mutate("approve")} disabled={decide.isPending}>Approve</Button>
        </div>
      ) : (
        <span className="text-xs text-muted">{c.status}</span>
      )}
    </div>
  );
}

export default function Approvals() {
  const { data } = useQuery({ queryKey: ["changes", "all"], queryFn: () => api<ChangeRequest[]>("/changes") });
  const pending = data?.filter((c) => c.status === "pending") ?? [];
  const past = data?.filter((c) => c.status !== "pending") ?? [];
  return (
    <div className="max-w-[760px]">
      <PageHead title="Approvals" desc="Agents can add fields and objects on their own. Archiving, retyping or removing options waits here for you." />
      <List>
        {!pending.length && <Empty>Nothing waiting for approval.</Empty>}
        {pending.map((c) => <ChangeRow key={c.id} c={c} />)}
      </List>
      {!!past.length && (
        <section className="mt-7">
          <h3 className="mb-2 text-[13px]">History</h3>
          <List>{past.map((c) => <ChangeRow key={c.id} c={c} />)}</List>
        </section>
      )}
    </div>
  );
}
