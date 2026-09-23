import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Collection, Entry } from "@/translation-knowledge/schemas";
import type { KnowledgeErrorCode, KnowledgeResult, LibrarySnapshot, SaveRecordRequest } from "@/translation-knowledge/ipc-contract";
import { ErrorNotice } from "./Controls";
import { manualEntryRequest, newEntry } from "./model";

export function InlineTermEditor({ collection, snapshot, disabled, onSave, onAdvanced }: {
  collection: Collection;
  snapshot: LibrarySnapshot;
  disabled: boolean;
  onSave: (request: SaveRecordRequest) => Promise<KnowledgeResult<LibrarySnapshot>>;
  onAdvanced: (entry: Entry) => void;
}) {
  const { t } = useTranslation("knowledge");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | "unexpected" | null>(null);
  const lock = useRef(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const draft = () => {
    const entry = newEntry(collection);
    if (entry.kind === "term") entry.payload = { ...entry.payload, source: source.trim(), target: target.trim() };
    return entry;
  };
  const save = async (apply: boolean) => {
    if (lock.current || disabled || !source.trim() || !target.trim()) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await onSave(manualEntryRequest(draft(), snapshot, apply, t("source.manual")));
      if (!result.ok) setError(result.error);
      else { setSource(""); setTarget(""); requestAnimationFrame(() => sourceInput.current?.focus()); }
    } catch { setError("unexpected"); }
    finally { lock.current = false; setPending(false); }
  };
  return <form data-testid="knowledge-inline-term" className="border-t p-3" onSubmit={event => { event.preventDefault(); void save(true); }}>
    <fieldset disabled={disabled || pending} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input ref={sourceInput} aria-label={t("fields.source_text")} placeholder={t("fields.source_text")} value={source} onChange={event => setSource(event.target.value)} className="h-8 text-sm" />
        <Input aria-label={t("fields.target_text")} placeholder={t("fields.target_text")} value={target} onChange={event => setTarget(event.target.value)} className="h-8 text-sm" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!source.trim() || !target.trim()}><Plus />{t(pending ? "actions.saving" : "workspace.save_apply")}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!source.trim() || !target.trim()} onClick={() => void save(false)}>{t("workspace.save_draft")}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onAdvanced(draft())}>{t("workspace.more_options")}</Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("workspace.apply_help")}</p>
    </fieldset>
    <ErrorNotice error={error} stageClassName="pt-3" />
  </form>;
}
