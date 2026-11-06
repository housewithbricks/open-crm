import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, invalidateAll, type ObjectType } from "../lib/api";
import { Button, ErrorBox, Input, Label, Modal, ModalActions } from "./ui";

export default function NewObjectModal({ onClose }: { onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [plural, setPlural] = useState("");
  const [description, setDescription] = useState("");
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api<ObjectType>("/objects", { body: { label, label_plural: plural || undefined, description } }),
    onSuccess: (o) => { invalidateAll(); onClose(); navigate({ to: "/o/$slug", params: { slug: o.slug }, search: { tab: "fields" } }); },
  });
  return (
    <Modal title="New object" onClose={onClose}>
      <p className="mt-0 text-muted">A new kind of record, like Investors, Properties or Projects. It starts with a Name field; add more after. Your agents can create objects too.</p>
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Label>Singular name</Label>
        <Input autoFocus placeholder="Investor" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Label>Plural name</Label>
        <Input placeholder={label ? `${label}s` : "Investors"} value={plural} onChange={(e) => setPlural(e.target.value)} />
        <Label>Description</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        <ErrorBox error={create.error} />
        <ModalActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!label || create.isPending}>Create</Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
