import { CrmError, type FieldDef, type ObjectType } from "./types.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function matchChoice(field: FieldDef, raw: unknown): string {
  const choices = field.options.choices ?? [];
  const s = String(raw).trim().toLowerCase();
  const hit = choices.find((c) => c.value.toLowerCase() === s || c.label.toLowerCase() === s);
  if (!hit) {
    throw new CrmError(
      `"${raw}" is not an option for ${field.key}. Valid: ${choices.map((c) => c.value).join(", ") || "(none yet)"}`,
    );
  }
  return hit.value;
}

/** Coerce and validate one value. Returns null for blank input. */
export function coerceValue(field: FieldDef, raw: unknown): unknown {
  if (isBlank(raw)) return null;
  const bad = (msg: string) => new CrmError(`${field.key}: ${msg}`);
  switch (field.type) {
    case "text":
    case "long_text":
    case "phone":
      if (typeof raw === "object") throw bad("expected a string");
      return String(raw).trim();
    case "email": {
      const s = String(raw).trim().toLowerCase();
      if (!EMAIL_RE.test(s)) throw bad(`"${raw}" is not a valid email`);
      return s;
    }
    case "url": {
      const s = String(raw).trim();
      if (/\s/.test(s) || !s.includes(".")) throw bad(`"${raw}" is not a valid URL or domain`);
      return s;
    }
    case "number":
    case "currency": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,$\s]/g, ""));
      if (!Number.isFinite(n)) throw bad(`"${raw}" is not a number`);
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (["true", "yes", "1"].includes(String(raw).toLowerCase())) return true;
      if (["false", "no", "0"].includes(String(raw).toLowerCase())) return false;
      throw bad(`"${raw}" is not a boolean`);
    case "date": {
      const s = String(raw).trim();
      if (Number.isNaN(Date.parse(s))) throw bad(`"${raw}" is not a date (use YYYY-MM-DD)`);
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(s).toISOString();
    }
    case "select":
      return matchChoice(field, raw);
    case "multi_select": {
      const arr = Array.isArray(raw) ? raw : String(raw).split(",");
      return [...new Set(arr.filter((x) => !isBlank(x)).map((x) => matchChoice(field, x)))];
    }
    case "relation": {
      const arr = Array.isArray(raw) ? raw : [raw];
      for (const id of arr) if (!UUID_RE.test(String(id))) throw bad(`"${id}" is not a record id`);
      return field.options.multiple ? arr.map(String) : String(arr[0]);
    }
  }
}

/**
 * Validate a data patch against an object's fields.
 * mode "create" enforces required fields; "update" only checks keys present.
 */
export function validateData(obj: ObjectType, input: Record<string, unknown>, mode: "create" | "update") {
  const byKey = new Map(obj.fields.map((f) => [f.key, f]));
  const unknown = Object.keys(input).filter((k) => !byKey.has(k));
  if (unknown.length) {
    throw new CrmError(
      `Unknown field(s) on ${obj.slug}: ${unknown.join(", ")}. Valid fields: ${[...byKey.keys()].join(", ")}`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = coerceValue(byKey.get(k)!, v);
  for (const f of obj.fields) {
    if (!f.required) continue;
    const missing = mode === "create" ? isBlank(out[f.key]) : f.key in out && isBlank(out[f.key]);
    if (missing) throw new CrmError(`${f.key} is required`);
  }
  return out;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

const isColor = (c: unknown): c is string =>
  typeof c === "string" && (/^#[0-9a-f]{6}$/i.test(c) || ["gray", "blue", "violet", "green", "amber", "orange", "red", "teal", "pink"].includes(c));

type ChoiceInput = string | { value?: string; label: string; color?: string; kind?: string; probability?: number | null };

export function normalizeChoices(input: ChoiceInput[] = []) {
  const palette = ["gray", "blue", "violet", "amber", "orange", "green", "red", "teal", "pink"];
  return input.map((c, i) => {
    const label = typeof c === "string" ? c : c.label;
    // A label with no letters or digits (e.g. "!!!") still needs a value.
    const value = (typeof c === "string" ? slugify(c) : c.value || slugify(c.label)) || `option_${i + 1}`;
    // Palette names or #rrggbb only; anything else falls back to the palette.
    const color = typeof c !== "string" && isColor(c.color) ? c.color.toLowerCase() : palette[i % palette.length];
    const out: { value: string; label: string; color: string; kind?: "open" | "won" | "lost"; probability?: number } = { value, label, color };
    if (typeof c !== "string") {
      if (c.kind !== undefined && c.kind !== null) {
        if (!["open", "won", "lost"].includes(c.kind)) throw new CrmError(`Option "${label}": kind must be open, won or lost`);
        out.kind = c.kind as "open" | "won" | "lost";
      }
      if (c.probability !== undefined && c.probability !== null) {
        const p = Number(c.probability);
        if (!Number.isFinite(p) || p < 0 || p > 100) throw new CrmError(`Option "${label}": probability must be 0-100`);
        out.probability = Math.round(p);
      }
    }
    return out;
  });
}
