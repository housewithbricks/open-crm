import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, queryClient } from "./api";

export type UiSettings = { theme: "system" | "light" | "dark"; accent: string };

export const ACCENTS = [
  { name: "Indigo", hex: "#4f46e5" },
  { name: "Blue", hex: "#2563eb" },
  { name: "Teal", hex: "#0d9488" },
  { name: "Green", hex: "#16a34a" },
  { name: "Amber", hex: "#d97706" },
  { name: "Orange", hex: "#ea580c" },
  { name: "Rose", hex: "#e11d48" },
  { name: "Violet", hex: "#7c3aed" },
  { name: "Graphite", hex: "#3f3f46" },
];

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Apply theme + accent to <html> and cache them so the next load paints correctly at once. */
export function applyUi(ui: UiSettings) {
  const root = document.documentElement;
  const dark = ui.theme === "dark" || (ui.theme === "system" && !!media?.matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.style.setProperty("--accent-base", ui.accent);
  // Text on accent buttons: dark text on light accents, white otherwise (dark mode lightens the accent).
  root.style.setProperty("--accent-ink", dark || luminance(ui.accent) > 0.45 ? "#0f0f0f" : "#ffffff");
  try { localStorage.setItem("ocrm-ui", JSON.stringify(ui)); } catch {}
}

/** Load the saved appearance and keep "System" in sync with the OS. */
export function useAppearance() {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api<UiSettings>("/settings"), staleTime: Infinity });
  useEffect(() => {
    if (!data) return;
    applyUi(data);
    if (data.theme !== "system" || !media) return;
    const h = () => applyUi(data);
    media.addEventListener("change", h);
    return () => media.removeEventListener("change", h);
  }, [data]);
  return data;
}

export function useSaveAppearance() {
  return useMutation({
    mutationFn: (patch: Partial<UiSettings>) => api<UiSettings>("/settings", { method: "PATCH", body: patch }),
    onMutate: (patch) => {
      const cur = queryClient.getQueryData<UiSettings>(["settings"]);
      if (cur) {
        const next = { ...cur, ...patch };
        queryClient.setQueryData(["settings"], next);
        applyUi(next);
      }
    },
    onSuccess: (ui) => queryClient.setQueryData(["settings"], ui),
  });
}
