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

export type Actor = {
  type: "user" | "agent";
  name: string;
  scopes: Scope[];
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
