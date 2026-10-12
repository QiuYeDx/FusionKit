import { useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SaveItem, LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import type { Collection } from "@/translation-knowledge/schemas";
import { cn } from "@/lib/utils";
import { Check, Choice, ErrorNotice, KnowledgeDialog } from "./Controls";
import { KnowledgeScrollList } from "./KnowledgeScrollList";
import { languagePairLabel } from "./labels";
import { newTerm } from "./model";
import { withPayload } from "./TermTable";
import { classifyPaste, parseTermPaste, type ClassifiedPaste, type PasteProblem } from "./term-paste";
import type { LibraryError } from "./use-library";

/** Two-column text pasted from a sheet: preview what is new, already saved or different, then save in one go. */
export function BulkTermPaste(props: { collection: Collection | null; snapshot: LibrarySnapshot | null;
  onSave: (items: SaveItem[]) => Promise<LibraryError | null>; onClose: () => void }) {
  return <AnimatePresence>{props.collection && props.snapshot && <PasteForm key={props.collection.id} {...props} collection={props.collection} snapshot={props.snapshot} />}</AnimatePresence>;
}

function PasteForm({ collection, snapshot, onSave, onClose }: Parameters<typeof BulkTermPaste>[0] & { collection: Collection; snapshot: LibrarySnapshot }) {
  const { t } = useTranslation("knowledge");
  const [text, setText] = useState("");
  const [format, setFormat] = useState<"auto" | "tab" | "comma">("auto");
  const [skipHeader, setSkipHeader] = useState(false);
  const [parsed, setParsed] = useState<ClassifiedPaste[] | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [problem, setProblem] = useState<PasteProblem | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LibraryError | null>(null);
  const lock = useRef(false);
  // Classified against the newest library, so a save elsewhere is reflected before writing.
  const rows = useMemo(() => parsed && classifyPaste(snapshot.data.entries, collection.id, parsed.map(item => item.row)), [parsed, snapshot, collection.id]);
  const count = (status: ClassifiedPaste["status"]) => rows?.filter(item => item.status === status).length ?? 0;
  const writes = rows?.filter(item => item.status === "new" || overwrite && item.status === "conflict").length ?? 0;
  const preview = () => {
    const result = parseTermPaste(text, format, skipHeader);
    setProblem(result.ok ? null : result.problem);
    if (result.ok) setParsed(result.rows.map(row => ({ row, status: "new" })));
  };
  const save = async () => {
    if (!rows || !writes || lock.current) return;
    lock.current = true; setPending(true); setError(null);
    const items: SaveItem[] = rows.flatMap(({ row, status, existing }): SaveItem[] => {
      if (status === "new") { const record = newTerm(collection.id, row.source, row.target); record.payload.note = row.note.trim(); return [{ group: "entries", record }]; }
      if (status === "conflict" && overwrite && existing) return [{ group: "entries", record: withPayload(existing, { target: row.target.trim(), ...(row.note.trim() ? { note: row.note.trim() } : {}) }) }];
      return [];
    });
    const failure = await onSave(items);
    lock.current = false; setPending(false);
    if (failure) setError(failure); else onClose();
  };
  return <KnowledgeDialog wide title={t("paste.title")} description={`${collection.name} · ${languagePairLabel(t, collection.languagePair)}`} pending={pending} onClose={onClose} footer={
    rows ? <>
      <Button variant="ghost" size="sm" className="mr-auto" disabled={pending} onClick={() => setParsed(null)}>{t("paste.back")}</Button>
      <Button data-testid="knowledge-paste-save" size="sm" disabled={pending || !writes} onClick={() => void save()}>{pending && <LoaderCircle className="animate-spin" />}{t("paste.save", { count: writes })}</Button>
    </> : <Button data-testid="knowledge-paste-preview" size="sm" disabled={!text.trim()} onClick={preview}>{t("paste.preview")}</Button>
  }>
    <DialogTransition transitionKey={rows ? "review" : "input"}>{!rows ? <div className="space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">{t("paste.help")}</p>
      <Textarea data-testid="knowledge-paste-input" aria-label={t("paste.input")} rows={8} value={text} onChange={event => setText(event.target.value)} placeholder={"checkpoint\t存档点\nsave slot\t存档槽"} className="font-mono text-xs" />
      <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
        <Choice label={t("paste.format")} value={format} onChange={value => setFormat(value as typeof format)} options={[{ value: "auto", label: t("paste.auto") }, { value: "tab", label: "TSV" }, { value: "comma", label: "CSV" }]} />
        <div className="pb-1.5"><Check label={t("paste.header")} checked={skipHeader} onChange={setSkipHeader} /></div>
      </div>
      {problem && <p role="alert" className="text-sm text-destructive">{t(`paste.error_${problem}`)}</p>}
    </div> : <div className="space-y-3">
      <p data-testid="knowledge-paste-summary" className="text-xs leading-5 text-muted-foreground">{t("paste.summary", { added: count("new"), same: count("same"), conflict: count("conflict"), invalid: count("invalid") + count("repeated") })}</p>
      <div className="rounded-md border"><KnowledgeScrollList testId="knowledge-paste-rows" maxHeight="min(22rem, 46vh)" contentClassName="divide-y">
        {rows.map((item, index) => <div key={index} data-paste-status={item.status} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-start gap-3 px-3 py-2 text-[13px] leading-5">
          <span className="[overflow-wrap:anywhere]">{item.row.source || "—"}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{item.row.target || "—"}
            {item.status === "conflict" && <span className="block text-[11px] text-muted-foreground">{t("paste.saved_as", { target: item.existing?.payload.target })}</span>}</span>
          <Badge variant="outline" className={cn("h-5 px-1.5 text-[11px] font-normal", item.status === "conflict" && "border-amber-500/40 text-amber-700 dark:text-amber-400",
            (item.status === "invalid" || item.status === "repeated") && "border-destructive/40 text-destructive")}>{t(`paste.status_${item.status}`)}</Badge>
        </div>)}
      </KnowledgeScrollList></div>
      {count("conflict") > 0 && <Check label={t("paste.overwrite", { count: count("conflict") })} checked={overwrite} onChange={setOverwrite} />}
    </div>}</DialogTransition>
    <ErrorNotice error={error} />
  </KnowledgeDialog>;
}
