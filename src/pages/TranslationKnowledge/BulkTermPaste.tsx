import { useReducedMotionPreference } from '@/hooks/use-reduced-motion';
import { forwardRef, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { DialogMotionRegion, DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { useTranslation } from "react-i18next";
import { Check as CheckIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Collection } from "@/translation-knowledge/schemas";
import type { KnowledgeErrorCode, LibrarySnapshot, TranslationKnowledgeApi } from "@/translation-knowledge/ipc-contract";
import { Check, Choice, ErrorNotice, KnowledgeDialog } from "./Controls";
import { languagePairLabel } from "./labels";
import { entryStatus, freshId, manualEntryRequest, newEntry } from "./model";
import { parseTermPaste, pastedTermProblem, type PastedTerm, type PasteProblem } from "./term-paste";

type Row = PastedTerm & { id: string; saved: boolean };
const PasteRow = forwardRef<HTMLDivElement, { row: Row; failed: boolean; children: ReactNode }>(function PasteRow({ row, failed, children }, ref) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotionPreference();
  return <motion.div ref={ref} layout={reducedMotion ? false : 'position'}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    transition={{ opacity: { duration: reducedMotion ? 0 : 0.14 }, layout: { duration: reducedMotion ? 0 : 0.24, type: 'spring', bounce: 0 } }}
    inert={!present} aria-hidden={!present || undefined}
    className={`space-y-2 rounded-md border p-3 ${failed ? "border-destructive/60" : ""}`}
    data-paste-row={row.id} data-saved={row.saved}
  >{children}</motion.div>;
});
export function BulkTermPaste({ collection, api, onSnapshot, onClose }: {
  collection: Collection;
  api: TranslationKnowledgeApi;
  onSnapshot: (snapshot: LibrarySnapshot) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("knowledge");
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"auto" | "tab" | "comma">("auto");
  const [skipHeader, setSkipHeader] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [problem, setProblem] = useState<PasteProblem | null>(null);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(null);
  const [pending, setPending] = useState(false);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const lock = useRef(false);
  const saved = rows?.filter(row => row.saved).length ?? 0;
  const remaining = rows?.filter(row => !row.saved) ?? [];
  const invalid = remaining.some(row => pastedTermProblem(row));
  const duplicates = remaining.some((row, index) => remaining.slice(0, index).some(other => other.source.trim().normalize("NFC") === row.source.trim().normalize("NFC")));
  const parse = () => {
    const result = parseTermPaste(text, format, skipHeader);
    setProblem(result.ok ? null : result.problem);
    if (result.ok) setRows(result.rows.map(row => ({ ...row, id: freshId(), saved: false })));
  };
  const save = async () => {
    if (lock.current || !rows || invalid || duplicates || !remaining.length) return;
    lock.current = true; setPending(true); setError(null); setFailedId(null); setDuplicateId(null);
    let activeId: string | null = null;
    try {
      const read = await api.read();
      if (!read.ok) { setError(read.error); return; }
      let snapshot = read.value;
      onSnapshot(snapshot);
      for (const row of rows) {
        if (row.saved) continue;
        activeId = row.id;
        const existing = snapshot.data.entries.find(entry => entry.id === row.id);
        // An uncertain response may already have committed. Reconcile the stable ID
        // before retrying, so successful writes cannot turn into duplicate terms.
        if (existing) {
          if (existing.kind !== "term" || existing.payload.source !== row.source.trim() || existing.payload.target !== row.target.trim() || existing.payload.sense !== row.note.trim() || entryStatus(existing, snapshot) !== "ready") {
            setError("revision_conflict"); setFailedId(row.id); return;
          }
        } else {
          const currentCollection = snapshot.data.collections.find(item => item.id === collection.id);
          if (!currentCollection || currentCollection.archived) { setError("not_found"); setFailedId(row.id); return; }
          if (JSON.stringify(currentCollection.defaultLanguagePair) !== JSON.stringify(collection.defaultLanguagePair)) {
            setError("revision_conflict"); setFailedId(row.id); return;
          }
          const pair = currentCollection.defaultLanguagePair ?? { source: "ja", target: "zh-Hans" };
          const duplicate = snapshot.data.entries.some(entry => entry.kind === "term" && entry.state !== "archived" && entry.collectionId === collection.id && entry.scope.languagePair.source === pair.source && entry.scope.languagePair.target === pair.target && entry.payload.source.trim().normalize("NFC") === row.source.trim().normalize("NFC"));
          if (duplicate) { setDuplicateId(row.id); setFailedId(row.id); return; }
          const entry = newEntry(currentCollection);
          entry.id = row.id;
          if (entry.kind !== "term") return;
          entry.payload = { ...entry.payload, source: row.source.trim(), target: row.target.trim(), sense: row.note.trim() };
          const result = await api.saveRecord(manualEntryRequest(entry, snapshot, true, t("source.manual")));
          if (!result.ok) { setError(result.error); setFailedId(row.id); return; }
          snapshot = result.value;
          onSnapshot(snapshot);
        }
        setRows(current => current?.map(value => value.id === row.id ? { ...value, saved: true } : value) ?? null);
      }
    } catch { setError("unexpected"); setFailedId(activeId); }
    finally { lock.current = false; setPending(false); }
  };
  const update = (id: string, key: keyof PastedTerm, value: string) => setRows(current => current?.map(row => row.id === id && !row.saved ? { ...row, [key]: value } : row) ?? null);
  return <KnowledgeDialog title={t("paste.title")} description={`${collection.name}${collection.defaultLanguagePair ? ` · ${languagePairLabel(t, collection.defaultLanguagePair)}` : ""}`} pending={pending} onClose={onClose} footer={
    rows ? <>
      <span className="mr-auto text-xs text-muted-foreground" role="status">{t("paste.progress", { saved, total: rows.length })}</span>
      {remaining.length ? <Button data-testid="knowledge-paste-save" size="sm" disabled={pending || invalid || duplicates} onClick={() => void save()}>{t(pending ? "actions.saving" : saved ? "paste.retry" : "paste.save")}</Button> : <Button size="sm" onClick={onClose}>{t("tour.finish")}</Button>}
    </> : <Button data-testid="knowledge-paste-preview" size="sm" onClick={parse}>{t("paste.preview")}</Button>
  }>
    <div>
    <DialogTransition transitionKey={rows ? 'review' : 'input'}>
    {!rows ? <div className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">{t("paste.help")}</p>
      <Textarea data-testid="knowledge-paste-input" aria-label={t("paste.input")} rows={8} value={text} onChange={event => setText(event.target.value)} placeholder={"checkpoint\t存档点\nsave slot\t存档槽"} className="font-mono text-xs" />
      <Choice label={t("paste.format")} value={format} onChange={value => setFormat(value as typeof format)} options={[{ value: "auto", label: t("paste.auto") }, { value: "tab", label: "TSV" }, { value: "comma", label: "CSV" }]} />
      <div>
        <Check label={t("paste.header")} checked={skipHeader} onChange={setSkipHeader} />
        <DialogTransition transitionKey={problem ?? 'valid'} stageClassName="pt-4">{problem && <p role="alert" className="text-sm text-destructive">{t(`paste.error_${problem}`)}</p>}</DialogTransition>
      </div>
    </div> : <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">{t("paste.review_help")}</p>
      <div>
      <DialogMotionRegion><div className="relative flex flex-col gap-2" data-testid="knowledge-paste-rows">
        <AnimatePresence mode="popLayout" initial={false}>
        {rows.map((row, index) => <PasteRow key={row.id} row={row} failed={row.id === failedId}>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{index + 1}</span>{row.saved ? <span className="flex items-center gap-1"><CheckIcon className="size-3.5" />{t("paste.saved")}</span> : <Button variant="ghost" size="icon-xs" disabled={pending} aria-label={t("paste.remove", { row: index + 1 })} onClick={() => setRows(current => current?.filter(value => value.id !== row.id) ?? null)}><Trash2 /></Button>}</div>
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label={`${t("fields.source_text")} ${index + 1}`} value={row.source} disabled={pending || row.saved} onChange={event => update(row.id, "source", event.target.value)} className="h-8 text-sm" />
            <Input aria-label={`${t("fields.target_text")} ${index + 1}`} value={row.target} disabled={pending || row.saved} onChange={event => update(row.id, "target", event.target.value)} className="h-8 text-sm" />
          </div>
          <div>
            <Input aria-label={`${t("workspace.note")} ${index + 1}`} placeholder={t("workspace.note")} value={row.note} disabled={pending || row.saved} onChange={event => update(row.id, "note", event.target.value)} className="h-8 text-xs" />
            <DialogTransition transitionKey={!row.saved ? pastedTermProblem(row) ?? 'valid' : 'saved'} stageClassName="pt-2">{!row.saved && pastedTermProblem(row) && <p className="text-xs text-destructive">{t(pastedTermProblem(row) === "required" ? "paste.row_required" : "paste.error_limit")}</p>}</DialogTransition>
            <DialogTransition transitionKey={row.id === duplicateId ? 'duplicate' : 'valid'} stageClassName="pt-2">{row.id === duplicateId && <p role="alert" className="text-xs text-destructive">{t("paste.existing")}</p>}</DialogTransition>
          </div>
        </PasteRow>)}
        </AnimatePresence>
      </div></DialogMotionRegion>
      <DialogTransition transitionKey={duplicates ? 'duplicates' : 'valid'} stageClassName="pt-3">{duplicates && <p role="alert" className="text-sm text-destructive">{t("paste.duplicates")}</p>}</DialogTransition>
      <DialogTransition transitionKey={saved > 0 && remaining.length > 0 ? 'partial' : 'complete'} stageClassName="pt-3">{saved > 0 && remaining.length > 0 && <p role="status" className="text-xs leading-5 text-muted-foreground">{t("paste.partial")}</p>}</DialogTransition>
      <DialogTransition transitionKey={saved ? 'saved' : 'review'} stageClassName="pt-3">{!saved && <Button variant="ghost" size="sm" disabled={pending} onClick={() => { setRows(null); setError(null); }}>{t("paste.back")}</Button>}</DialogTransition>
      </div>
    </div>}
    </DialogTransition>
    <ErrorNotice error={error} stageClassName="pt-4" />
    </div>
  </KnowledgeDialog>;
}
