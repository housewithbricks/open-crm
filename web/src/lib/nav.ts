import { useNavigate } from "@tanstack/react-router";

/** Open (or close) the record drawer on the current page via the global ?r= search param. */
export function useOpenRecord() {
  const navigate = useNavigate();
  return (id: string | null) =>
    navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, r: id ?? undefined }) } as never);
}
