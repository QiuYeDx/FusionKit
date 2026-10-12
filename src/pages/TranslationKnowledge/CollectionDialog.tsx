import { useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import { DialogTransition } from "@/components/qiuye-ui/dialog-motion";
import { Button } from "@/components/ui/button";
import type { Collection, LanguagePair } from "@/translation-knowledge/schemas";
import { languagePairSchema } from "@/translation-knowledge/schemas";
import { knowledgeSelectionSchema } from "@/translation-knowledge/execution-contract";
import { ErrorNotice, KnowledgeDialog, LanguageField, TextField } from "./Controls";
import { newCollection } from "./model";
import type { LibraryError } from "./use-library";

const validPair = (pair: LanguagePair) => languagePairSchema.safeParse(pair).success && knowledgeSelectionSchema.shape.languagePair.safeParse(pair).success;

/** One form for creating and editing a collection: its name, its translation direction and an optional description. */
export function CollectionDialog(props: { open: boolean; initial: Collection | null; defaultPair: LanguagePair; entryCount: number;
  onSave: (collection: Collection) => Promise<LibraryError | null>; onClose: () => void }) {
  return <AnimatePresence>{props.open && <CollectionForm key={props.initial?.id ?? "new"} {...props} />}</AnimatePresence>;
}

function CollectionForm({ initial, defaultPair, entryCount, onSave, onClose }: Parameters<typeof CollectionDialog>[0]) {
  const { t } = useTranslation("knowledge");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [pair, setPair] = useState<LanguagePair>(initial?.languagePair ?? defaultPair);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LibraryError | null>(null);
  const lock = useRef(false);
  const directionChanged = !!initial && entryCount > 0 && (initial.languagePair.source !== pair.source || initial.languagePair.target !== pair.target);
  const valid = !!name.trim() && validPair(pair);
  const save = async () => {
    if (lock.current || !valid) return;
    lock.current = true; setPending(true); setError(null);
    const record = initial ? { ...initial, name: name.trim(), description: description.trim(), languagePair: pair } : newCollection(name, pair, description);
    const failure = await onSave(record);
    lock.current = false; setPending(false);
    if (failure) setError(failure); else onClose();
  };
  return <KnowledgeDialog title={t(initial ? "collection.edit_title" : "collection.new_title")} description={t("collection.dialog_help")} pending={pending} onClose={onClose} footer={
    <Button data-testid="knowledge-collection-save" size="sm" disabled={!valid || pending} onClick={() => void save()}>{pending && <LoaderCircle className="animate-spin" />}{t(initial ? "actions.save" : "collection.create")}</Button>
  }>
    <form data-testid="knowledge-collection-form" className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <TextField label={t("collection.name")} value={name} onChange={setName} required placeholder={t("collection.name_placeholder")} />
      <div>
        <div className="grid gap-4 sm:grid-cols-2">
          <LanguageField label={t("collection.source_language")} value={pair.source} onChange={source => setPair(current => ({ ...current, source }))} />
          <LanguageField label={t("collection.target_language")} value={pair.target} onChange={target => setPair(current => ({ ...current, target }))} />
        </div>
        <DialogTransition transitionKey={directionChanged ? "changed" : "same"} stageClassName="pt-2">
          {directionChanged && <p role="status" data-testid="knowledge-direction-warning" className="text-xs leading-5 text-amber-700 dark:text-amber-400">{t("collection.direction_changed", { count: entryCount })}</p>}
        </DialogTransition>
      </div>
      <TextField label={t("collection.description")} value={description} onChange={setDescription} multiline placeholder={t("collection.description_placeholder")} />
      <button type="submit" hidden />
    </form>
    <ErrorNotice error={error} />
  </KnowledgeDialog>;
}
