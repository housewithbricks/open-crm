import { QueryClient } from "@tanstack/react-query";

export type FieldType =
  | "text" | "long_text" | "number" | "currency" | "date" | "boolean"
  | "select" | "multi_select" | "email" | "url" | "phone" | "relation";
export const FIELD_TYPES: FieldType[] = ["text", "long_text", "number", "currency", "date", "boolean", "select", "multi_select", "email", "url", "phone", "relation"];

export type Choice = { value: string; label: string; color?: string; kind?: "open" | "won" | "lost"; probability?: number };
export type FieldDef = {
  id: string; key: string; label: string; description: string; type: FieldType;
  options: { choices?: Choice[]; target?: string; multiple?: boolean; currency?: string };
  required: boolean; is_unique: boolean; position: number; is_system: boolean; created_by: string;
};
export type ObjectType = {
  id: string; slug: string; label: string; label_plural: string; description: string; icon: string;
  color: string; primary_field: string; is_system: boolean; created_by: string; fields: FieldDef[];
};
export type CrmRecord = {
  id: string; object: string; display_name: string; data: Record<string, any>;
  created_by: string; updated_by: string; created_at: string; updated_at: string;
};
export type Ref = { id: string; object: string; display_name: string };
export type RecordList = { object: string; total: number; records: CrmRecord[]; refs: Record<string, Ref> };
export type RecordDetail = {
  record: CrmRecord; refs: Record<string, Ref>;
  related: { object: string; label: string; field: string; field_label: string; records: Ref[] }[];
};
/** Where a write came from, e.g. the email an agent read before changing a deal. */
export type Source = { url: string; label?: string; digest?: SourceDigest };
/** A fingerprint of the source when the write was made. by "crm": Open CRM's keyed hash of text the caller sent; "client": the caller's own SHA-256. */
export type SourceDigest = { alg: "sha256" | "hmac-sha256"; canon: string; value: string; by: "crm" | "client"; salt?: string; kid?: string };
export type SourceCheck = { source: { url: string; label: string | null }; match: boolean };
export type TimelineItem =
  | { type: "activity"; id: string; kind: string; title: string; body: string; due_at: string | null; done_at: string | null; actor_type: string; actor_name: string; created_at: string; links: Ref[]; source?: Source | null }
  | { type: "change"; id: string; action: string; actor_type: string; actor_name: string; before: any; after: any; source?: Source | null; created_at: string; undone_at: string | null };
export type Task = { id: string; kind: string; title: string; body: string; due_at: string | null; done_at: string | null; actor_type: string; actor_name: string; record_id: string | null; links: Ref[]; created_at: string };
export type ChangeRequest = { id: string; actor_type: string; actor_name: string; kind: string; summary: string; reason: string; status: string; created_at: string; decided_at: string | null };
export type ApiKey = { id: string; name: string; prefix: string; scopes: string[]; require_source: boolean; last_used_at: string | null; created_at: string };
export type AuditEntry = { id: string; actor_type: string; actor_name: string; action: string; object_slug: string | null; target_id: string | null; before: any; after: any; source?: Source | null; created_at: string; undone_at: string | null; undoable?: boolean };
export type FilterOp = "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "not_in" | "is_empty" | "not_empty";
export type Filter = { field: string; op: FilterOp; value?: any };
export type ViewConfig = { kind?: "table" | "board"; q?: string; filters?: Filter[]; sort?: string; dir?: "asc" | "desc"; group_by?: string };
export type SavedView = { id: string; object: string; name: string; config: ViewConfig; created_by: string; created_at: string };
export type Webhook = { id: string; url: string; events: string[]; secret: string; active: boolean; last_status: number | null; last_error: string | null; last_at: string | null; created_at: string };
export type ImportResult = { created: number; updated: number; failed: number; errors: { row: number; error: string }[] };

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status, data.details);
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
  },
});

/** Refresh everything after a write; the dataset is small and this keeps every view consistent. */
export const invalidateAll = () => queryClient.invalidateQueries();
