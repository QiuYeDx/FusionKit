import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ExportPreview } from "@/translation-knowledge/export-contract";
import type { CommitImportRequest, ExportReceipt, ImportCollectionAction, ImportPreview, ImportReceipt, KnowledgeErrorCode, LibrarySnapshot, TranslationKnowledgeApi } from "@/translation-knowledge/ipc-contract";
import type { Diagnostic } from "@/translation-knowledge/validation";
import { Check, Choice, ErrorNotice, KnowledgeDialog } from "./Controls";
import { KnowledgeScrollList } from "./KnowledgeScrollList";
import { diagnosticText, languagePairLabel } from "./labels";
import { orderedCollections } from "./model";

type Failure = KnowledgeErrorCode | "unexpected";

function Warnings({ warnings, testId }: { warnings: Diagnostic[]; testId: string }) {
  const { t } = useTranslation("knowledge");
  if (!warnings.length) return null;
  return <div data-testid={testId} role="status" className="space-y-1.5 rounded-smooth-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5">
    <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300"><AlertTriangle className="size-3.5" />{t("exchange.warnings", { count: warnings.length })}</p>
    <ul className="space-y-1">{warnings.slice(0, 20).map((warning, index) => <li key={index} className="[overflow-wrap:anywhere]">
      {diagnosticText(t, warning)}{warning.path && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{warning.path}</span>}
    </li>)}</ul>
  </div>;
}

const actionsFor = (status: ImportPreview["collections"][number]["status"]): ImportCollectionAction[] => status === "new" ? ["add", "copy", "skip"] : ["merge", "copy", "skip"];

/** What a package would add, per collection, with a choice for each; nothing is written before Import. */
export function ImportDialog({ preview, api, onClose, onImported }: {
  preview: ImportPreview; api: TranslationKnowledgeApi; onClose: () => void; onImported: (receipt: ImportReceipt) => void;
}) {
  const { t } = useTranslation("knowledge");
  const [actions, setActions] = useState<Record<string, ImportCollectionAction>>(() => Object.fromEntries(preview.collections.map(item => [item.id, actionsFor(item.status)[0]])));
  const [conflict, setConflict] = useState<CommitImportRequest["conflict"]>("keep_local");
  const [presets, setPresets] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const lock = useRef(false);
  const existing = preview.collections.some(item => item.status === "existing");
  const chosen = preview.collections.filter(item => actions[item.id] !== "skip");
  const commit = async () => {
    if (lock.current || !chosen.length) return;
    lock.current = true; setPending(true); setError(null);
    try {
      const result = await api.commitImport({ planId: preview.planId, collections: preview.collections.map(item => ({ id: item.id, action: actions[item.id] })), conflict, presets: presets ? "add" : "skip" });
      if (result.ok) onImported(result.value); else setError(result.error);
    } catch { setError("unexpected"); }
    finally { lock.current = false; setPending(false); }
  };
  return <KnowledgeDialog wide title={t("import.title")} description={t("import.description", { name: preview.packageName })} pending={pending} onClose={onClose} footer={
    <Button data-testid="knowledge-import-commit" size="sm" disabled={pending || !chosen.length} onClick={() => void commit()}>{pending && <LoaderCircle className="animate-spin" />}{t("import.commit", { count: chosen.length })}</Button>
  }>
    <Warnings warnings={preview.warnings} testId="knowledge-import-warnings" />
    <ul data-testid="knowledge-import-collections" className="divide-y rounded-smooth-md border">
      {preview.collections.map(item => <li key={item.id} data-import-collection={item.id} data-status={item.status} className="grid gap-x-3 gap-y-1.5 p-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center">
        <div className="min-w-0 space-y-0.5">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium">
            <span className="[overflow-wrap:anywhere]">{item.name}</span>
            <Badge variant={item.status === "new" ? "secondary" : "outline"} className="h-4 px-1 text-[10px] font-normal">{t(`import.status_${item.status}`)}</Badge>
          </p>
          <p className="text-xs leading-5 text-muted-foreground">{languagePairLabel(t, item.languagePair)} · {item.status === "new"
            ? t("import.entries", { count: item.entries })
            : t("import.compare", { added: item.added, changed: item.changed, unchanged: item.unchanged })}</p>
        </div>
        <Select value={actions[item.id]} onValueChange={value => setActions(current => ({ ...current, [item.id]: value as ImportCollectionAction }))}>
          <SelectTrigger size="sm" aria-label={t("import.action_for", { name: item.name })} className="w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{actionsFor(item.status).map(action => <SelectItem key={action} value={action} className="text-xs">{t(`import.action_${action}`)}</SelectItem>)}</SelectContent>
        </Select>
      </li>)}
    </ul>
    {existing && <div>
      <Choice label={t("import.conflict")} value={conflict} onChange={value => setConflict(value as typeof conflict)}
        options={[{ value: "keep_local", label: t("import.keep_local") }, { value: "use_incoming", label: t("import.use_incoming") }]} />
      <p className="pt-1.5 text-[11px] leading-4 text-muted-foreground">{t("import.conflict_help")}</p>
    </div>}
    {preview.presets.length > 0 && <Check label={t("import.presets", { count: preview.presets.length })} checked={presets} onChange={setPresets} />}
    <ErrorNotice error={error} />
  </KnowledgeDialog>;
}

/** Chooses what goes into a package file, shows anything that should not be shared, then saves it. */
export function ExportDialog({ snapshot, api, initialCollectionIds, onClose, onExported }: {
  snapshot: LibrarySnapshot; api: TranslationKnowledgeApi; initialCollectionIds: string[]; onClose: () => void; onExported: (receipt: ExportReceipt) => void;
}) {
  const { t } = useTranslation("knowledge");
  const collections = orderedCollections(snapshot);
  const [selected, setSelected] = useState<string[]>(initialCollectionIds.filter(id => collections.some(item => item.id === id)));
  const [includeDisabled, setIncludeDisabled] = useState(true);
  const [includePresets, setIncludePresets] = useState(true);
  const [plan, setPlan] = useState<ExportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const lock = useRef(false);
  const changed = () => { setPlan(null); setError(null); };
  const save = async (preview: ExportPreview) => {
    const result = await api.exportFile({ planId: preview.planId });
    if (!result.ok) { setError(result.error); return; }
    if (result.value) onExported(result.value);
  };
  const run = async () => {
    if (lock.current || !selected.length) return;
    lock.current = true; setPending(true); setError(null);
    try {
      // A shown warning was the user's to see; the second press saves with the same plan.
      if (plan) { await save(plan); return; }
      const result = await api.planExport({ generation: snapshot.generation, collectionIds: selected, includeDisabled, includePresets });
      if (!result.ok) { setError(result.error); return; }
      if (result.value.warnings.length) { setPlan(result.value); return; }
      await save(result.value);
    } catch { setError("unexpected"); }
    finally { lock.current = false; setPending(false); }
  };
  const toggle = (id: string, checked: boolean) => { setSelected(current => checked ? [...current, id] : current.filter(item => item !== id)); changed(); };
  return <KnowledgeDialog title={t("export.title")} description={t("export.description")} pending={pending} onClose={onClose} footer={
    <Button data-testid="knowledge-export-save" size="sm" disabled={pending || !selected.length} onClick={() => void run()}>{pending && <LoaderCircle className="animate-spin" />}{t(plan ? "export.save_anyway" : "export.save")}</Button>
  }>
    <fieldset className="space-y-2">
      <legend className="flex w-full items-center justify-between gap-2 pb-1.5 text-[11px] font-medium text-muted-foreground">
        <span>{t("export.collections", { count: selected.length })}</span>
        <button type="button" className="rounded text-[11px] text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => { setSelected(selected.length === collections.length ? [] : collections.map(item => item.id)); changed(); }}>{t(selected.length === collections.length ? "export.select_none" : "export.select_all")}</button>
      </legend>
      <div className="rounded-smooth-md border"><KnowledgeScrollList testId="knowledge-export-collections" maxHeight="min(16rem, 40vh)" contentClassName="space-y-2 p-3">
        {collections.map(item => <Check key={item.id} label={`${item.name} · ${languagePairLabel(t, item.languagePair)}${item.archived ? ` · ${t("collection.archived")}` : ""}`}
          checked={selected.includes(item.id)} onChange={checked => toggle(item.id, checked)} />)}
      </KnowledgeScrollList></div>
    </fieldset>
    <div className="space-y-2">
      <Check label={t("export.include_disabled")} checked={includeDisabled} onChange={value => { setIncludeDisabled(value); changed(); }} />
      <Check label={t("export.include_presets")} checked={includePresets} onChange={value => { setIncludePresets(value); changed(); }} />
    </div>
    <DialogTransition transitionKey={plan ? `plan-${plan.planId}` : "none"}>{plan && <div className="space-y-2">
      <Warnings warnings={plan.warnings} testId="knowledge-export-warnings" />
      <p className="text-xs leading-5 text-muted-foreground">{t("export.warnings_help")}</p>
    </div>}</DialogTransition>
    <ErrorNotice error={error} />
  </KnowledgeDialog>;
}
