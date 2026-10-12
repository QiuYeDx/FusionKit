import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft, Ellipsis, LoaderCircle, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Collection, TermEntry } from "@/translation-knowledge/schemas";
import type { LibrarySnapshot } from "@/translation-knowledge/ipc-contract";
import { newTerm, termClash } from "./model";
import type { LibraryError } from "./use-library";

type Strength = TermEntry["payload"]["strength"];
const STRENGTHS: Strength[] = ["required", "preferred", "keep_source"];
/** Wide: select · source · target · requirement · enabled · more. Narrow: requirement and switch wrap under the wording. */
export const TERM_GRID = "grid grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_28px] gap-x-3 @2xl/terms:grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_112px_36px_28px]";

export function withPayload(entry: TermEntry, change: Partial<TermEntry["payload"]>): TermEntry {
  const payload = { ...entry.payload, ...change };
  if (payload.strength === "keep_source") payload.target = payload.source;
  return { ...entry, payload };
}

function StrengthSelect({ value, onChange, disabled, label, testId }: { value: Strength; onChange: (value: Strength) => void; disabled?: boolean; label: string; testId?: string }) {
  const { t } = useTranslation("knowledge");
  return <Select value={value} onValueChange={next => onChange(next as Strength)} disabled={disabled}>
    <SelectTrigger size="sm" aria-label={label} data-testid={testId} className="h-7 data-[size=sm]:h-7 w-full min-w-0 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-muted/70 data-[state=open]:bg-muted dark:bg-transparent dark:hover:bg-muted/70"><SelectValue /></SelectTrigger>
    <SelectContent>{STRENGTHS.map(item => <SelectItem key={item} value={item} className="text-xs">{t(`strength.${item}`)}</SelectItem>)}</SelectContent>
  </Select>;
}

/** Text that turns into an input on click or Enter; Enter or leaving saves, Esc cancels. */
function EditableCell({ value, label, disabled, muted, onSave, column, children }: {
  value: string; label: string; disabled?: boolean; muted?: boolean; column: string;
  onSave: (value: string) => Promise<LibraryError | null>; children?: ReactNode;
}) {
  const { t } = useTranslation("knowledge");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<LibraryError | "required" | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const begin = () => { if (disabled) return; setDraft(value); setError(null); done.current = false; setEditing(true); };
  const finish = async (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
    const next = draft.trim();
    if (!commit || next === value) return;
    if (!next) { setError("required"); return; }
    setShown(next);
    const failure = await onSave(next);
    setShown(null);
    setError(failure);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void finish(true); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void finish(false); }
  };
  // Up and down move between rows in the same column, like a sheet.
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const cells = [...document.querySelectorAll<HTMLButtonElement>(`[data-term-cell="${column}"]`)];
    const next = cells[cells.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
  };
  return <div className="min-w-0">
    {editing ? <Input autoFocus aria-label={label} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={keyDown} onBlur={() => void finish(true)}
      className="-my-0.5 h-7 px-2 text-[13px]" />
      : <button ref={button} type="button" data-term-cell={column} aria-label={`${label}: ${shown ?? value}`} disabled={disabled} onClick={begin} onKeyDown={moveFocus}
        className={cn("-mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] leading-5 outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent",
          muted && "text-muted-foreground", error && error !== "required" && "ring-1 ring-destructive/60")}>
        <span className="min-w-0 [overflow-wrap:anywhere]">{shown ?? value}</span>
        {shown !== null && <LoaderCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />}
        {children}
      </button>}
    {error && <p role="alert" className="pt-0.5 text-[11px] leading-4 text-destructive">{t(error === "required" ? "terms.required" : error === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${error}`)}</p>}
  </div>;
}

export function TermRow({ entry, selected, highlighted, disabled, onSelect, onSave, onMore }: {
  entry: TermEntry; selected: boolean; highlighted: boolean; disabled: boolean;
  onSelect: (event: MouseEvent, checked: boolean) => void;
  onSave: (record: TermEntry) => Promise<LibraryError | null>;
  onMore: (trigger: HTMLElement) => void;
}) {
  const { t } = useTranslation("knowledge");
  const [toggleError, setToggleError] = useState<LibraryError | null>(null);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => { if (highlighted) row.current?.scrollIntoView({ block: "center", behavior: "smooth" }); }, [highlighted]);
  const keep = entry.payload.strength === "keep_source";
  const immediate = async (record: TermEntry) => setToggleError(await onSave(record));
  return <div ref={row} role="row" data-entry-id={entry.id} data-enabled={entry.enabled} data-highlighted={highlighted || undefined} aria-selected={selected}
    className={cn(TERM_GRID, "items-start gap-y-1.5 rounded-lg px-2 py-1.5 transition-colors duration-150 motion-reduce:transition-none",
      selected ? "bg-muted/70" : "hover:bg-muted/40", highlighted && "bg-amber-500/10 ring-1 ring-amber-500/40")}>
    <div role="cell" className="flex h-7 items-center">
      <Checkbox aria-label={t("terms.select", { source: entry.payload.source })} checked={selected} disabled={disabled}
        onClick={event => { event.preventDefault(); onSelect(event, !selected); }} />
    </div>
    <div role="cell" className={cn("min-w-0", !entry.enabled && "opacity-55")}>
      <EditableCell column="source" label={t("terms.source")} value={entry.payload.source} disabled={disabled} onSave={source => onSave(withPayload(entry, { source }))}>
        {!entry.enabled && <Badge variant="outline" className="mt-0.5 h-4 shrink-0 px-1 text-[10px] font-normal">{t("terms.disabled")}</Badge>}
      </EditableCell>
    </div>
    <div role="cell" className={cn("min-w-0", !entry.enabled && "opacity-55")}>
      {keep ? <p className="px-0 py-1 text-[13px] leading-5 text-muted-foreground">{t("terms.keeps_source")}</p>
        : <EditableCell column="target" label={t("terms.target")} value={entry.payload.target} disabled={disabled} onSave={target => onSave(withPayload(entry, { target }))} />}
      {(entry.payload.aliases.length > 0 || entry.payload.note) && <p className="truncate pt-0.5 text-[11px] leading-4 text-muted-foreground" title={[entry.payload.aliases.join("、"), entry.payload.note].filter(Boolean).join(" · ")}>
        {[entry.payload.aliases.length ? t("terms.aliases_count", { count: entry.payload.aliases.length }) : "", entry.payload.note].filter(Boolean).join(" · ")}
      </p>}
    </div>
    <div role="cell" className="col-span-2 col-start-2 flex min-w-0 items-center gap-3 @2xl/terms:col-span-1 @2xl/terms:col-start-auto @2xl/terms:contents">
      <div className="w-28 @2xl/terms:w-auto"><StrengthSelect label={t("terms.strength")} value={entry.payload.strength} disabled={disabled} testId="knowledge-term-strength"
        onChange={strength => void immediate(withPayload(entry, { strength }))} /></div>
      <div className="flex h-7 items-center @2xl/terms:justify-center">
        <Switch aria-label={t("terms.enabled", { source: entry.payload.source })} data-testid="knowledge-term-enabled" checked={entry.enabled} disabled={disabled}
          onCheckedChange={enabled => void immediate({ ...entry, enabled })} />
      </div>
      {toggleError && <p role="alert" className="text-[11px] text-destructive @2xl/terms:hidden">{t(`errors.${toggleError}`)}</p>}
    </div>
    <div role="cell" className="col-start-4 row-start-1 flex h-7 items-center justify-end @2xl/terms:col-start-auto @2xl/terms:row-start-auto">
      <Button data-testid="knowledge-term-more" variant="ghost" size="icon-xs" className="size-7" aria-label={t("terms.more", { source: entry.payload.source })} disabled={disabled}
        onClick={event => onMore(event.currentTarget)}><Ellipsis /></Button>
    </div>
    {toggleError && <p role="alert" className="col-span-full hidden pl-8 text-[11px] text-destructive @2xl/terms:block">{t(toggleError === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${toggleError}`)}</p>}
  </div>;
}

/** The always-present last row: type a source and a target, Enter adds it and starts the next one. */
export function AddTermRow({ collection, snapshot, disabled, onSave }: {
  collection: Collection; snapshot: LibrarySnapshot; disabled: boolean; onSave: (record: TermEntry) => Promise<LibraryError | null>;
}) {
  const { t } = useTranslation("knowledge");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [strength, setStrength] = useState<Strength>("preferred");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<LibraryError | null>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  const keep = strength === "keep_source";
  const clash = source.trim() && (keep || target.trim()) ? termClash(snapshot, collection.id, source, keep ? source : target) : null;
  const ready = !!source.trim() && (keep || !!target.trim()) && clash !== "same" && !pending && !disabled;
  const add = async () => {
    if (!ready) return;
    setPending(true); setError(null);
    const failure = await onSave(newTerm(collection.id, source, target, strength));
    setPending(false);
    if (failure) { setError(failure); return; }
    setSource(""); setTarget("");
    sourceInput.current?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void add(); }
  };
  return <div id="knowledge-tour-add-term" data-testid="knowledge-add-term" className="border-t px-4 py-2">
    <div className={cn(TERM_GRID, "items-center gap-y-1.5")}>
      <Plus aria-hidden className="size-3.5 justify-self-center text-muted-foreground" />
      <Input ref={sourceInput} data-testid="knowledge-add-source" aria-label={t("terms.new_source")} placeholder={t("terms.new_source")} value={source} disabled={disabled}
        onChange={event => setSource(event.target.value)} onKeyDown={keyDown} className="h-7 px-2 text-[13px]" />
      <Input data-testid="knowledge-add-target" aria-label={t("terms.new_target")} placeholder={keep ? t("terms.keeps_source") : t("terms.new_target")} value={keep ? "" : target} disabled={disabled || keep}
        onChange={event => setTarget(event.target.value)} onKeyDown={keyDown} className="h-7 px-2 text-[13px]" />
      <div className="col-span-2 col-start-2 flex items-center gap-2 @2xl/terms:contents">
        <div className="w-28 @2xl/terms:w-auto"><StrengthSelect label={t("terms.strength")} value={strength} onChange={setStrength} disabled={disabled} /></div>
        <Button data-testid="knowledge-add-term-submit" size="icon-xs" variant="ghost" className="size-7 @2xl/terms:col-span-2 @2xl/terms:w-full" aria-label={t("terms.add")} title={t("terms.add_hint")} disabled={!ready} onClick={() => void add()}>
          {pending ? <LoaderCircle className="animate-spin" /> : <CornerDownLeft />}
        </Button>
      </div>
    </div>
    {(clash || error) && <p role={error || clash === "same" ? "alert" : "status"} className={cn("pt-1.5 pl-8 text-[11px] leading-4", error || clash === "same" ? "text-destructive" : "text-amber-700 dark:text-amber-400")}>
      {error ? t(error === "revision_conflict" ? "errors.changed_elsewhere" : `errors.${error}`) : t(clash === "same" ? "terms.duplicate" : "terms.conflict")}
    </p>}
  </div>;
}

export function TermHeader({ pageState, onSelectPage, disabled }: { pageState: boolean | "indeterminate"; onSelectPage: (checked: boolean) => void; disabled: boolean }) {
  const { t } = useTranslation("knowledge");
  return <div role="row" className={cn(TERM_GRID, "items-center border-b px-4 py-2 text-[11px] font-medium text-muted-foreground")}>
    <div role="columnheader" className="flex items-center"><Checkbox data-testid="knowledge-select-page" aria-label={t("selection.page")} checked={pageState} disabled={disabled} onCheckedChange={checked => onSelectPage(checked === true)} /></div>
    <div role="columnheader">{t("terms.source")}</div>
    <div role="columnheader">{t("terms.target")}</div>
    <div role="columnheader" className="hidden @2xl/terms:block">{t("terms.strength")}</div>
    <div role="columnheader" className="hidden text-center @2xl/terms:block">{t("terms.enabled_column")}</div>
    <div role="columnheader"><span className="sr-only">{t("terms.more_column")}</span></div>
  </div>;
}
