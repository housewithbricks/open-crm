import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { LinkChips, LinkPicker } from "../components/links";
import { Button, DueDate, Empty, ErrorBox, Hint, Input, Label, List, Modal, ModalActions, PageHead, Segmented, Textarea, Who } from "../components/ui";
import { api, invalidateAll, type Ref, type Task } from "../lib/api";
import { cn, fmtDate } from "../lib/format";

export function TaskList({ tasks, empty = "No open tasks.", flat }: { tasks: Task[]; empty?: string; flat?: boolean }) {
  const [editing, setEditing] = useState<Task | null>(null);
  const toggle = useMutation({
    mutationFn: (t: Task) => api(`/activities/${t.id}`, { method: "PATCH", body: { done: !t.done_at } }),
    onSuccess: invalidateAll,
  });
  return (
    <>
      <List flat={flat}>
        {!tasks.length && <Empty>{empty}</Empty>}
        {tasks.map((t) => (
          <div key={t.id} className="group !items-start">
            <input type="checkbox" className="mt-0.5" checked={!!t.done_at} onChange={() => toggle.mutate(t)} aria-label="Done" />
            <div className="min-w-0 flex-1">
              <div className={cn("cursor-pointer hover:underline hover:decoration-line-2 hover:underline-offset-[3px]", t.done_at && "text-muted line-through")} onClick={() => setEditing(t)}>{t.title}</div>
              {(t.links.length > 0 || t.actor_type === "agent") && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <LinkChips links={t.links} />
                  {t.actor_type === "agent" && <span className="text-xs text-muted">by <Who type="agent" name={t.actor_name} /></span>}
                </div>
              )}
            </div>
            {t.due_at && <DueDate due={t.due_at} done={!!t.done_at} />}
            <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setEditing(t)}>Edit</Button>
          </div>
        ))}
      </List>
      {editing && <EditTask task={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EditTask({ task, onClose }: { task: Task; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const [due, setDue] = useState(task.due_at?.slice(0, 10) ?? "");
  const [links, setLinks] = useState<Ref[]>(task.links);
  const save = useMutation({
    mutationFn: () => api(`/activities/${task.id}`, { method: "PATCH", body: { title, body, due_at: due || null, record_ids: links.map((l) => l.id) } }),
    onSuccess: () => { invalidateAll(); onClose(); },
  });
  const remove = useMutation({
    mutationFn: () => api(`/activities/${task.id}`, { method: "DELETE" }),
    onSuccess: () => { invalidateAll(); onClose(); },
  });
  return (
    <Modal title="Edit task" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Label>Task</Label>
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        <Label>Linked records</Label>
        <div className="flex min-h-8 items-center rounded-ctl border border-line-2 px-1.5 py-0.5 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
          <LinkPicker value={links} onChange={setLinks} placeholder="Search people, companies, deals…" />
        </div>
        <Label>Due</Label>
        <Input type="date" className="w-[180px]" value={due} onChange={(e) => setDue(e.target.value)} />
        <Label>Notes</Label>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} />
        <Hint>Created by <Who type={task.actor_type} name={task.actor_name} /> on {fmtDate(task.created_at)}</Hint>
        <ErrorBox error={save.error || remove.error} />
        <ModalActions>
          <Button variant="ghost" className="mr-auto" onClick={() => confirm("Delete this task?") && remove.mutate()}>Delete</Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || save.isPending}>Save</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

/** Task composer: title, linked records from any object, due date. */
export function NewTask() {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [links, setLinks] = useState<Ref[]>([]);
  const add = useMutation({
    mutationFn: () => api("/activities", { body: { kind: "task", title: title.trim(), due_at: due || null, record_ids: links.map((l) => l.id) } }),
    onSuccess: () => { setTitle(""); setDue(""); setLinks([]); invalidateAll(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(); }}
      className="rounded-lg border border-line-2 bg-panel focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft">
      <input placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)}
        className="h-10 w-full border-0 bg-transparent px-3 text-sm outline-none placeholder:text-faint" />
      <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
        <LinkPicker value={links} onChange={setLinks} />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" className="h-[26px] rounded-[5px] border border-line bg-panel px-1.5 text-xs" />
        <Button type="submit" size="sm" variant="primary" disabled={!title.trim() || add.isPending}>Add task</Button>
      </div>
      {add.error ? <div className="px-2 pb-2"><ErrorBox error={add.error} /></div> : null}
    </form>
  );
}

export default function Tasks() {
  const [all, setAll] = useState<"open" | "all">("open");
  const { data } = useQuery({ queryKey: ["tasks", all], queryFn: () => api<Task[]>(`/tasks${all === "all" ? "?all=1" : ""}`) });
  return (
    <div className="max-w-[760px]">
      <PageHead title="Tasks">
        <Segmented value={all} onChange={setAll} options={[{ value: "open", label: "Open" }, { value: "all", label: "All" }]} />
      </PageHead>
      <div className="mb-4"><NewTask /></div>
      {data && <TaskList tasks={data} empty={all === "all" ? "No tasks yet." : "No open tasks."} />}
    </div>
  );
}
