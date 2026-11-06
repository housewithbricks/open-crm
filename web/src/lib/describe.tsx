import type { ReactNode } from "react";
import type { AuditEntry, FieldDef, ObjectType } from "./api";
import { fmtDate, fmtMoney } from "./format";

/** Human-readable value for a field, for change summaries. */
export function showValue(f: FieldDef | undefined, v: any): string {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "empty";
  if (f?.options.choices) {
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((x) => f.options.choices!.find((c) => c.value === x)?.label ?? x).join(", ");
  }
  if (f?.type === "relation") return "a linked record";
  if (f?.type === "currency") return fmtMoney(Number(v), f.options.currency);
  if (f?.type === "date") return fmtDate(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** One-line description of an audit entry plus optional field-by-field diff. */
export function describeAudit(a: AuditEntry, objects: ObjectType[] = []): { text: ReactNode; diff?: string[] } {
  const obj = objects.find((o) => o.slug === a.object_slug);
  const objLabel = obj?.label_plural.toLowerCase() ?? a.object_slug ?? "";
  const one = obj?.label.toLowerCase() ?? "record";
  const field = (k: string) => obj?.fields.find((f) => f.key === k);
  const name = a.after?.name ?? a.after?.label ?? a.before?.name;
  switch (a.action) {
    case "record.create": return { text: <>added {one} <b>{name ?? ""}</b></> };
    case "record.update": {
      const keys = Object.keys(a.after ?? {});
      return {
        text: <>updated {keys.map((k) => field(k)?.label ?? k).join(", ").toLowerCase()} on a {one}</>,
        diff: keys.map((k) => `${field(k)?.label ?? k}: ${showValue(field(k), a.before?.[k])} → ${showValue(field(k), a.after[k])}`),
      };
    }
    case "record.archive": return { text: <>archived {one} <b>{a.before?.name ?? ""}</b></> };
    case "record.restore": return { text: <>restored a {one}</> };
    case "activity.create": return a.after?.kind === "task" ? { text: <>created task <b>{a.after?.title}</b></> } : { text: <>logged {a.after?.kind === "email" ? "an" : "a"} {a.after?.kind}{a.after?.title ? <>: <b>{a.after.title}</b></> : null}</> };
    case "activity.update": {
      const keys = Object.keys(a.after ?? {}).filter((k) => k !== "kind");
      const names: Record<string, string> = { title: "title", body: "notes", due_at: "due date", done_at: "done", record_ids: "linked records" };
      const kind = a.after?.kind ?? "task";
      if (keys.length === 1 && keys[0] === "done_at") return { text: a.after.done_at ? <>completed a {kind}</> : <>reopened a {kind}</> };
      return {
        text: <>edited the {keys.map((k) => names[k] ?? k).join(", ")} of a {kind}</>,
        diff: keys.filter((k) => k === "title").map((k) => `Title: ${a.before?.[k] || "empty"} → ${a.after[k] || "empty"}`),
      };
    }
    case "activity.delete": return { text: <>deleted a {a.before?.kind ?? "note"}{a.before?.title ? <> <b>{a.before.title}</b></> : null}</> };
    case "activity.restore": return { text: <>restored a {a.after?.kind ?? "note"}{a.after?.title ? <> <b>{a.after.title}</b></> : null}</> };
    case "field.create": return { text: <>added field <b>{a.after?.label}</b> to {objLabel}</> };
    case "field.update": return { text: <>edited a field on {objLabel}</> };
    case "field.unarchive": return { text: <>restored field <b>{a.after?.field}</b> on {objLabel}</> };
    case "object.create": return { text: <>created object <b>{a.after?.label_plural ?? name}</b></> };
    case "object.update": return { text: <>edited object {objLabel}</> };
    case "object.unarchive": return { text: <>restored object <b>{a.after?.object}</b></> };
    case "view.create": return { text: <>saved view <b>{a.after?.name}</b> on {objLabel}</> };
    case "view.update": return { text: <>updated view <b>{a.after?.name}</b></> };
    case "view.delete": return { text: <>deleted view <b>{a.before?.name}</b></> };
    case "change.request": return { text: <>asked to {a.after?.kind?.replace(/_/g, " ")} on {a.after?.object}</> };
    case "change.approve": return { text: <>approved a schema change</> };
    case "change.reject": return { text: <>rejected a schema change</> };
    case "schema.archive_field": return { text: <>archived field <b>{a.after?.field}</b> on {a.after?.object}</> };
    case "schema.archive_object": return { text: <>archived object <b>{a.after?.object}</b></> };
    case "schema.change_field_type": return { text: <>changed <b>{a.after?.field}</b> to {a.after?.type}</> };
    case "schema.remove_choices": return { text: <>removed options from <b>{a.after?.field}</b></> };
    default: return { text: <>{a.action.replace(/[._]/g, " ")}</> };
  }
}
