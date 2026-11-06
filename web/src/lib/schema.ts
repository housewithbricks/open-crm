import { useQuery } from "@tanstack/react-query";
import { api, type ObjectType } from "./api";

export function useSchema() {
  return useQuery({
    queryKey: ["schema"],
    queryFn: () => api<{ objects: ObjectType[]; counts: Record<string, number> }>("/schema"),
  });
}

export function useObject(slug?: string) {
  const { data } = useSchema();
  return data?.objects.find((o) => o.slug === slug);
}
