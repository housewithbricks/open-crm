export const FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "currency",
  "date",
  "boolean",
  "select",
  "multi_select",
  "email",
  "url",
  "phone",
  "relation",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * A select option. For pipeline-style fields (e.g. deal stage), kind marks closed stages
 * and probability (0-100) is the chance a record in this stage is won, used for forecasts.
 */
export type Choice = { value: string; label: string; color?: string; kind?: "open" | "won" | "lost"; probability?: number };

export type FieldOptions = {
  /** select / multi_select */
  choices?: Choice[];
  /** relation: slug of the target object */
  target?: string;
  /** relation: allow many */
  multiple?: boolean;
  /** currency code, e.g. USD */
  currency?: string;
};

export type FieldDef = {
  id: string;
  key: string;
  label: string;
  description: string;
  type: FieldType;
  options: FieldOptions;
  required: boolean;
  is_unique: boolean;
  position: number;
  is_system: boolean;
  created_by: string;
};

export type ObjectType = {
  id: string;
  slug: string;
  label: string;
  label_plural: string;
  description: string;
  icon: string;
  color: string;
  primary_field: string;
  is_system: boolean;
  position: number;
  created_by: string;
  fields: FieldDef[];
};

export type Scope = "read" | "write" | "schema";

/**
 * Where a write came from, e.g. the email an agent read before moving a deal. It is saved on
 * the audit entry (and on activities) so the change history can link back to it.
 */
export type Source = { url: string; label?: string };

export type Actor = {
  type: "user" | "agent";
  name: string;
  scopes: Scope[];
  /** Set per call, for the writes of that call only. */
  source?: Source;
  /** The API key was created to refuse record and activity writes without a source. */
  requireSource?: boolean;
};

export const userActor: Actor = { type: "user", name: "You", scopes: ["read", "write", "schema"] };

export const actorLabel = (a: Actor) => (a.type === "agent" ? `agent:${a.name}` : `user:${a.name}`);

/** Error with an HTTP status and a message that is safe to show to users and agents. */
export class CrmError extends Error {
  constructor(
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new CrmError(`${what} not found`, 404);

export function requireScope(actor: Actor, scope: Scope) {
  if (!actor.scopes.includes(scope)) {
    throw new CrmError(`This API key lacks the "${scope}" scope`, 403);
  }
}

/**
 * Validate a source link. Only http(s) URLs: the UI renders it as a link, so other schemes
 * (javascript:, data:) are refused. Returns undefined when no source is given.
 */
export function checkSource(input: unknown): Source | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const raw = typeof input === "string" ? { url: input } : input;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new CrmError("source must be {url, label?}");
  const { url, label } = raw as Record<string, unknown>;
  if (typeof url !== "string" || !url.trim()) throw new CrmError("source.url is required");
  if (url.length > 2048) throw new CrmError("source.url is longer than 2048 characters");
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new CrmError(`source.url is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new CrmError("source.url must start with http:// or https://");
  if (label !== undefined && label !== null && typeof label !== "string") throw new CrmError("source.label must be a string");
  const text = typeof label === "string" ? label.trim().slice(0, 200) : "";
  return text ? { url: parsed.href, label: text } : { url: parsed.href };
}

/**
 * Refuse a record or activity write from a key that must say where its writes come from.
 * Called at the top of each write in core, so REST and MCP enforce it the same way.
 */
export function requireSourceFor(actor: Actor) {
  if (actor.requireSource && !actor.source) {
    throw new CrmError(
      `The API key "${actor.name}" must link each change to its source. Pass source {url, label} (MCP) or the X-Source-Url header (REST). Nothing was changed.`,
      400,
    );
  }
}

/** The actor for one call, carrying that call's source (if any). */
export const withSource = (actor: Actor, source: unknown): Actor => {
  const s = checkSource(source);
  return s ? { ...actor, source: s } : actor;
};
