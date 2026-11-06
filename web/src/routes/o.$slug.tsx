import { createFileRoute } from "@tanstack/react-router";
import type { Filter } from "../lib/api";
import ObjectPage from "../pages/ObjectPage";

export type ObjectSearch = {
  r?: string;
  /** saved view id */
  v?: string;
  tab?: "fields";
  /** filters, e.g. from a dashboard drill-down */
  f?: Filter[];
  /** table or board */
  k?: "table" | "board";
};

export const Route = createFileRoute("/o/$slug")({
  validateSearch: (s: Record<string, unknown>): ObjectSearch => ({
    ...(typeof s.r === "string" && s.r ? { r: s.r } : {}),
    ...(typeof s.v === "string" && s.v ? { v: s.v } : {}),
    ...(s.tab === "fields" ? { tab: "fields" as const } : {}),
    ...(Array.isArray(s.f) ? { f: s.f as Filter[] } : {}),
    ...(s.k === "table" || s.k === "board" ? { k: s.k } : {}),
  }),
  component: ObjectPage,
});
