import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar, Button, Empty, List, PageHead, Pill, refClass, Segmented, Who } from "../components/ui";
import { api, type AuditEntry } from "../lib/api";
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
  const rows = data?.filter((a) => who === "all" || a.actor_type === who);
  return (
    <div className="max-w-[880px]">
      <PageHead title="Audit log" desc="Every change, by you or an agent. Record, activity and most field and object changes can be undone; type changes and removed options can't.">
        <Segmented value={who} onChange={setWho} options={[{ value: "all", label: "Everyone" }, { value: "agent", label: "Agents" }, { value: "user", label: "You" }]} />
      </PageHead>
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
