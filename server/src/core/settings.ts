import { getSetting, setSetting } from "../db.js";
import { CrmError } from "./types.js";

export type UiSettings = { theme: "system" | "light" | "dark"; accent: string };

const DEFAULTS: UiSettings = { theme: "system", accent: "#4f46e5" };
export const OBJECT_COLORS = ["gray", "blue", "violet", "green", "amber", "orange", "red", "teal", "pink"] as const;

/** A color is a palette name (follows light/dark theme) or a custom #rrggbb hex. */
export const isColor = (c: unknown): c is string =>
  typeof c === "string" && ((OBJECT_COLORS as readonly string[]).includes(c) || /^#[0-9a-f]{6}$/i.test(c));

export async function getUiSettings(): Promise<UiSettings> {
  return { ...DEFAULTS, ...((await getSetting<Partial<UiSettings>>("ui")) ?? {}) };
}

export async function updateUiSettings(patch: Partial<UiSettings>) {
  const next = { ...(await getUiSettings()) };
  if (patch.theme !== undefined) {
    if (!["system", "light", "dark"].includes(patch.theme)) throw new CrmError('theme must be "system", "light" or "dark"');
    next.theme = patch.theme;
  }
  if (patch.accent !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(patch.accent)) throw new CrmError("accent must be a hex color like #4f46e5");
    next.accent = patch.accent.toLowerCase();
  }
  await setSetting("ui", next);
  return next;
}
