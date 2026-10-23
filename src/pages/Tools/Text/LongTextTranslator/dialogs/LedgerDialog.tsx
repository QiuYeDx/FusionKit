import { memo, useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, BookA, BookmarkPlus, LoaderCircle, Plus, Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LONG_TEXT_LIMITS, type LanguageTag, type LedgerEntry, type LongTextRequest } from '@/long-text/contract';
import { unwrap } from '@/services/long-text/client';
import { KnowledgeCaptureDialog } from '@/pages/TranslationKnowledge/KnowledgeCaptureDialog';
import { StudioIconButton } from '../../../Subtitle/SubtitleStudio/StudioControls';
import { LEDGER_ORIGIN_LABELS } from '../labels';
import { groupedCount, useLongTextPage } from '../page-context';
import { DialogFrame, DialogNote, useDialogRequest } from './DialogFrame';

type LedgerUpsert = LongTextRequest<'updateLedger'>['upserts'][number];
/** An unsaved row: an edited entry, or the row "添加" opens (which also chooses whether it is confirmed). */
interface RowDraft { source: string; target: string; confirmed: boolean }
interface CaptureRequest { wordings: Array<{ source: string; target: string }>; languagePair: { source: LanguageTag; target: LanguageTag } }

/** Key of the row "添加" opens. */
const NEW_ROW = 'new';
/** Rows rendered at first and added by "再显示 200 条". */
const RENDER_STEP = 200;

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/** Entries newest first, those whose source or translation contains `query` (NFKC, ignoring case). */
export function visibleEntries(entries: readonly LedgerEntry[], query: string): LedgerEntry[] {
  const key = normalize(query.trim());
  const newestFirst = [...entries].reverse();
  return key ? newestFirst.filter(entry => normalize(entry.source).includes(key) || normalize(entry.target).includes(key)) : newestFirst;
}

/** A row's values as an upsert, or null while either side is empty or longer than `LONG_TEXT_LIMITS.termChars`. */
export function ledgerUpsert(draft: RowDraft, id?: string): LedgerUpsert | null {
  const source = draft.source.trim();
  const target = draft.target.trim();
  if (!source || !target || source.length > LONG_TEXT_LIMITS.termChars || target.length > LONG_TEXT_LIMITS.termChars) return null;
  return { ...(id ? { id } : {}), source, target, confirmed: draft.confirmed };
}

const draftOf = (entry: LedgerEntry): RowDraft => ({ source: entry.source, target: entry.target, confirmed: entry.confirmed });

interface RowActions {
  change(key: string, patch: Partial<RowDraft>): void;
  /** Saves the row's edit; `enter` when the user pressed Enter rather than leaving the row. */
  commit(key: string, enter: boolean): void;
  toggle(key: string): void;
  remove(key: string): void;
}

const LedgerRow = memo(function LedgerRow({ rowKey, values, origin, edited, busy, actions }: {
  rowKey: string; values: RowDraft; origin: LedgerEntry['origin']; edited: boolean; busy: boolean; actions: RowActions;
}) {
  const { t } = useTranslation('text');
  const isNew = rowKey === NEW_ROW;
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    actions.commit(rowKey, true);
  };
  const leave = (event: FocusEvent<HTMLLIElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) actions.commit(rowKey, false);
  };
  return <li className="lt-ledger-row" data-testid="long-text-ledger-row" data-new={isNew || undefined} data-edited={edited || undefined} onBlur={leave}>
    <Input aria-label={t('ledger.source')} placeholder={isNew ? t('ledger.source') : undefined} className="h-7 text-xs" value={values.source}
      maxLength={LONG_TEXT_LIMITS.termChars} autoFocus={isNew} onChange={event => actions.change(rowKey, { source: event.target.value })} onKeyDown={keyDown} />
    <Input aria-label={t('ledger.target')} placeholder={isNew ? t('ledger.target') : undefined} className="h-7 text-xs" value={values.target}
      maxLength={LONG_TEXT_LIMITS.termChars} onChange={event => actions.change(rowKey, { target: event.target.value })} onKeyDown={keyDown} />
    <Badge variant="secondary" className="lt-ledger-origin">{t(LEDGER_ORIGIN_LABELS[origin])}</Badge>
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" className="lt-ledger-confirm" aria-label={t('ledger.confirm')} aria-pressed={values.confirmed}
          data-testid="long-text-ledger-confirm" disabled={busy} onClick={() => actions.toggle(rowKey)}><BadgeCheck /></Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{t(values.confirmed ? 'ledger.unconfirm' : 'ledger.confirm')}</TooltipContent>
    </Tooltip>
    <StudioIconButton label={t('ledger.delete')} size="icon-xs" disabled={busy} onClick={() => actions.remove(rowKey)}><Trash2 /></StudioIconButton>
  </li>;
});

/**
 * The document's glossary (720, design §3.3 译名表对话框). Rows save as soon as they are left or Enter
 * is pressed; confirming is a toggle (`aria-pressed`). "保存到翻译资料…" closes this dialog and then
 * opens `KnowledgeCaptureDialog` with every confirmed entry and the document's languages.
 */
export function LedgerDialog() {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const searchInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, RowDraft>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(RENDER_STEP);
  const [capture, setCapture] = useState<CaptureRequest | null>(null);
  const handoff = useRef<CaptureRequest | null>(null);
  /** Responses are applied in request order; an older one never replaces a newer list. */
  const sequence = useRef(0);
  const { request, detail } = useDialogRequest('ledger', () => {
    setEntries(null);
    setLoadFailed(false);
    setDrafts(new Map());
    setQuery('');
    setLimit(RENDER_STEP);
  });
  const open = !!request && !!detail;
  const documentId = detail?.id ?? null;
  const total = detail?.ledger.total;

  // Read again whenever the count changes: the model records entries while a run goes on.
  useEffect(() => {
    if (!open || !documentId) return;
    const mine = ++sequence.current;
    unwrap(window.longText.readLedger({ documentId })).then(
      value => { if (mine === sequence.current) { setEntries(value.entries); setLoadFailed(false); } },
      () => { if (mine === sequence.current) setLoadFailed(true); },
    );
  }, [open, documentId, total, attempt]);

  const latest = useRef({ entries, drafts, documentId, page });
  latest.current = { entries, drafts, documentId, page };

  const dropDraft = useCallback((key: string, draft: RowDraft) => setDrafts(current => {
    if (current.get(key) !== draft) return current;
    const next = new Map(current);
    next.delete(key);
    return next;
  }), []);
  const mutate = useCallback(async (key: string, upserts: LedgerUpsert[], deletes: string[]) => {
    const { documentId: id, page: current } = latest.current;
    if (!id) return false;
    const mine = ++sequence.current;
    setBusy(keys => new Set(keys).add(key));
    try {
      const value = await unwrap(window.longText.updateLedger({ documentId: id, upserts, deletes }));
      if (mine === sequence.current) setEntries(value.entries);
      return true;
    } catch (error) {
      current.reportError(error);
      return false;
    } finally {
      setBusy(keys => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  }, []);

  // Stable for the memoized rows; everything they read goes through `latest`.
  const [actions] = useState<RowActions>(() => ({
    change: (key, patch) => setDrafts(current => {
      const entry = latest.current.entries?.find(item => item.id === key);
      const base = current.get(key) ?? (entry ? draftOf(entry) : { source: '', target: '', confirmed: true });
      return new Map(current).set(key, { ...base, ...patch });
    }),
    commit: (key, enter) => {
      const draft = latest.current.drafts.get(key);
      if (!draft) return;
      const entry = latest.current.entries?.find(item => item.id === key);
      const upsert = ledgerUpsert(draft, entry?.id);
      if (!entry) {
        // The new row waits until both sides are filled in; left empty it goes away.
        if (!upsert) {
          if (!enter && !draft.source.trim() && !draft.target.trim()) dropDraft(key, draft);
          return;
        }
        void mutate(key, [upsert], []).then(saved => {
          if (!saved) return;
          dropDraft(key, draft);
          if (enter) addButton.current?.focus();
        });
        return;
      }
      // An incomplete edit returns to the saved values; an unchanged one has nothing to save.
      if (!upsert || (upsert.source === entry.source && upsert.target === entry.target)) {
        dropDraft(key, draft);
        return;
      }
      void mutate(key, [upsert], []).then(() => dropDraft(key, draft));
    },
    toggle: key => {
      const { entries: list, drafts: edits } = latest.current;
      const entry = list?.find(item => item.id === key);
      const draft = edits.get(key);
      if (!entry) {
        if (draft) setDrafts(current => new Map(current).set(key, { ...draft, confirmed: !draft.confirmed }));
        return;
      }
      const values = (draft && ledgerUpsert(draft, entry.id)) ?? { id: entry.id, source: entry.source, target: entry.target, confirmed: entry.confirmed };
      void mutate(key, [{ ...values, confirmed: !entry.confirmed }], []).then(saved => { if (saved && draft) dropDraft(key, draft); });
    },
    remove: key => {
      const draft = latest.current.drafts.get(key);
      if (key === NEW_ROW) {
        if (draft) dropDraft(key, draft);
        addButton.current?.focus();
        return;
      }
      void mutate(key, [], [key]).then(saved => {
        if (saved && draft) dropDraft(key, draft);
        if (saved) searchInput.current?.focus();
      });
    },
  }));

  const list = entries ?? [];
  const visible = visibleEntries(list, query);
  const adding = drafts.get(NEW_ROW);
  const full = list.length >= LONG_TEXT_LIMITS.ledgerEntries;
  const confirmed = list.filter(entry => entry.confirmed);
  const more = visible.length - limit;
  const add = () => {
    // A second "添加" returns to the row already open.
    if (adding) document.querySelector<HTMLInputElement>('[data-testid=long-text-ledger-row][data-new] input')?.focus();
    else if (!full) actions.change(NEW_ROW, {});
  };
  const saveToMaterials = () => {
    if (!detail || !confirmed.length) return;
    handoff.current = {
      wordings: confirmed.map(({ source, target }) => ({ source, target })),
      languagePair: { source: detail.languages.source, target: detail.languages.target },
    };
    page.closeDialog();
  };

  let body;
  if (!entries) {
    body = loadFailed
      ? <div className="lt-ledger-message" role="alert"><p>{t('errors.internal')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>{t('status.retry')}</Button></div>
      : <p className="lt-ledger-message" role="status"><LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('status.loading')}</p>;
  } else if (!list.length && !adding) {
    body = <p className="lt-ledger-message">{t('ledger.empty')}</p>;
  } else if (!visible.length && !adding) {
    body = <p className="lt-ledger-message">{t('search.empty', { text: query.trim() })}</p>;
  } else {
    body = <>
      <ul className="lt-ledger-list" aria-label={t('ledger.title')}>
        {adding && <LedgerRow rowKey={NEW_ROW} values={adding} origin="user" edited busy={busy.has(NEW_ROW)} actions={actions} />}
        {visible.slice(0, limit).map(entry => {
          const draft = drafts.get(entry.id);
          return <LedgerRow key={entry.id} rowKey={entry.id} values={draft ?? draftOf(entry)} origin={entry.origin} edited={!!draft}
            busy={busy.has(entry.id)} actions={actions} />;
        })}
      </ul>
      {more > 0 && <Button type="button" variant="ghost" size="sm" className="lt-ledger-more" onClick={() => setLimit(value => value + RENDER_STEP)}>
        {t('ledger.more', { count: groupedCount(Math.min(more, RENDER_STEP), i18n.language) })}</Button>}
    </>;
  }

  return <>
    {detail && <DialogFrame open={open} width={720} testId="long-text-ledger-dialog" icon={<BookA />} title={t('ledger.title')} name={detail.name}
      initialFocus={() => searchInput.current}
      onClosed={() => {
        const next = handoff.current;
        handoff.current = null;
        page.restoreFocus();
        // Restored first, so the capture dialog returns focus there too.
        if (next) setCapture(next);
      }}
      toolbar={<div className="lt-ledger-toolbar">
        <div className="lt-ledger-search">
          <Search aria-hidden="true" />
          <Input ref={searchInput} type="search" data-testid="long-text-ledger-search" aria-label={t('ledger.search')} placeholder={t('ledger.search')}
            className="h-7 text-xs" value={query} onChange={event => { setQuery(event.target.value); setLimit(RENDER_STEP); }} />
        </div>
        <Button ref={addButton} type="button" variant="outline" size="sm" data-testid="long-text-ledger-add" disabled={full || !entries} onClick={add}>
          <Plus />{t('ledger.add')}
        </Button>
      </div>}
      footer={<>
        <Tooltip delayDuration={350}>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="mr-auto aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              data-testid="long-text-ledger-save-materials" aria-disabled={!confirmed.length || undefined} onClick={saveToMaterials}>
              <BookmarkPlus />{t('ledger.save_to_materials')}
            </Button>
          </TooltipTrigger>
          {!confirmed.length && <TooltipContent sideOffset={6}>{t('ledger.save_needs_confirmed')}</TooltipContent>}
        </Tooltip>
        <Button type="button" size="sm" data-testid="long-text-ledger-done" onClick={page.closeDialog}>{t('ledger.done')}</Button>
      </>}>
      {full && <div className="lt-ledger-full"><DialogNote tone="info">{t('ledger.full', { max: groupedCount(LONG_TEXT_LIMITS.ledgerEntries, i18n.language) })}</DialogNote></div>}
      {body}
      <p className="lt-ledger-note">{t('ledger.note')}</p>
    </DialogFrame>}
    <CaptureHandoff capture={capture} onClose={() => setCapture(null)} />
  </>;
}

/** Saving confirmed entries to the translation materials, opened after the glossary has closed. */
function CaptureHandoff({ capture, onClose }: { capture: CaptureRequest | null; onClose: () => void }) {
  const [shown, setShown] = useState(capture);
  if (capture && capture !== shown) setShown(capture);
  return <KnowledgeCaptureDialog open={!!capture} onOpenChange={next => { if (!next) onClose(); }} basis="user_stated"
    wordings={shown?.wordings ?? []} languagePair={shown?.languagePair} />;
}
