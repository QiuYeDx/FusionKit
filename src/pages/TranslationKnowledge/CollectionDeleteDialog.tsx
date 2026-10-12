import { useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Collection, Preset } from "@/translation-knowledge/schemas";
import { ErrorNotice, KnowledgeDialog } from "./Controls";
import type { LibraryError } from "./use-library";

/** Confirms deleting a collection with what it takes along; the deletion itself can still be undone afterwards. */
export function CollectionDeleteDialog(props: { collection: Collection | null; entryCount: number; presets: Preset[];
  onConfirm: () => Promise<LibraryError | null>; onClose: () => void }) {
  return <AnimatePresence>{props.collection && <DeleteForm key={props.collection.id} {...props} collection={props.collection} />}</AnimatePresence>;
}

function DeleteForm({ collection, entryCount, presets, onConfirm, onClose }: Parameters<typeof CollectionDeleteDialog>[0] & { collection: Collection }) {
  const { t } = useTranslation("knowledge");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LibraryError | null>(null);
  const lock = useRef(false);
  const confirm = async () => {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    const failure = await onConfirm();
    lock.current = false; setPending(false);
    if (failure) setError(failure); else onClose();
  };
  return <KnowledgeDialog title={t("collection.delete_title", { name: collection.name })} pending={pending} onClose={onClose} footer={
    <Button data-testid="knowledge-collection-delete-confirm" size="sm" variant="destructive" disabled={pending} onClick={() => void confirm()}>{pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}{t("collection.delete")}</Button>
  }>
    <div data-testid="knowledge-collection-delete-impact" className="space-y-2 text-sm leading-6">
      <p>{t("collection.delete_entries", { count: entryCount })}</p>
      {presets.length > 0 && <p>{t("collection.delete_presets", { count: presets.length, names: presets.map(preset => preset.name).join("、") })}</p>}
      <p className="text-xs leading-5 text-muted-foreground">{t("collection.delete_undo")}</p>
    </div>
    <ErrorNotice error={error} />
  </KnowledgeDialog>;
}
