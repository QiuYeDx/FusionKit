import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import type { LongTextChangeEvent } from '@/long-text/channels';
import {
  LONG_TEXT_LIMITS,
  type DocumentDetail,
  type DocumentSummary,
  type Estimate,
  type ImportSkip,
  type LongTextFormat,
  type SegmentRow,
} from '@/long-text/contract';
import { errorCodeOf, LongTextClientError, unwrap } from '@/services/long-text/client';
import { costRange, type RunModel, type RunModelProblem } from '@/services/long-text/model';
import useModelStore from '@/store/useModelStore';
import { toImportDefaults, useLongTextStore } from '@/store/tools/text/useLongTextStore';
import { showToast } from '@/utils/toast';
import { ERROR_LABELS } from './labels';
import { useDocumentDetail, toSummary, type DetailState, type EstimateView } from './hooks/useDocumentDetail';
import { nextActiveAfter, resolveActive, useDocuments, type ChangeListener, type ImportOutcome, type ImportProgress, type ListState } from './hooks/useDocuments';

/** What a run command starts (`start` request without the document and the model). */
export type StartIntent =
  | { kind: 'full' }
  | { kind: 'sample'; resample?: boolean }
  | { kind: 'from'; fromIndex: number };

/** Where the settings dialog puts focus when a run could not start without a change there. */
export type SettingsFocus = 'model' | 'materials';

/**
 * The page's dialogs; one is open at a time. `back` is the dialog that returns when this one closes
 * (for example the settings behind the glossary opened from them).
 */
export type PageDialog = (
  /** `intent: 'run'` saves and then starts `run` ("保存并翻译"). */
  | { kind: 'settings'; intent: 'edit' | 'run'; focus?: SettingsFocus; run?: StartIntent }
  /** A large run waits for confirmation; `start(run, { confirmed: true })` continues it. */
  | { kind: 'runConfirm'; run: StartIntent; estimate: Estimate; cost: [number, number] | null; model: string }
  | { kind: 'export' }
  | { kind: 'ledger' }
  | { kind: 'encoding' }
  /** Deleting names its document: an unavailable one has no detail. */
  | { kind: 'confirm'; action: 'delete'; documentId: string; name: string }
  | { kind: 'confirm'; action: 'clear' }
  /** "从此段起重新翻译": `count` translatable segments from `ordinal` on. */
  | { kind: 'confirm'; action: 'from'; index: number; ordinal: number; count: number }
  | { kind: 'rename' }
  | { kind: 'paste'; text: string }
  | { kind: 'library' }
) & { back?: PageDialog };

/** Page notices that come from something that just happened rather than from the document state. */
export type TransientNotice =
  | { kind: 'import'; id: number; skipped: ImportSkip[]; duplicates: string[] }
  | { kind: 'large'; id: number; names: string[] }
  | { kind: 'exported'; id: number; documentId: string; name: string }
  | { kind: 'knowledge'; id: number; documentId: string };
type NewNotice = TransientNotice extends infer N ? N extends TransientNotice ? Omit<N, 'id'> : never : never;

/** The row a reader overlay (row menu, retranslate popover) works on. */
export interface RowOverlay {
  row: SegmentRow;
  /** Viewport point the overlay is anchored at: the pointer for a context menu, the ⋯ / ⟲ button otherwise. */
  point: { x: number; y: number };
  /** True in the filter and search views, where "定位到原位置" applies. */
  inList: boolean;
}

/** What only the reader can do; it registers this while mounted so page-level overlays can use it. */
export interface ReaderBridge {
  /** Opens the row editor (Enter / F2 / the menu item). */
  edit(index: number): void;
  /** Shows the row on its page in the "all" view and focuses it. */
  locate(index: number, page: number): void;
  /** Puts a row returned by a segment command into the rows on screen. */
  apply(row: SegmentRow): void;
  /** Focuses a row, for example after an overlay closes. */
  focusRow(index: number): void;
}

export interface StartOptions {
  /** The large-run confirmation was already given. */
  confirmed?: boolean;
}

export interface LongTextPage {
  /** At least the `lg` breakpoint: the library is the left column instead of a dialog. */
  wide: boolean;

  // Library
  documents: readonly DocumentSummary[];
  storageBytes: number;
  listState: ListState;
  reloadList(): void;
  /** True from the start of an import until it ends. */
  importBusy: boolean;
  /** The import shown in the list and over the reader (after 150 ms, and not behind the native picker). */
  importing: ImportProgress | null;

  // The open document
  /** The document being opened or open (may differ from `detail.id` while it loads). */
  activeId: string | null;
  /** The document on screen; while another one loads this is still the previous one. */
  detail: DocumentDetail | null;
  detailState: DetailState;
  retryDetail(): void;
  /** Reads the detail again (at most once per second). */
  refreshDetail(): void;
  /** Shows a detail returned by a command (settings, encoding, structure). */
  applyDetail(detail: DocumentDetail): void;
  /** The model a run of the open document would use, or why there is none. */
  runModel: RunModel | { problem: RunModelProblem };
  /** Estimate of translating what is left of `detail` with `runModel`. */
  estimate: EstimateView | null;
  /** Relayed change events, newest only and in order, after the page has applied them. */
  subscribe(listener: ChangeListener): () => void;

  // Dialogs and overlays
  dialog: PageDialog | null;
  /** Opens a dialog; focus returns to the element focused before the first dialog opened. */
  openDialog(dialog: PageDialog): void;
  /** Closes the dialog, or returns to its `back` dialog. */
  closeDialog(): void;
  /** Whether `dialog` is still the open one: a command it ran (a run start) may have opened another in its place. */
  isDialogOpen(dialog: PageDialog): boolean;
  /** Call from a dialog's `onCloseAutoFocus` after `preventDefault()`. */
  restoreFocus(): void;
  rowMenu: RowOverlay | null;
  setRowMenu(menu: RowOverlay | null): void;
  retranslateTarget: RowOverlay | null;
  setRetranslateTarget(target: RowOverlay | null): void;
  reader: ReaderBridge | null;
  registerReader(bridge: ReaderBridge | null): void;
  /** Callback ref for the reader's focus container (`tabIndex=-1`). */
  registerReaderFocus(element: HTMLElement | null): void;
  /** Focuses the reader container without scrolling, once the document on screen is the active one. */
  focusReader(): void;
  /** Increments for every Ctrl+F; the reader opens and focuses its search box. */
  searchRequest: number;
  requestSearch(): void;

  // Notices and announcements
  notices: readonly TransientNotice[];
  /** Returns the notice's id; a new notice replaces the one of the same kind. */
  pushNotice(notice: NewNotice): number;
  dismissNotice(id: number): void;
  /** Increments when a run was refused for the unconfirmed encoding; the notice flashes. */
  encodingFlash: number;
  announcement: { id: number; text: string };
  announce(text: string): void;

  // Commands
  selectDocument(id: string): void;
  pickFiles(): void;
  /** Call synchronously from the drop event. */
  importDropped(files: readonly File[]): void;
  /** Rejects with `LongTextClientError`; on success the new document is open. */
  importText(name: string, text: string, format: LongTextFormat): Promise<void>;
  /**
   * Starts a run of the open document after the checks of design §2 F5-7: an unconfirmed encoding
   * flashes its notice, a missing model opens the settings, a large full run asks first. Resolves
   * whether the run started; failures are shown by the page.
   */
  start(intent: StartIntent, options?: StartOptions): Promise<boolean>;
  pause(immediate: boolean): Promise<void>;
  /** Rejects with `LongTextClientError` (`model_invalid` when no model can run). */
  retranslate(row: SegmentRow, instruction?: string): Promise<SegmentRow>;
  confirmEncoding(): Promise<void>;
  /** Deletes a document, opens the next one and moves focus to it in the library; rejects on failure. */
  removeDocument(id: string): Promise<void>;
  /** A toast for a failed command. */
  reportError(error: unknown): void;
}

const LongTextPageContext = createContext<LongTextPage | null>(null);

export function useLongTextPage(): LongTextPage {
  const value = useContext(LongTextPageContext);
  if (!value) throw new Error('useLongTextPage must be used inside LongTextPageProvider');
  return value;
}

/**
 * A count grouped for the interface language ("12,340"). The text keys have no plural forms, so
 * i18next only interpolates `count`; its typings still declare the plural number, hence the cast.
 */
export function groupedCount(value: number, language: string): number {
  return value.toLocaleString(language) as unknown as number;
}

/** Where "去设置模型" goes. */
export const MODEL_SETTINGS_ROUTE = '/setting?tab=model';

/** Loading states show only when they last; a quick switch never flashes (design §4.7). */
export const SETTLE_DELAY_MS = 150;

/** `flag` once it has held for `delay` ms. */
export function useSettledFlag(flag: boolean, delay = SETTLE_DELAY_MS): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!flag) { setSettled(false); return; }
    const timer = setTimeout(() => setSettled(true), delay);
    return () => clearTimeout(timer);
  }, [flag, delay]);
  return flag && settled;
}

const WIDE_QUERY = '(min-width: 1024px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(WIDE_QUERY);
    const change = () => setWide(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return wide;
}

/** The native file dialog takes the window's focus; an import behind it is not shown yet. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); };
  }, []);
  return focused;
}

function isVisible(element: HTMLElement | null): element is HTMLElement {
  return !!element && element.isConnected && !element.closest('[inert]') && element.getClientRects().length > 0;
}

/** The library's current row, the narrow document picker, or the empty state's file button. */
function focusLibrary(): void {
  const candidates = [
    document.querySelector<HTMLElement>('[data-testid=long-text-library-row][aria-current="true"]'),
    document.getElementById('long-text-document-select'),
    document.querySelector<HTMLElement>('[data-testid=long-text-picker] button:last-of-type'),
  ];
  candidates.find(isVisible)?.focus({ preventScroll: true });
}

type FocusTarget = HTMLElement | (() => void) | null;

const startRequest = (intent: StartIntent) => ({
  kind: intent.kind,
  ...(intent.kind === 'from' ? { fromIndex: intent.fromIndex } : {}),
  ...(intent.kind === 'sample' && intent.resample ? { resample: true } : {}),
});

/** State and commands of the long text translator page (design §8.3). */
export function LongTextPageProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('text');
  const wide = useWide();
  const windowFocused = useWindowFocused();
  const rememberedId = useLongTextStore(state => state.activeDocumentId);
  const defaults = useLongTextStore(state => state.defaults);
  const profiles = useModelStore(state => state.profiles);
  const taskProfileId = useModelStore(state => state.assignment.taskExecution);

  const importDefaults = useCallback(() => toImportDefaults(useLongTextStore.getState().defaults, i18n.language), []);
  const library = useDocuments(importDefaults);
  const { documents, listState, subscribe } = library;
  const activeId = listState === 'ready' ? resolveActive(documents, rememberedId) : null;
  const activeSummary = documents.find(item => item.id === activeId);

  // Keep the remembered document in step with what is shown (a deleted one falls back to the newest).
  useEffect(() => {
    if (listState === 'ready' && activeId !== rememberedId) useLongTextStore.getState().setActiveDocument(activeId);
  }, [listState, activeId, rememberedId]);

  const taskProfile = useMemo(() => profiles.find(profile => profile.id === taskProfileId) ?? null, [profiles, taskProfileId]);
  const current = useDocumentDetail({ activeId, summary: activeSummary, subscribe, profiles, taskProfile, fallback: defaults });
  const { detail, runModel } = current;

  // Dialogs, overlays and focus.
  const [dialog, setDialog] = useState<PageDialog | null>(null);
  const dialogRef = useRef<PageDialog | null>(null);
  const opener = useRef<FocusTarget>(null);
  const updateDialog = useCallback((next: PageDialog | null) => {
    dialogRef.current = next;
    setDialog(next);
  }, []);
  const openDialog = useCallback((next: PageDialog) => {
    if (!dialogRef.current) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    updateDialog(next);
  }, [updateDialog]);
  const closeDialog = useCallback(() => updateDialog(dialogRef.current?.back ?? null), [updateDialog]);
  const isDialogOpen = useCallback((value: PageDialog) => dialogRef.current === value, []);
  useEffect(() => {
    if (wide && dialogRef.current?.kind === 'library') updateDialog(null);
  }, [wide, updateDialog]);

  const readerFocus = useRef<HTMLElement | null>(null);
  const focusPending = useRef(false);
  const focusReaderNow = useCallback(() => {
    if (!isVisible(readerFocus.current)) return false;
    readerFocus.current.focus({ preventScroll: true });
    return true;
  }, []);
  const registerReaderFocus = useCallback((element: HTMLElement | null) => {
    readerFocus.current = element;
    if (element && focusPending.current && focusReaderNow()) focusPending.current = false;
  }, [focusReaderNow]);
  const detailCurrent = current.state.status === 'ready' && detail?.id === activeId;
  const detailCurrentRef = useRef(detailCurrent);
  detailCurrentRef.current = detailCurrent;
  const focusReader = useCallback(() => {
    focusPending.current = !(detailCurrentRef.current && focusReaderNow());
  }, [focusReaderNow]);
  useEffect(() => {
    if (focusPending.current && detailCurrent && focusReaderNow()) focusPending.current = false;
  });

  const restoreFocus = useCallback(() => {
    if (dialogRef.current) return;
    const target = opener.current;
    opener.current = null;
    if (typeof target === 'function') target();
    else if (isVisible(target)) target.focus({ preventScroll: true });
    else focusReaderNow();
  }, [focusReaderNow]);

  const [rowMenu, setRowMenu] = useState<RowOverlay | null>(null);
  const [retranslateTarget, setRetranslateTarget] = useState<RowOverlay | null>(null);
  const [reader, registerReader] = useState<ReaderBridge | null>(null);
  const [searchRequest, setSearchRequest] = useState(0);
  const requestSearch = useCallback(() => setSearchRequest(value => value + 1), []);

  // Notices and the live region.
  const [notices, setNotices] = useState<TransientNotice[]>([]);
  const noticeId = useRef(0);
  const pushNotice = useCallback((notice: NewNotice) => {
    const id = ++noticeId.current;
    setNotices(list => [{ ...notice, id } as TransientNotice, ...list.filter(item => item.kind !== notice.kind)]);
    return id;
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices(list => list.filter(item => item.id !== id)), []);
  const [encodingFlash, setEncodingFlash] = useState(0);
  const [announcement, setAnnouncement] = useState({ id: 0, text: '' });
  const announce = useCallback((text: string) => setAnnouncement(previous => ({ id: previous.id + 1, text })), []);

  const reportError = useCallback((error: unknown) => {
    showToast(t(ERROR_LABELS[errorCodeOf(error)]), 'error');
  }, [t]);

  // The latest values for the commands, which keep a stable identity.
  const latest = useRef({ documents, activeId, detail, runModel, estimate: current.estimate });
  latest.current = { documents, activeId, detail, runModel, estimate: current.estimate };
  /** The document commands act on: the detail on screen, only while it is the active document. */
  const activeDetail = useCallback(() => {
    const { detail: doc, activeId: open } = latest.current;
    return doc && doc.id === open ? doc : null;
  }, []);

  // Deletions elsewhere (another window, the agent) move on to the next document.
  useEffect(() => subscribe((event: LongTextChangeEvent) => {
    if (event.kind !== 'deleted' || !event.documentId) return;
    const { documents: list, activeId: open } = latest.current;
    const store = useLongTextStore.getState();
    store.forgetDocument(event.documentId);
    if (event.documentId === open) store.setActiveDocument(nextActiveAfter(list, event.documentId));
  }), [subscribe]);

  // "翻译完成，n 段需关注" when a run of the open document completes.
  const lastRun = useRef<{ id: string; status: string } | null>(null);
  const run = detail?.run ?? null;
  useEffect(() => {
    const previous = lastRun.current;
    lastRun.current = run ? { id: run.id, status: run.status } : null;
    if (run && previous?.id === run.id && previous.status !== 'completed' && run.status === 'completed' && run.kind !== 'sample') {
      announce(t('notices.completed', { count: latest.current.detail?.counts.attention ?? 0 }));
    }
  }, [run, announce, t]);

  const selectDocument = useCallback((id: string) => useLongTextStore.getState().setActiveDocument(id), []);

  const afterImport = useCallback((outcome: ImportOutcome | null) => {
    if (!outcome) return;
    if (outcome.activate) {
      selectDocument(outcome.activate);
      focusReader();
    }
    if (outcome.imported) announce(t('import.imported', { count: outcome.imported }));
    if (outcome.skipped.length || outcome.duplicates.length) {
      pushNotice({ kind: 'import', skipped: outcome.skipped, duplicates: outcome.duplicates });
    }
  }, [selectDocument, focusReader, announce, t, pushNotice]);

  const pickFiles = useCallback(() => {
    library.pickFiles(t('import.filter_name')).then(afterImport, reportError);
  }, [library.pickFiles, t, afterImport, reportError]);

  const importDropped = useCallback((files: readonly File[]) => {
    const pending = library.importDropped(files);
    const large = files.filter(file => file.size > LONG_TEXT_LIMITS.largeFileBytes && file.size <= LONG_TEXT_LIMITS.fileBytes);
    const largeId = large.length ? pushNotice({ kind: 'large', names: large.map(file => file.name) }) : 0;
    pending.then(afterImport, reportError).finally(() => { if (largeId) dismissNotice(largeId); });
  }, [library.importDropped, pushNotice, dismissNotice, afterImport, reportError]);

  const importText = useCallback(async (name: string, text: string, format: LongTextFormat) => {
    const summary = await library.importText(name, text, format);
    if (summary) afterImport({ activate: summary.id, imported: 1, skipped: [], duplicates: [] });
  }, [library.importText, afterImport]);

  const applyDetail = useCallback((value: DocumentDetail) => {
    library.accept([toSummary(value)]);
    current.applyDetail(value);
  }, [library.accept, current.applyDetail]);

  const flashEncoding = useCallback(() => setEncodingFlash(value => value + 1), []);

  const startFailed = useCallback((error: unknown, intent: StartIntent, documentId: string) => {
    const code = errorCodeOf(error);
    if (code === 'encoding_unconfirmed') flashEncoding();
    else if (code === 'knowledge_unavailable' || code === 'knowledge_invalid') pushNotice({ kind: 'knowledge', documentId });
    else if (code === 'model_invalid' || code === 'model_context_too_small') openDialog({ kind: 'settings', intent: 'run', focus: 'model', run: intent });
    else reportError(error);
  }, [flashEncoding, pushNotice, openDialog, reportError]);

  /** The estimate on screen, or a fresh one when the page has none yet. */
  const fullEstimate = useCallback(async (doc: DocumentDetail, model: RunModel): Promise<Estimate | null> => {
    const known = latest.current.estimate;
    if (known?.documentId === doc.id) return known.value;
    try {
      return await unwrap(window.longText.estimate({
        documentId: doc.id, scope: 'full', contextWindow: model.model.contextWindow, maxOutputTokens: model.model.maxOutputTokens,
      }));
    } catch {
      return null;
    }
  }, []);

  const start = useCallback(async (intent: StartIntent, options: StartOptions = {}) => {
    const doc = activeDetail();
    const model = latest.current.runModel;
    if (!doc) return false;
    if (doc.encoding && !doc.encoding.confirmed) {
      flashEncoding();
      return false;
    }
    if ('problem' in model) {
      openDialog({ kind: 'settings', intent: 'run', focus: 'model', run: intent });
      return false;
    }
    if (intent.kind === 'full' && !options.confirmed) {
      const estimate = await fullEstimate(doc, model);
      if (estimate && estimate.inputTokens[1] + estimate.outputTokens[1] > LONG_TEXT_LIMITS.runConfirmTokens) {
        openDialog({ kind: 'runConfirm', run: intent, estimate, cost: costRange(estimate, model.profile.tokenPricing), model: model.model.label });
        return false;
      }
    }
    try {
      await unwrap(window.longText.start({ documentId: doc.id, ...startRequest(intent), model: model.model, apiKey: model.apiKey }));
    } catch (error) {
      startFailed(error, intent, doc.id);
      return false;
    }
    useLongTextStore.getState().setFollow(true);
    if (model.fellBack) showToast(t('notices.model_fallback'));
    return true;
  }, [activeDetail, flashEncoding, openDialog, fullEstimate, startFailed, t]);

  const pause = useCallback(async (immediate: boolean) => {
    const doc = activeDetail();
    if (!doc) return;
    try {
      await unwrap(window.longText.pause({ documentId: doc.id, immediate }));
    } catch (error) {
      reportError(error);
    }
  }, [activeDetail, reportError]);

  // A row command works on the document the row is on, which is the one on screen.
  const retranslate = useCallback(async (row: SegmentRow, instruction?: string) => {
    const { detail: doc, runModel: model } = latest.current;
    if (!doc || 'problem' in model) throw new LongTextClientError('model_invalid');
    const text = instruction?.trim();
    const result = await unwrap(window.longText.retranslate({
      documentId: doc.id, index: row.index, rev: row.rev, ...(text ? { instruction: text } : {}), model: model.model, apiKey: model.apiKey,
    }));
    if (model.fellBack) showToast(t('notices.model_fallback'));
    return result;
  }, [t]);

  const confirmEncoding = useCallback(async () => {
    const doc = activeDetail();
    if (!doc) return;
    try {
      applyDetail(await unwrap(window.longText.confirmEncoding({ documentId: doc.id })));
    } catch (error) {
      reportError(error);
    }
  }, [activeDetail, applyDetail, reportError]);

  // After a deletion focus goes to the library once the next document is current. The confirmation
  // dialog, still open here, hands it over when it closes, whenever the list renders.
  const libraryFocusPending = useRef(false);
  const removeDocument = useCallback(async (id: string) => {
    const next = nextActiveAfter(latest.current.documents, id);
    await unwrap(window.longText.remove({ documentId: id }));
    const store = useLongTextStore.getState();
    const wasOpen = latest.current.activeId === id;
    library.drop(id);
    store.forgetDocument(id);
    if (wasOpen) store.setActiveDocument(next);
    if (dialogRef.current) opener.current = focusLibrary;
    else libraryFocusPending.current = true;
  }, [library.drop]);
  useEffect(() => {
    if (!libraryFocusPending.current) return;
    libraryFocusPending.current = false;
    focusLibrary();
  }, [activeId, documents]);

  const importBusy = library.importing !== null;
  const importShown = useSettledFlag(importBusy && (windowFocused || library.importing?.names !== null));

  const value: LongTextPage = {
    wide,
    documents,
    storageBytes: library.storageBytes,
    listState,
    reloadList: library.reload,
    importBusy,
    importing: importShown ? library.importing : null,
    activeId,
    detail,
    detailState: current.state,
    retryDetail: current.retry,
    refreshDetail: current.refresh,
    applyDetail,
    runModel,
    estimate: current.estimate,
    subscribe,
    dialog,
    openDialog,
    closeDialog,
    isDialogOpen,
    restoreFocus,
    rowMenu,
    setRowMenu,
    retranslateTarget,
    setRetranslateTarget,
    reader,
    registerReader,
    registerReaderFocus,
    focusReader,
    searchRequest,
    requestSearch,
    notices,
    pushNotice,
    dismissNotice,
    encodingFlash,
    announcement,
    announce,
    selectDocument,
    pickFiles,
    importDropped,
    importText,
    start,
    pause,
    retranslate,
    confirmEncoding,
    removeDocument,
    reportError,
  };
  return <LongTextPageContext.Provider value={value}>{children}</LongTextPageContext.Provider>;
}
