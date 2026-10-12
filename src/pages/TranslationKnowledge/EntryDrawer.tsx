import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Origin, TermEntry } from "@/translation-knowledge/schemas";
import { Choice, ErrorNotice, LinesField, TextField } from "./Controls";
import { splitLines } from "./model";
import { withPayload } from "./TermTable";
import type { LibraryError } from "./use-library";

function OriginText({ origin }: { origin?: Origin }) {
  const { t } = useTranslation("knowledge");
  if (!origin) return <p className="text-xs text-muted-foreground">{t("drawer.origin_unknown")}</p>;
  return <div data-testid="knowledge-drawer-origin" className="space-y-1 text-xs leading-5">
    <p>{t(`origin.${origin.kind}`)}{origin.at ? ` · ${new Date(origin.at).toLocaleString()}` : ""}</p>
    {origin.title && <p className="[overflow-wrap:anywhere]">{origin.title}</p>}
    {origin.url && <p className="break-all text-muted-foreground">{origin.url}</p>}
    {origin.note && <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{origin.note}</p>}
  </div>;
}

/**
 * The full term beside the table: aliases, note and matching, plus where it came from.
 * Closing returns focus to the button that opened it.
 */
export function EntryDrawer({ entry, trigger, onSave, onDelete, onClose }: {
  entry: TermEntry | null; trigger: HTMLElement | null;
  onSave: (record: TermEntry) => Promise<LibraryError | null>; onDelete: (record: TermEntry) => void; onClose: () => void;
}) {
  const { t } = useTranslation("knowledge");
  const [draft, setDraft] = useState<TermEntry | null>(entry);
  const [aliases, setAliases] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LibraryError | null>(null);
  const lock = useRef(false);
  // The page clears the trigger as it closes the drawer; focus returns after the exit animation, so keep it here.
  const returnFocus = useRef<HTMLElement | null>(null);
  if (entry && trigger) returnFocus.current = trigger;
  useEffect(() => {
    if (!entry) return;
    setDraft(entry); setAliases(entry.payload.aliases.join("\n")); setError(null);
  }, [entry?.id]);
  // An edit elsewhere (another field saved inline, or the assistant) moves the base revision along.
  useEffect(() => { if (entry && draft && entry.revision !== draft.revision) setDraft(current => current && { ...current, revision: entry.revision }); }, [entry?.revision]);
  const change = (payload: Partial<TermEntry["payload"]>) => setDraft(current => current && withPayload(current, payload));
  const valid = !!draft && !!draft.payload.source.trim() && !!draft.payload.target.trim();
  const save = async () => {
    if (!draft || !valid || lock.current) return;
    lock.current = true; setPending(true); setError(null);
    const record = withPayload(draft, { source: draft.payload.source.trim(), target: draft.payload.target.trim(), note: draft.payload.note.trim(),
      aliases: splitLines(aliases).filter(alias => alias !== draft.payload.source.trim()) });
    const failure = await onSave(record);
    lock.current = false; setPending(false);
    if (failure) setError(failure); else onClose();
  };
  const keep = draft?.payload.strength === "keep_source";
  return <DialogPrimitive.Root open={!!entry} onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <DialogPrimitive.Content data-testid="knowledge-entry-drawer" aria-describedby={undefined}
        onCloseAutoFocus={event => { const target = returnFocus.current; if (target?.isConnected) { event.preventDefault(); target.focus(); } }}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-background shadow-xl outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right motion-reduce:animate-none sm:w-[400px]">
        <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b px-3">
          <DialogPrimitive.Title className="min-w-0 truncate text-base font-semibold">{t("drawer.title")}</DialogPrimitive.Title>
          <DialogPrimitive.Close asChild><Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("actions.close")} disabled={pending}><X /></Button></DialogPrimitive.Close>
        </div>
        {draft && <ScrollArea className="min-h-0 flex-1" viewportProps={{ className: "[&>div]:!block" }}>
          <form className="space-y-4 p-3" onSubmit={event => { event.preventDefault(); void save(); }}>
            <TextField label={t("terms.source")} value={draft.payload.source} onChange={source => change({ source })} required />
            <TextField label={t("terms.target")} value={keep ? t("terms.keeps_source") : draft.payload.target} onChange={target => change({ target })} required disabled={keep} />
            <Choice label={t("terms.strength")} value={draft.payload.strength} onChange={strength => change({ strength: strength as TermEntry["payload"]["strength"] })}
              options={(["required", "preferred", "keep_source"] as const).map(value => ({ value, label: t(`strength.${value}`) }))} />
            <p className="-mt-2 text-[11px] leading-4 text-muted-foreground">{t(`strength.${draft.payload.strength}_help`)}</p>
            <LinesField label={t("drawer.aliases")} value={aliases} onChange={setAliases} />
            <p className="-mt-2 text-[11px] leading-4 text-muted-foreground">{t("drawer.aliases_help")}</p>
            <TextField label={t("drawer.note")} value={draft.payload.note} onChange={note => change({ note })} multiline placeholder={t("drawer.note_placeholder")} />
            <Choice label={t("drawer.match")} value={draft.payload.match.mode} onChange={mode => change({ match: { ...draft.payload.match, mode: mode as TermEntry["payload"]["match"]["mode"] } })}
              options={(["literal_phrase", "whole_term"] as const).map(value => ({ value, label: t(`match.${value}`) }))} />
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t("drawer.case_sensitive")}</span>
              <Switch aria-label={t("drawer.case_sensitive")} checked={draft.payload.match.caseSensitive} onCheckedChange={caseSensitive => change({ match: { ...draft.payload.match, caseSensitive } })} />
            </label>
            <div className="space-y-1.5 border-t pt-3">
              <p className="text-[11px] font-medium text-muted-foreground">{t("drawer.origin")}</p>
              <OriginText origin={draft.origin} />
            </div>
            <ErrorNotice error={error} />
            <button type="submit" hidden />
          </form>
        </ScrollArea>}
        <div className="flex shrink-0 items-center gap-2 border-t p-3">
          <Button data-testid="knowledge-drawer-delete" variant="ghost" size="sm" className="mr-auto text-destructive hover:text-destructive" disabled={pending || !draft} onClick={() => draft && onDelete(draft)}><Trash2 />{t("actions.delete")}</Button>
          <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>{t("actions.cancel")}</Button>
          <Button data-testid="knowledge-drawer-save" size="sm" disabled={!valid || pending} onClick={() => void save()}>{pending && <LoaderCircle className="animate-spin" />}{t("actions.save")}</Button>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
