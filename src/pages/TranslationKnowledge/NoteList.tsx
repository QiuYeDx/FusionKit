import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Ellipsis, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { NoteEntry } from "@/translation-knowledge/schemas";
import { Check } from "./Controls";
import { newNote, type NoteKind } from "./model";
import type { LibraryError } from "./use-library";

const submitKey = (event: KeyboardEvent<HTMLTextAreaElement>) => event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing;

function NoteEditor({ initialText, initialRequired, kind, submitLabel, onSubmit, onCancel, testId }: {
  initialText: string; initialRequired: boolean; kind: NoteKind; submitLabel: string; testId: string;
  onSubmit: (text: string, required: boolean) => Promise<LibraryError | null>; onCancel?: () => void;
}) {
  const { t } = useTranslation("knowledge");
  const [text, setText] = useState(initialText);
  const [required, setRequired] = useState(initialRequired);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LibraryError | "empty" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const submit = async () => {
    if (pending) return;
    if (!text.trim()) { setError("empty"); area.current?.focus(); return; }
    setPending(true); setError(null);
    const failure = await onSubmit(text, required);
    setPending(false);
    if (failure) { setError(failure); return; }
    if (!onCancel) { setText(""); setRequired(false); area.current?.focus(); }
  };
  return <div data-testid={testId} className="space-y-2">
    <Textarea ref={area} autoFocus={!!onCancel} rows={2} aria-label={t(kind === "rule" ? "notes.new_rule" : "notes.new_context")} placeholder={t(kind === "rule" ? "notes.rule_placeholder" : "notes.context_placeholder")}
      value={text} onChange={event => { setText(event.target.value); if (error === "empty") setError(null); }}
      onKeyDown={event => { if (submitKey(event)) { event.preventDefault(); void submit(); } else if (event.key === "Escape" && onCancel) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}
      className="field-sizing-content min-h-[3.25rem] resize-none text-[13px] leading-5" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Check label={t("notes.required")} checked={required} onChange={setRequired} />
      <div className="flex items-center gap-2">
        <span className="hidden text-[11px] text-muted-foreground sm:inline">{t("notes.submit_hint")}</span>
        {onCancel && <Button size="sm" variant="ghost" className="h-7" disabled={pending} onClick={onCancel}>{t("actions.cancel")}</Button>}
        <Button data-testid={`${testId}-submit`} size="sm" variant={onCancel ? "default" : "outline"} className="h-7" disabled={pending} onClick={() => void submit()}>
          {pending ? <LoaderCircle className="animate-spin" /> : !onCancel && <Plus />}{submitLabel}
        </Button>
      </div>
    </div>
    {error && <p role="alert" className="text-[11px] text-destructive">{t(error === "empty" ? "notes.empty_text" : error === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${error}`)}</p>}
  </div>;
}

function NoteRow({ entry, selected, highlighted, disabled, onSelect, onSave, onDelete }: {
  entry: NoteEntry; selected: boolean; highlighted: boolean; disabled: boolean;
  onSelect: (event: MouseEvent, checked: boolean) => void; onSave: (record: NoteEntry) => Promise<LibraryError | null>; onDelete: () => void;
}) {
  const { t } = useTranslation("knowledge");
  const [editing, setEditing] = useState(false);
  const [toggleError, setToggleError] = useState<LibraryError | null>(null);
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => { if (highlighted) row.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [highlighted]);
  return <li ref={row} data-entry-id={entry.id} data-enabled={entry.enabled} data-highlighted={highlighted || undefined} aria-selected={selected}
    className={cn("grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-lg px-2 py-2 transition-colors duration-150 motion-reduce:transition-none",
      selected ? "bg-muted/70" : "hover:bg-muted/40", highlighted && "bg-amber-500/10 ring-1 ring-amber-500/40")}>
    <div className="flex h-5 items-center"><Checkbox aria-label={t("notes.select")} checked={selected} disabled={disabled} onClick={event => { event.preventDefault(); onSelect(event, !selected); }} /></div>
    {editing ? <NoteEditor testId="knowledge-note-edit" kind={entry.kind} initialText={entry.payload.text} initialRequired={entry.payload.required} submitLabel={t("actions.save")}
      onCancel={() => setEditing(false)} onSubmit={async (text, required) => {
        const failure = await onSave({ ...entry, payload: { text: text.trim(), required } });
        if (!failure) setEditing(false);
        return failure;
      }} />
      : <div className={cn("min-w-0 space-y-1", !entry.enabled && "opacity-55")}>
        <p className="whitespace-pre-wrap text-[13px] leading-5 [overflow-wrap:anywhere]">{entry.payload.text}</p>
        {(entry.payload.required || !entry.enabled) && <div className="flex flex-wrap gap-1.5">
          {entry.payload.required && <Badge variant="outline" data-testid="knowledge-note-required" className="h-4 px-1 text-[10px] font-normal">{t("notes.required_badge")}</Badge>}
          {!entry.enabled && <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">{t("terms.disabled")}</Badge>}
        </div>}
        {toggleError && <p role="alert" className="text-[11px] text-destructive">{t(toggleError === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${toggleError}`)}</p>}
      </div>}
    {!editing && <div className="flex items-center gap-1">
      <Switch aria-label={t("notes.enabled")} data-testid="knowledge-note-enabled" checked={entry.enabled} disabled={disabled}
        onCheckedChange={async enabled => setToggleError(await onSave({ ...entry, enabled }))} className="mr-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button data-testid="knowledge-note-more" variant="ghost" size="icon-xs" className="size-7" aria-label={t("notes.more")} disabled={disabled}><Ellipsis /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="knowledge-note-edit-action" onSelect={() => setEditing(true)}><Pencil />{t("actions.edit")}</DropdownMenuItem>
          <DropdownMenuItem data-testid="knowledge-note-delete" variant="destructive" onSelect={onDelete}><Trash2 />{t("actions.delete")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>}
  </li>;
}

/** Requirements and background of one collection, each with its own always-open add box. */
export function NoteSection({ kind, collectionId, notes, selected, highlightId, disabled, readOnly, onSelect, onSave, onDelete }: {
  kind: NoteKind; collectionId: string; notes: NoteEntry[]; selected: ReadonlySet<string>; highlightId?: string; disabled: boolean; readOnly: boolean;
  onSelect: (id: string, event: MouseEvent, checked: boolean) => void; onSave: (record: NoteEntry) => Promise<LibraryError | null>; onDelete: (entry: NoteEntry) => void;
}) {
  const { t } = useTranslation("knowledge");
  return <section data-testid={`knowledge-notes-${kind}`} aria-labelledby={`knowledge-notes-${kind}-title`} className="min-w-0">
    <div className="flex items-baseline justify-between gap-3 px-4 pb-1 pt-3">
      <h3 id={`knowledge-notes-${kind}-title`} className="text-[13px] font-medium">{t(kind === "rule" ? "notes.rules" : "notes.context")}
        <span className="ml-1.5 text-[11px] font-normal tabular-nums text-muted-foreground">{notes.length}</span></h3>
      <p className="hidden truncate text-[11px] text-muted-foreground sm:block">{t(kind === "rule" ? "notes.rules_help" : "notes.context_help")}</p>
    </div>
    {notes.length ? <ul className="space-y-1 px-2">{notes.map(entry => <NoteRow key={entry.id} entry={entry} selected={selected.has(entry.id)} highlighted={entry.id === highlightId} disabled={disabled}
      onSelect={(event, checked) => onSelect(entry.id, event, checked)} onSave={onSave} onDelete={() => onDelete(entry)} />)}</ul>
      : <p className="px-4 py-2 text-xs leading-5 text-muted-foreground">{t(kind === "rule" ? "notes.rules_empty" : "notes.context_empty")}</p>}
    {!readOnly && <div className="px-4 pb-3 pt-2">
      <NoteEditor testId={`knowledge-add-${kind}`} kind={kind} initialText="" initialRequired={false} submitLabel={t("notes.add")}
        onSubmit={(text, required) => onSave(newNote(collectionId, kind, text, required))} />
    </div>}
  </section>;
}
