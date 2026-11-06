import { twMerge } from "tailwind-merge";

export const fmtMoney = (n: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

/**
 * Compact money for headline numbers: $578K, $1.2M. Pass `compact` to format a whole list or
 * axis the same way (e.g. compact for every value once the largest is 100K or more).
 */
export const fmtMoneyCompact = (n: number, currency = "USD", compact = Math.abs(n) >= 100_000) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency, notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 0 }).format(n);

export function fmtDate(v: string) {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T00:00:00" : v);
  if (Number.isNaN(+d)) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * A date field's value. Date fields hold YYYY-MM-DD; older values may be timestamps, whose
 * date part is the stored day. Either way the day shows as stored, in every timezone.
 */
export const fmtDay = (v: string) => fmtDate(/^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v);

export function timeAgo(v: string) {
  const s = (Date.now() - +new Date(v)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(v);
}

export const initials = (s: string) => s.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** Join class names, skipping falsy ones; later Tailwind classes win conflicts (w-full + w-[220px] → w-[220px]). */
export const cn = (...c: (string | false | null | undefined)[]) => twMerge(c.filter(Boolean).join(" "));

const OBJ_PALETTE = ["blue", "violet", "green", "amber", "pink", "teal", "orange", "red"];

/** CSS color for a palette name (theme-aware) or a custom #hex. */
export const dot = (color?: string) => (color && /^#[0-9a-f]{6}$/i.test(color) ? color : `var(--d-${color || "gray"})`);

/** An object's color name or hex (falls back to a stable pick from its slug). */
export function objColor(obj?: { slug: string; color?: string } | null, slug?: string) {
  if (obj?.color) return obj.color;
  const s = obj?.slug ?? slug ?? "";
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OBJ_PALETTE[h % OBJ_PALETTE.length];
}

/** A soft background tint of any CSS color. */
export const tint = (color: string, pct = 16) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
