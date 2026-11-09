import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
export type Source = { url: string; label?: string; digest?: SourceDigest };

/**
 * A fingerprint of what the write was based on, so a later read of the source can be compared
 * without keeping a copy.
 * - by "crm": the caller sent the text and Open CRM hashed it with HMAC-SHA256 (per-install key,
 *   per-entry salt), then dropped the text. Without the key the value can't be used to test
 *   guesses offline, as a plain hash of "Yes, approved" could be; check-source answers only
 *   match / no match, never a hash of what it was given.
 * - by "client": the caller sent a SHA-256 its own tool made. Open CRM never saw the text.
 */
export type SourceDigest = {
  alg: "sha256" | "hmac-sha256";
  canon: string;
  value: string;
  by: "crm" | "client";
  /** hmac-sha256 only: which key made it, so a key change reads as "can't check", not "edited". */
  kid?: string;
  /**
   * hmac-sha256 only: random per write call, so separate writes based on the same text don't get
   * equal fingerprints. Entries from one call (e.g. a bulk upsert) share it, as they share the link.
   */
  salt?: string;
};

/**
 * Ways of turning source text into bytes before hashing. Stored with the hash so it can change
 * later. Any other canon name (a client's own, or "unspecified") can only be compared hash to hash.
 */
const CANONS: Record<string, (t: string) => string> = Object.assign(Object.create(null), {
  /**
   * Unicode NFC; each run of White_Space characters (incl. line breaks, NBSP) becomes one space;
   * then one leading and one trailing space are dropped. Not String.trim(), which also strips
   * U+FEFF: the rule has to be easy to match exactly in other languages.
   */
  "text-v1": (t: string) => t.normalize("NFC").replace(/\p{White_Space}+/gu, " ").replace(/^ | $/g, ""),
  /** The UTF-8 bytes exactly as given. */
  raw: (t: string) => t,
});
export const canRecompute = (canon: string) => Object.hasOwn(CANONS, canon);

let sourceKey: Buffer | undefined;
let sourceKid = "";
/** Set on boot (see initAuth): the per-install secret for fingerprints Open CRM makes. */
export function setSourceKey(secret: string) {
  sourceKey = createHash("sha256").update(`open-crm source digest\n${secret}`).digest();
  sourceKid = createHmac("sha256", sourceKey).update("open-crm source digest kid").digest("hex").slice(0, 16);
}

/** Hash text the way a stored digest was made: canon first, then plain SHA-256 or the install's salted HMAC. */
export function digestText(text: string, canon: string, alg: SourceDigest["alg"], salt = ""): string {
  const bytes = CANONS[canon](text);
  if (alg === "sha256") return createHash("sha256").update(bytes, "utf8").digest("hex");
  if (!sourceKey) throw new Error("source digest key not loaded");
  return createHmac("sha256", sourceKey).update(`${salt}\n`).update(bytes, "utf8").digest("hex");
}

/** Longest source text accepted for hashing (it is never stored). */
const MAX_SOURCE_TEXT = 1_000_000;

/** "sha256:<hex>" or "sha256:<canon>:<hex>", or {alg?, canon?, value}. */
function checkDigest(input: unknown): SourceDigest {
  let alg: unknown, canon: unknown, value: unknown;
  if (typeof input === "string") {
    const parts = input.trim().split(":");
    if (parts.length === 2) [alg, value] = parts;
    else if (parts.length === 3) [alg, canon, value] = parts;
    else throw new CrmError('source.digest must look like "sha256:<64 hex>" or "sha256:<canon>:<64 hex>"');
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    ({ alg = "sha256", canon, value } = input as Record<string, unknown>);
  } else throw new CrmError("source.digest must be a string or {alg, canon, value}");
  if (alg !== "sha256") throw new CrmError("source.digest: only sha256 is supported");
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new CrmError("source.digest value must be 64 hex characters (sha256)");
  if (canon === undefined || canon === null || canon === "") canon = "unspecified";
  if (typeof canon !== "string" || !/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(canon)) {
    throw new CrmError("source.digest canon must be a short name like text-v1 or gmail-plain-v1");
  }
  return { alg: "sha256", canon: canon.toLowerCase(), value: value.toLowerCase(), by: "client" };
}

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
  if (typeof raw !== "object" || Array.isArray(raw)) throw new CrmError("source must be {url, label?, text?, digest?}");
  const { url, label, text: body, digest } = raw as Record<string, unknown>;
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
  const out: Source = text ? { url: parsed.href, label: text } : { url: parsed.href };
  // Empty text (or only whitespace) is treated like no text, as an empty digest is: the link alone
  // is still a valid source, and a model may fill the optional field with "".
  if (body !== undefined && body !== null && typeof body !== "string") throw new CrmError("source.text must be a string");
  const hasBody = typeof body === "string" && CANONS["text-v1"](body) !== "";
  const hasDigest = digest !== undefined && digest !== null && digest !== "";
  if (hasBody && hasDigest) throw new CrmError("Pass source.text or source.digest, not both");
  if (hasBody) {
    if (body.length > MAX_SOURCE_TEXT) throw new CrmError("source.text is longer than 1,000,000 characters");
    const salt = randomBytes(16).toString("hex");
    out.digest = { alg: "hmac-sha256", canon: "text-v1", value: digestText(body, "text-v1", "hmac-sha256", salt), by: "crm", salt, kid: sourceKid };
  } else if (hasDigest) out.digest = checkDigest(digest);
  return out;
}

/**
 * Only the verdict: echoing what the text hashed to would hand a read key the install's HMAC of
 * any guess it likes.
 */
export type SourceCheck = { match: boolean };

/** Compare a source's stored digest with text (hashed the same way) or with a digest the caller made. */
export function compareSource(stored: SourceDigest, input: { text?: unknown; digest?: unknown }): SourceCheck {
  const hasText = input.text !== undefined && input.text !== null;
  const hasDigest = input.digest !== undefined && input.digest !== null && input.digest !== "";
  if (hasText === hasDigest) throw new CrmError("Pass text or digest (one of them)");
  let computed: string;
  if (hasText) {
    if (typeof input.text !== "string") throw new CrmError("text must be a string");
    if (input.text.length > MAX_SOURCE_TEXT) throw new CrmError("text is longer than 1,000,000 characters");
    if (!canRecompute(stored.canon)) {
      throw new CrmError(`This source was hashed as "${stored.canon}", which the CRM can't reproduce from text. Hash it with the same tool and pass digest.`);
    }
    if (stored.alg === "hmac-sha256" && stored.kid !== sourceKid) {
      throw new CrmError("This fingerprint was made with a different key than this Open CRM now has (SOURCE_DIGEST_KEY changed or was lost), so it can't be checked. It says nothing about whether the source changed.", 409);
    }
    computed = digestText(input.text, stored.canon, stored.alg, stored.salt);
  } else {
    if (stored.alg !== "sha256") {
      throw new CrmError("This fingerprint was made by Open CRM with a key only it holds, so it can only be checked against text. Pass text.");
    }
    const d = checkDigest(input.digest);
    // A digest without a canon is taken to use the stored one; a different named canon can't be compared.
    if (d.canon !== "unspecified" && d.canon !== stored.canon) {
      throw new CrmError(`This source was hashed as "${stored.canon}", not "${d.canon}". The hashes can't be compared.`);
    }
    computed = d.value;
  }
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(stored.value, "hex");
  return { match: a.length === b.length && timingSafeEqual(a, b) };
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
