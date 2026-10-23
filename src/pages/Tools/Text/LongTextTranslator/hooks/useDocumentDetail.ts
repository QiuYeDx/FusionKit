import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentDetail, DocumentSummary, Estimate, LongTextErrorCode, LongTextSettings } from '@/long-text/contract';
import { errorCodeOf, unwrap } from '@/services/long-text/client';
import { costRange, resolveRunModel, type RunModel } from '@/services/long-text/model';
import type { ModelProfile } from '@/type/model';
import { isTranslating, type ChangeListener } from './useDocuments';

export type DetailState =
  | { status: 'idle' | 'loading' | 'ready' }
  | { status: 'failed'; error: LongTextErrorCode };

/** The full-document estimate of the idle status line, with its cost range when the model has prices. */
export interface EstimateView { documentId: string; value: Estimate; cost: [number, number] | null }

/** `DocumentDetail.pages` and the other detail-only fields are read again at most once per second. */
const REFRESH_INTERVAL_MS = 1000;
const ESTIMATE_DELAY_MS = 300;
/** While the document is being translated the pending count changes every batch; estimate less often. */
const RUNNING_ESTIMATE_INTERVAL_MS = 5000;

/** The summary part of a detail, so the document list never keeps detail-only fields. */
export function toSummary(detail: DocumentDetail): DocumentSummary {
  const { id, revision, name, format, createdAt, updatedAt, source, encoding, languages, style, stats, counts, usage,
    fullRunStarted, run, lastExport, journalIssues, unavailable } = detail;
  return { id, revision, name, format, createdAt, updatedAt, source, encoding, languages, style, stats, counts, usage,
    fullRunStarted, run, lastExport, journalIssues, ...(unavailable ? { unavailable } : {}) };
}

/**
 * The detail with the latest summary of the same document laid over it: change events update counts,
 * the run and the header at once, while the detail-only fields follow with the next read. A summary
 * older than the detail (settings just saved) is ignored.
 */
export function mergeDetail(detail: DocumentDetail | null, summary: DocumentSummary | undefined): DocumentDetail | null {
  if (!detail || !summary || summary.id !== detail.id || summary.revision < detail.revision) return detail;
  return { ...detail, ...summary };
}

/** The key that decides when the estimate is outdated. */
export function estimateKey(detail: DocumentDetail | null, run: RunModel | null): string | null {
  if (!detail || !run) return null;
  return [detail.id, detail.revision, detail.counts.pending + detail.counts.failed, run.model.contextWindow, run.model.maxOutputTokens].join(':');
}

/**
 * The open document: its detail (kept on screen while another one loads, and cleared when the active
 * document cannot be shown, so nothing acts on a hidden one), refreshed after change events; the model
 * a run of it uses (`fallback` settings without a document); and the estimate of translating what is
 * left with that model.
 */
export function useDocumentDetail({ activeId, summary, subscribe, profiles, taskProfile, fallback }: {
  activeId: string | null;
  summary: DocumentSummary | undefined;
  subscribe: (listener: ChangeListener) => () => void;
  profiles: readonly ModelProfile[];
  taskProfile: ModelProfile | null;
  fallback: Pick<LongTextSettings, 'profileId' | 'maxOutputTokens'>;
}) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [state, setState] = useState<DetailState>({ status: 'idle' });
  const [estimate, setEstimate] = useState<EstimateView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(activeId);
  active.current = activeId;
  const refresh = useRef({ timer: undefined as ReturnType<typeof setTimeout> | undefined, inFlight: false, dirty: false, last: 0 });
  const unavailable = !!summary?.unavailable;

  useEffect(() => {
    const pending = refresh.current;
    clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.dirty = false;
    // An unavailable document has no detail: the previous one must not stay behind its card.
    if (!activeId || unavailable) {
      setDetail(null);
      setState({ status: 'idle' });
      return;
    }
    let current = true;
    setState({ status: 'loading' });
    unwrap(window.longText.read({ documentId: activeId })).then(value => {
      if (!current) return;
      refresh.current.last = Date.now();
      setDetail(value);
      setState({ status: 'ready' });
    }, (error: unknown) => {
      if (!current) return;
      // The failed card covers the region; notices, the assistant and commands must not see the previous document.
      setDetail(null);
      setState({ status: 'failed', error: errorCodeOf(error) });
    });
    return () => { current = false; };
  }, [activeId, unavailable, attempt]);

  const read = useCallback(() => {
    const pending = refresh.current;
    const id = active.current;
    pending.timer = undefined;
    if (!id) return;
    pending.inFlight = true;
    pending.last = Date.now();
    unwrap(window.longText.read({ documentId: id }))
      .then(value => { if (active.current === value.id) setDetail(value); }, () => undefined)
      .finally(() => {
        pending.inFlight = false;
        if (pending.dirty) { pending.dirty = false; schedule(); }
      });
  }, []);

  /** At most one read in flight and one per second; events meanwhile only mark the detail dirty. */
  const schedule = useCallback(() => {
    const pending = refresh.current;
    if (pending.inFlight) { pending.dirty = true; return; }
    if (pending.timer) return;
    pending.timer = setTimeout(read, Math.max(0, pending.last + REFRESH_INTERVAL_MS - Date.now()));
  }, [read]);

  useEffect(() => subscribe(event => {
    if (event.documentId !== active.current) return;
    if (event.kind === 'document' || event.kind === 'segments') schedule();
  }), [subscribe, schedule]);

  useEffect(() => () => clearTimeout(refresh.current.timer), []);

  const shown = mergeDetail(detail, summary);
  const settings = shown?.settings ?? fallback;
  const runModel = useMemo(() => resolveRunModel(settings, profiles, taskProfile), [settings, profiles, taskProfile]);
  const run = 'problem' in runModel ? null : runModel;
  const key = estimateKey(state.status === 'ready' ? shown : null, run);
  const translating = isTranslating(shown);
  const lastEstimate = useRef(0);
  const inputs = useRef({ shown, run });
  inputs.current = { shown, run };
  useEffect(() => {
    if (!key) return;
    const delay = translating
      ? Math.max(ESTIMATE_DELAY_MS, lastEstimate.current + RUNNING_ESTIMATE_INTERVAL_MS - Date.now())
      : ESTIMATE_DELAY_MS;
    const timer = setTimeout(() => {
      const { shown: doc, run: model } = inputs.current;
      if (!doc || !model) return;
      lastEstimate.current = Date.now();
      unwrap(window.longText.estimate({
        documentId: doc.id, scope: 'full', contextWindow: model.model.contextWindow, maxOutputTokens: model.model.maxOutputTokens,
      })).then(value => {
        if (active.current === doc.id) setEstimate({ documentId: doc.id, value, cost: costRange(value, model.profile.tokenPricing) });
      }, () => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [key, translating]);

  /** A detail returned by a command: shown at once, newer than whatever is on screen. */
  const applyDetail = useCallback((value: DocumentDetail) => {
    if (active.current === value.id) setDetail(value);
  }, []);

  return {
    detail: shown,
    state,
    runModel,
    estimate: estimate && shown && estimate.documentId === shown.id ? estimate : null,
    applyDetail,
    refresh: schedule,
    retry: useCallback(() => setAttempt(value => value + 1), []),
  };
}
