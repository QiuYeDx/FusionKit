import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList, FileText } from 'lucide-react';
import { LONG_TEXT_LIMITS, type DocumentDetail, type SegmentRow } from '@/long-text/contract';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { useLongTextStore } from '@/store/tools/text/useLongTextStore';
import { showToast } from '@/utils/toast';
import { ToolPanel } from '../../../_shared/ui/ToolPanel';
import { isTranslating } from '../hooks/useDocuments';
import type { ReaderFilter } from '../labels';
import { useLongTextPage } from '../page-context';
import { ReaderFooter } from './ReaderFooter';
import { ReaderActions, ReaderTitle } from './ReaderHeader';
import { ReaderList } from './ReaderList';
import type { RowHandlers } from './ReaderRow';
import { ReaderToolbar } from './ReaderToolbar';
import type { EditorNext } from './RowEditor';
import { hasTranslation, rowAnchor, rowErrorText, segmentCommand, toggleLock } from './RowMenu';
import { useFollowProgress } from './useFollowProgress';
import { useReaderKeyboard, type ReaderKeyAction } from './useReaderKeyboard';
import { RESULT_PAGE_SIZE, useReaderPage, viewKey, type ReaderView } from './useReaderPage';
import './reader.css';

/** A jump's highlight lasts as long as its animation (design §4.9). */
const FLASH_MS = 900;

/** What to focus once the next view is read: its first or last row, or a given one. */
interface PendingFocus {
  target: 'first' | 'last' | number;
  edit?: boolean;
  flash?: boolean;
  center?: boolean;
}

/**
 * Where `locate` starts when no row has focus: just before the rows on screen going forward, just
 * after them going back. At the document's edge it starts from the other end, which is no wrap.
 */
export function locateFrom(direction: 'next' | 'previous', shown: { start: number; end: number }, count: number): { from: number; wrapsAround: boolean } {
  if (direction === 'next') return shown.start > 0 ? { from: shown.start - 1, wrapsAround: false } : { from: count - 1, wrapsAround: true };
  return shown.end < count - 1 ? { from: shown.end + 1, wrapsAround: false } : { from: 0, wrapsAround: true };
}

/** The translatable row `step` away from `index` among `rows`; from no row, the first or the last one. */
export function stepRow(rows: readonly SegmentRow[], index: number | null, step: 1 | -1): SegmentRow | null {
  const candidates = rows.filter(row => row.translatable);
  const at = index === null ? -1 : candidates.findIndex(row => row.index === index);
  if (at < 0) return (step > 0 ? candidates[0] : candidates[candidates.length - 1]) ?? null;
  return candidates[at + step] ?? null;
}

/**
 * What decides how the document is cut into segments: the encoding it was read with and the TXT
 * 段落识别. When it changes, other segments sit under the same indices.
 */
export const segmentationKey = (detail: Pick<DocumentDetail, 'encoding' | 'structure'>): string =>
  `${detail.encoding?.name ?? ''}|${detail.structure?.txtSplit ?? ''}`;

/** Whether an editor still open when the reader goes away holds text to save: changed, and within the edit limit. */
export const draftToKeep = (row: Pick<SegmentRow, 'target'>, text: string): boolean =>
  text !== (row.target ?? '') && text.length <= LONG_TEXT_LIMITS.editChars;

/**
 * The open document (design §3.3-B–D, §4): header, toolbar, rows and footer. `page.detail` is the
 * document on screen; the reader is keyed by its id, so another document starts fresh (an editor
 * still open in the previous one is saved as it goes).
 */
export function ReaderPanel() {
  const page = useLongTextPage();
  if (!page.detail) return null;
  return <Reader key={page.detail.id} detail={page.detail} />;
}

function Reader({ detail }: { detail: DocumentDetail }) {
  const { t, i18n } = useTranslation('text');
  const page = useLongTextPage();
  const documentId = detail.id;
  const targetOnly = useLongTextStore(state => state.view.targetOnly);
  const viewport = useRef<HTMLDivElement>(null);
  const reader = useReaderPage({ documentId, pages: detail.pages, revision: detail.revision, subscribe: page.subscribe });
  const { view, setView, data, load, refresh, apply } = reader;
  const [editing, setEditing] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const draft = useRef<string | null>(null);
  /** True while `save` sends an edit, so leaving the document meanwhile does not send it again. */
  const saving = useRef(false);
  const pending = useRef<PendingFocus | null>(null);
  const lastPage = useRef(view.kind === 'page' ? view.page : 0);
  const running = isTranslating(detail);

  const showPage = useCallback((target: number) => setView({ kind: 'page', page: target }), [setView]);
  const follow = useFollowProgress({ running, frontierPage: detail.run?.frontierPage ?? null, view, editing: editing !== null, data, viewport, showPage });

  useEffect(() => { if (view.kind === 'page') lastPage.current = view.page; }, [view]);

  const translatable = data.rows.filter(row => row.translatable);
  const focused = translatable.some(row => row.index === focusIndex) ? focusIndex : null;
  const tabStop = focused ?? translatable[0]?.index ?? null;

  // Commands read the latest state through this, so they keep their identity for the memoized rows.
  const latest = useRef({ data, view, editing, focused, detail, follow, page });
  latest.current = { data, view, editing, focused, detail, follow, page };

  /** Focuses a row at once when it is on screen (a dialog opened next records it), else once it renders. */
  const focusRow = useCallback((index: number, options: { center?: boolean } = {}) => {
    setFocusIndex(index);
    const focus = () => {
      const element = viewport.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
      if (!element) return false;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: options.center ? 'center' : 'nearest' });
      return true;
    };
    if (!focus()) requestAnimationFrame(focus);
  }, []);

  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flashRow = useCallback((index: number) => {
    clearTimeout(flashTimer.current);
    setFlash(index);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const save = useCallback(async (row: SegmentRow, text: string): Promise<boolean> => {
    saving.current = true;
    try {
      if (text !== (row.target ?? '')) {
        const saved = await segmentCommand(latest.current.page, t, () => unwrap(window.longText.edit({ documentId, index: row.index, rev: row.rev, text })));
        if (!saved) return false;
        // `ordinal` is also i18next's ordinal-plural switch, so the value goes through `replace`.
        latest.current.page.announce(t('row.saved', { replace: { ordinal: row.ordinal.toLocaleString(i18n.language) } }));
      }
      setEditing(current => current === row.index ? null : current);
      draft.current = null;
      return true;
    } finally {
      saving.current = false;
    }
  }, [documentId, t, i18n]);

  // A new segmentation (TXT 段落识别 or encoding changed) puts other segments under the same indices:
  // the open editor's segment is gone, so it closes without saving. A plain settings save keeps it.
  const segmentation = segmentationKey(detail);
  const shownSegmentation = useRef(segmentation);
  useEffect(() => {
    if (shownSegmentation.current === segmentation) return;
    shownSegmentation.current = segmentation;
    setEditing(null);
    draft.current = null;
  }, [segmentation]);

  // Another document or another page replaces the reader: an editor still open keeps what was typed.
  // Only refs are read, so this runs when the reader goes away and never on a re-render.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => () => {
    const { editing: index, data: shown } = latest.current;
    const text = draft.current;
    const row = index === null ? undefined : shown.rows.find(item => item.index === index);
    if (saving.current || !row || text === null || !draftToKeep(row, text)) return;
    unwrap(window.longText.edit({ documentId, index: row.index, rev: row.rev, text })).catch((error: unknown) => {
      // The document was just deleted: nothing is left to save it to.
      if (errorCodeOf(error) === 'not_found') return;
      showToast(rowErrorText(tRef.current, error), 'error');
    });
    // `documentId` is fixed for the reader, which is keyed by it.
  }, []);

  /** Saves the open editor, when it changed anything, before something else happens. */
  const commitEditor = useCallback(async (): Promise<boolean> => {
    const { editing: index, data: shown } = latest.current;
    if (index === null) return true;
    const row = shown.rows.find(item => item.index === index);
    const text = draft.current;
    if (!row || text === null) {
      setEditing(null);
      return true;
    }
    return save(row, text);
  }, [save]);

  /** Shows a view the user chose: an open edit is saved, following stops, `focus` waits for the rows. */
  const navigate = useCallback((next: ReaderView, focus: PendingFocus | null) => {
    void commitEditor();
    setEditing(null);
    latest.current.follow.stop();
    pending.current = focus;
    if (next.kind === 'page') lastPage.current = next.page;
    if (viewKey(next) === viewKey(latest.current.view)) refresh();
    setView(next);
  }, [commitEditor, refresh, setView]);

  // A view read anew starts at its top; the focus asked for lands once its rows are there.
  const shownKey = viewKey(data.view);
  useEffect(() => {
    if (!pending.current) viewport.current?.scrollTo({ top: 0 });
  }, [shownKey]);
  useEffect(() => {
    const focus = pending.current;
    if (!focus || load.status !== 'ready' || shownKey !== viewKey(latest.current.view)) return;
    pending.current = null;
    const rows = data.rows.filter(row => row.translatable);
    const row = focus.target === 'first' ? rows[0] : focus.target === 'last' ? rows[rows.length - 1] : rows.find(item => item.index === focus.target);
    if (!row) return;
    focusRow(row.index, { center: focus.center });
    if (focus.flash) flashRow(row.index);
    if (focus.edit && row.status !== 'translating') setEditing(row.index);
  }, [shownKey, load.status, data, focusRow, flashRow]);

  /**
   * Shows a row and focuses it: in place when it is on screen, otherwise on its page of the "all"
   * view. Attention jumps also stay in the attention results that list the row; "定位到原位置" does not.
   */
  const reveal = useCallback((index: number, target: number, focus: Omit<PendingFocus, 'target'>, inResults: boolean) => {
    const { view: current, data: shown } = latest.current;
    const onScreen = shown.rows.some(row => row.index === index)
      && (current.kind === 'page' ? current.page === target : inResults && current.kind === 'filter' && current.filter === 'attention');
    if (!onScreen) {
      navigate({ kind: 'page', page: target }, { target: index, ...focus });
      return;
    }
    latest.current.follow.stop();
    focusRow(index, { center: focus.center });
    if (focus.flash) flashRow(index);
  }, [focusRow, flashRow, navigate]);

  /** The next or previous segment needing attention, across pages (design §4.6, AC-LT-16-5). */
  const jumpAttention = useCallback(async (direction: 'next' | 'previous', from: number | null) => {
    const { detail: doc, data: shown, page: context } = latest.current;
    const count = (doc.pages[doc.pages.length - 1]?.end ?? -1) + 1;
    if (!count) return;
    const start = from === null
      ? locateFrom(direction, { start: shown.rows[0]?.index ?? 0, end: shown.rows[shown.rows.length - 1]?.index ?? count - 1 }, count)
      : { from, wrapsAround: false };
    try {
      const result = await unwrap(window.longText.locate({ documentId, from: start.from, direction }));
      if (!result) return;
      if (result.wrapped && !start.wrapsAround) context.announce(t('filter.wrapped'));
      reveal(result.index, result.page, { flash: true, center: true }, true);
    } catch (error) {
      context.reportError(error);
    }
  }, [documentId, reveal, t]);

  const startEdit = useCallback(async (row: SegmentRow) => {
    if (row.status === 'translating' || latest.current.editing === row.index) return;
    if (!(await commitEditor())) return;
    latest.current.follow.stop();
    draft.current = null;
    setFocusIndex(row.index);
    setEditing(row.index);
  }, [commitEditor]);

  /** Alt+↓ / Alt+↑: the editor of the next or previous row, on the next or previous page at the ends. */
  const editNext = useCallback((index: number, step: 1 | -1) => {
    const { data: shown, view: current, detail: doc } = latest.current;
    const next = stepRow(shown.rows, index, step);
    if (next) {
      if (next.status === 'translating') focusRow(next.index);
      else {
        setFocusIndex(next.index);
        setEditing(next.index);
      }
      return;
    }
    const target = current.kind === 'page' ? current.page + step : -1;
    if (target >= 0 && target < doc.pages.length) navigate({ kind: 'page', page: target }, { target: step > 0 ? 'first' : 'last', edit: true });
    else focusRow(index);
  }, [focusRow, navigate]);

  /** "重试" on a failed row: one more translation of it, without a requirement. */
  const retry = useCallback((row: SegmentRow) => {
    apply({ ...row, status: 'translating' });
    latest.current.page.retranslate(row).then(apply, (error: unknown) => {
      apply(row);
      showToast(rowErrorText(t, error), 'error');
    });
  }, [apply, t]);

  const openMenu = useCallback((row: SegmentRow, point?: { x: number; y: number } | null) => {
    const at = point ?? rowAnchor(row.index, 'menu');
    if (!at) return;
    setFocusIndex(row.index);
    latest.current.page.setRowMenu({ row, point: at, inList: latest.current.data.view.kind !== 'page' });
  }, []);

  const openRetranslate = useCallback((row: SegmentRow) => {
    const at = rowAnchor(row.index, 'retranslate');
    if (!at) return;
    setFocusIndex(row.index);
    latest.current.page.setRetranslateTarget({ row, point: at, inList: latest.current.data.view.kind !== 'page' });
  }, []);

  const handlers = useMemo<RowHandlers>(() => ({
    focus: setFocusIndex,
    contextMenu: (row, point) => openMenu(row, point),
    menu: row => openMenu(row),
    retranslate: openRetranslate,
    retry,
    edit: row => void startEdit(row),
    save: (row, text, next?: EditorNext) => {
      void save(row, text).then(saved => {
        if (!saved) return;
        if (!next) focusRow(row.index);
        else if (next.kind === 'move') editNext(row.index, next.step);
        else void jumpAttention(next.direction, row.index);
      });
    },
    cancel: row => {
      setEditing(null);
      draft.current = null;
      focusRow(row.index);
    },
    draft: text => { draft.current = text; },
    dismiss: (row, code) => void segmentCommand(latest.current.page, t, () => unwrap(window.longText.dismissFlag({ documentId, index: row.index, rev: row.rev, code }))),
    toggleExpanded: index => setExpanded(set => {
      const next = new Set(set);
      if (!next.delete(index)) next.add(index);
      return next;
    }),
  }), [openMenu, openRetranslate, retry, startEdit, save, focusRow, editNext, jumpAttention, documentId, t]);

  const onKeyDown = useReaderKeyboard((action: ReaderKeyAction, index: number | null) => {
    const { data: shown, view: current, detail: doc, focused: last, page: context } = latest.current;
    const row = index === null ? undefined : shown.rows.find(item => item.index === index);
    switch (action.kind) {
      case 'scroll':
        latest.current.follow.stop();
        return;
      case 'move': {
        latest.current.follow.stop();
        // From the reader itself, the row last focused (or the first one) takes focus first.
        const next = index === null ? (last === null ? stepRow(shown.rows, null, 1) : shown.rows.find(item => item.index === last)) : stepRow(shown.rows, index, action.step);
        if (next) { focusRow(next.index); return; }
        const edge: PendingFocus = { target: action.step > 0 ? 'first' : 'last' };
        if (current.kind === 'page') {
          const target = current.page + action.step;
          if (target >= 0 && target < doc.pages.length) navigate({ kind: 'page', page: target }, edge);
        } else {
          const offset = current.offset + action.step * RESULT_PAGE_SIZE;
          if (offset >= 0 && offset < shown.total) navigate({ ...current, offset }, edge);
        }
        return;
      }
      case 'attention':
        void jumpAttention(action.direction, index ?? last);
        return;
      case 'edit':
        if (row) void startEdit(row);
        return;
      case 'retranslate':
        if (row && row.status !== 'translating') openRetranslate(row);
        return;
      case 'lock':
        if (row && hasTranslation(row)) void toggleLock(context, t, documentId, row);
        return;
      case 'menu':
        if (row) openMenu(row);
    }
  });

  // What only the reader can do, for the row menu and the popover at page level.
  const register = page.registerReader;
  useEffect(() => {
    register({
      edit: index => {
        const row = latest.current.data.rows.find(item => item.index === index);
        if (row) void startEdit(row);
      },
      locate: (index, target) => reveal(index, target, { flash: true, center: true }, false),
      apply,
      focusRow: index => focusRow(index),
    });
    return () => register(null);
  }, [register, startEdit, reveal, apply, focusRow]);

  const chooseFilter = (filter: ReaderFilter) =>
    navigate(filter === 'all' ? { kind: 'page', page: lastPage.current } : { kind: 'filter', filter, offset: 0 }, null);
  const search = (text: string | null) => {
    if (text) navigate({ kind: 'search', text, offset: 0 }, null);
    else if (view.kind === 'search') navigate({ kind: 'page', page: lastPage.current }, null);
  };
  /** The pill, or the footer toggle turned on: back to the run's page, following again. */
  const resume = () => {
    void commitEditor();
    setEditing(null);
    follow.resume();
    if (view.kind !== 'page') showPage(detail.run?.frontierPage ?? lastPage.current);
  };

  const overlay = page.rowMenu?.row.index ?? page.retranslateTarget?.row.index ?? null;
  const model = 'problem' in page.runModel ? null : page.runModel.model.label;
  return <ToolPanel className="lt-reader-panel" icon={detail.source.kind === 'paste' ? ClipboardList : FileText}
    title={<ReaderTitle detail={detail} />} actions={<ReaderActions detail={detail} />}
    footer={<ReaderFooter detail={detail} estimate={page.estimate} model={model} view={view} total={data.total}
      follow={{ shown: running, on: follow.follow, toggle: follow.follow ? follow.stop : resume }}
      onPage={(target, keyboard) => navigate({ kind: 'page', page: target }, keyboard ? { target: 'first' } : null)}
      onOffset={offset => { if (view.kind !== 'page') navigate({ ...view, offset }, null); }} />}>
    <div className="lt-document-view">
      <ReaderToolbar detail={detail} filter={view.kind === 'filter' ? view.filter : 'all'} search={view.kind === 'search' ? view.text : null}
        onFilter={chooseFilter} onSearch={search} onAttention={direction => void jumpAttention(direction, latest.current.focused)} />
      <ReaderList detail={detail} view={view} data={data} load={load} targetOnly={targetOnly} tabStop={tabStop} editing={editing} flash={flash}
        overlayIndex={overlay} expanded={expanded} handlers={handlers} viewportRef={viewport} focusRef={page.registerReaderFocus}
        onKeyDown={onKeyDown} onNextPage={keyboard => { if (view.kind === 'page') navigate({ kind: 'page', page: view.page + 1 }, keyboard ? { target: 'first' } : null); }}
        onClearSearch={() => search(null)} onRetry={reader.retry} pill={{ shown: follow.pill, onClick: resume }} />
    </div>
  </ToolPanel>;
}
