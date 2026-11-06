import { api, ApiError, invalidateAll } from "./api";

/** Undo an audit entry. On a conflict, ask before overwriting newer edits. */
export async function undoEntry(id: string) {
  try {
    await api(`/audit/${id}/undo`, { body: {} });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.details?.conflict) {
      if (!confirm(`${e.message}`)) return;
      await api(`/audit/${id}/undo`, { body: { force: true } });
    } else {
      alert(e instanceof Error ? e.message : String(e));
      return;
    }
  }
  await invalidateAll();
}
