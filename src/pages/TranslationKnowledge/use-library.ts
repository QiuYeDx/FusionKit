import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DeleteRecordsRequest, KnowledgeEntity, KnowledgeErrorCode, KnowledgeResult, LibrarySnapshot, SaveItem } from "@/translation-knowledge/ipc-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { announceKnowledgeChange, KNOWLEDGE_CHANGED_EVENT, newerSnapshot } from "@/translation-knowledge/library-events";

export type LibraryError = KnowledgeErrorCode | "unexpected";
/** How long a deletion can be undone. */
export const UNDO_MS = 10_000;

/**
 * The library as the page sees it. Every write goes through one transaction and replaces the
 * snapshot with the published one; a revision conflict reloads so the next attempt starts fresh.
 */
export function useLibrary() {
  const { t } = useTranslation("knowledge");
  const api = window.translationKnowledge;
  const [snapshot, setSnapshotState] = useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LibraryError | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const latest = useRef<LibrarySnapshot | null>(null);
  const setSnapshot = useCallback((next: LibrarySnapshot) => {
    latest.current = newerSnapshot(latest.current, next);
    setSnapshotState(latest.current);
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true); setError(null); setDiagnostics([]);
    try {
      const result = await api.read();
      if (result.ok) { latest.current = result.value; setSnapshotState(result.value); }
      else { setError(result.error); setDiagnostics(result.diagnostics ?? []); }
    } catch { setError("unexpected"); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  // The assistant and Studio dialogs save without this page; show their result as it lands.
  useEffect(() => {
    const changed = (event: Event) => { const incoming = (event as CustomEvent<LibrarySnapshot>).detail; if (incoming) setSnapshot(incoming); };
    window.addEventListener(KNOWLEDGE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(KNOWLEDGE_CHANGED_EVENT, changed);
  }, [setSnapshot]);

  const published = useCallback((next: LibrarySnapshot) => { setSnapshot(next); announceKnowledgeChange(next); }, [setSnapshot]);
  const failed = useCallback((code: LibraryError) => {
    if (code === "revision_conflict") { toast.error(t("errors.changed_elsewhere")); void refresh(); }
    return code;
  }, [refresh, t]);

  /** Saves records together; resolves to the error code when nothing was saved. */
  const save = useCallback(async (items: SaveItem[] | KnowledgeEntity, group?: SaveItem["group"]): Promise<LibraryError | null> => {
    const current = latest.current;
    if (!current) return "storage_unavailable";
    const list = Array.isArray(items) ? items : [{ group: group ?? "entries", record: items }];
    try {
      const result = await api.saveRecords({ generation: current.generation, items: list });
      if (result.ok) { published(result.value); return null; }
      return failed(result.error);
    } catch { return "unexpected"; }
  }, [api, failed, published]);

  /** Deletes at once and offers to undo for a while; undo restores everything or nothing. */
  const remove = useCallback(async (items: DeleteRecordsRequest["items"], message: string): Promise<LibraryError | null> => {
    const current = latest.current;
    if (!current || !items.length) return "storage_unavailable";
    let result: KnowledgeResult<{ snapshot: LibrarySnapshot; deleted: Parameters<typeof api.restoreRecords>[0]["records"] }>;
    try { result = await api.deleteRecords({ generation: current.generation, items }); } catch { return "unexpected"; }
    if (!result.ok) return failed(result.error);
    published(result.value.snapshot);
    const deleted = result.value.deleted;
    toast(message, { duration: UNDO_MS, id: `knowledge-undo-${result.value.snapshot.generation}`, action: { label: t("undo.action"), onClick: async () => {
      const now = latest.current;
      if (!now) return;
      try {
        let restored = await api.restoreRecords({ generation: now.generation, records: deleted });
        // Something else saved meanwhile without telling this page: retry once on the newest generation.
        if (!restored.ok && restored.error === "revision_conflict") {
          const fresh = await api.read();
          if (fresh.ok) { setSnapshot(fresh.value); restored = await api.restoreRecords({ generation: fresh.value.generation, records: deleted }); }
        }
        if (restored.ok) { published(restored.value); toast.success(t("undo.done")); return; }
        toast.error(t("undo.failed"), { description: t(restored.error === "import_conflict" ? "undo.reason_exists" : restored.error === "revision_conflict" ? "undo.reason_changed" : `errors.${restored.error}`) });
        if (restored.error === "revision_conflict") void refresh();
      } catch { toast.error(t("undo.failed")); }
    } } });
    return null;
  }, [api, failed, published, refresh, t]);

  return { api, snapshot, loading, error, diagnostics, refresh, save, remove, setSnapshot: published };
}
