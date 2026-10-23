import { useCallback, useEffect, useRef, useState } from 'react';
import type { LongTextChangeEvent } from '@/long-text/channels';
import {
  LONG_TEXT_LIMITS,
  type DocumentSummary,
  type ImportDefaults,
  type ImportResult,
  type ImportSkip,
  type LongTextFormat,
} from '@/long-text/contract';
import { LongTextClientError, unwrap } from '@/services/long-text/client';
import { resolveSelectedNativeFiles } from '@/utils/filePath';

export type ListState = 'loading' | 'ready' | 'failed';
export type ChangeListener = (event: LongTextChangeEvent) => void;

/** An import in progress. `names` are the dropped files; a picker import does not know them. */
export interface ImportProgress { names: string[] | null; done: number }

/** What an import leaves for the page: the document to open, how many are new, and what was not imported. */
export interface ImportOutcome {
  activate: string | null;
  imported: number;
  skipped: ImportSkip[];
  duplicates: string[];
}

const RELIST_DELAY_MS = 300;

/** Whether `a` is a strictly newer state of the same document than `b`. */
function newer(a: DocumentSummary, b: DocumentSummary): boolean {
  return a.revision > b.revision || (a.revision === b.revision && a.updatedAt > b.updatedAt);
}

/** Most recently updated first, as the main process lists them. */
export function sortDocuments(documents: readonly DocumentSummary[]): DocumentSummary[] {
  return [...documents].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The list with `summary` in it; an older copy never replaces a newer one. */
export function upsertSummary(documents: readonly DocumentSummary[], summary: DocumentSummary): DocumentSummary[] {
  const current = documents.find(item => item.id === summary.id);
  if (current && newer(current, summary)) return documents as DocumentSummary[];
  return sortDocuments([...documents.filter(item => item.id !== summary.id), summary]);
}

export function withoutDocument(documents: readonly DocumentSummary[], id: string): DocumentSummary[] {
  return documents.filter(item => item.id !== id);
}

/** The document that becomes current when `id` goes away: the next one in the list, else the previous one. */
export function nextActiveAfter(documents: readonly DocumentSummary[], id: string): string | null {
  const index = documents.findIndex(item => item.id === id);
  if (index < 0) return documents[0]?.id ?? null;
  return documents[index + 1]?.id ?? documents[index - 1]?.id ?? null;
}

/** The remembered document when it still exists, otherwise the most recently updated one. */
export function resolveActive(documents: readonly DocumentSummary[], remembered: string | null): string | null {
  return remembered && documents.some(item => item.id === remembered) ? remembered : documents[0]?.id ?? null;
}

export function isTranslating(summary: Pick<DocumentSummary, 'run'> | null | undefined): boolean {
  return summary?.run?.status === 'running' || summary?.run?.status === 'pausing';
}

/** The first new document opens; without one, the first file already in the list does. */
export function importOutcome(result: ImportResult): ImportOutcome {
  return {
    activate: result.documents[0]?.id ?? result.duplicates[0]?.documentId ?? null,
    imported: result.documents.length,
    skipped: result.skipped,
    duplicates: result.duplicates.map(item => item.name),
  };
}

/** A summary carried by a change event, when it is one for `documentId`. */
function eventSummary(event: LongTextChangeEvent): DocumentSummary | null {
  const summary = event.summary as Partial<DocumentSummary> | undefined;
  return summary && typeof summary === 'object' && summary.id === event.documentId && typeof summary.revision === 'number'
    ? summary as DocumentSummary : null;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * The document list of the page: the first `list`, change events (handled in sequence order and
 * relayed to `subscribe` listeners) and the three ways to import.
 */
export function useDocuments(defaults: () => ImportDefaults) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [storageBytes, setStorageBytes] = useState(0);
  const [listState, setListState] = useState<ListState>('loading');
  const [importing, setImporting] = useState<ImportProgress | null>(null);
  const known = useRef(new Set<string>());
  const sequence = useRef(0);
  const listeners = useRef(new Set<ChangeListener>());
  const relistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const busy = useRef(false);
  const mounted = useRef(true);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  const reload = useCallback(async () => {
    try {
      const value = await unwrap(window.longText.list());
      if (!mounted.current) return;
      known.current = new Set(value.documents.map(item => item.id));
      setDocuments(sortDocuments(value.documents));
      setStorageBytes(value.storageBytes);
      setListState('ready');
    } catch {
      if (mounted.current) setListState(state => state === 'ready' ? state : 'failed');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.longText.onChanged(event => {
      if (event.sequence <= sequence.current) return;
      sequence.current = event.sequence;
      const summary = eventSummary(event);
      if (event.kind === 'deleted' && event.documentId) {
        const id = event.documentId;
        known.current.delete(id);
        setDocuments(list => withoutDocument(list, id));
      } else if (summary) {
        if (event.kind === 'list' && !known.current.has(summary.id)) {
          known.current.add(summary.id);
          setImporting(progress => progress && { ...progress, done: progress.done + 1 });
        }
        setDocuments(list => upsertSummary(list, summary));
      }
      // Storage use is not part of the events; read it again after list changes.
      if (event.kind === 'list' || event.kind === 'deleted') {
        clearTimeout(relistTimer.current);
        relistTimer.current = setTimeout(() => void reload(), RELIST_DELAY_MS);
      }
      for (const listener of listeners.current) listener(event);
    });
    void reload();
    return () => {
      mounted.current = false;
      clearTimeout(relistTimer.current);
      unsubscribe();
    };
  }, [reload]);

  const subscribe = useCallback((listener: ChangeListener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  /** Puts results of commands into the list right away; the matching events may come later. */
  const accept = useCallback((summaries: readonly DocumentSummary[]) => {
    for (const summary of summaries) known.current.add(summary.id);
    setDocuments(list => summaries.reduce(upsertSummary, list));
  }, []);

  const drop = useCallback((id: string) => {
    known.current.delete(id);
    setDocuments(list => withoutDocument(list, id));
  }, []);

  /** One import at a time; `null` when another one is still running. */
  const exclusive = useCallback(async <T>(progress: ImportProgress, task: () => Promise<T>): Promise<T | null> => {
    if (busy.current) return null;
    busy.current = true;
    setImporting(progress);
    try {
      return await task();
    } finally {
      busy.current = false;
      if (mounted.current) setImporting(null);
    }
  }, []);

  const finish = useCallback((result: ImportResult): ImportOutcome => {
    accept(result.documents);
    return importOutcome(result);
  }, [accept]);

  /** The native file dialog in the main process, then the import of what was chosen. */
  const pickFiles = useCallback((filterName: string) => exclusive({ names: null, done: 0 }, async () =>
    finish(await unwrap(window.longText.pickFiles({ filterName, defaults: defaultsRef.current() })))), [exclusive, finish]);

  /**
   * Imports dropped files. The native paths are captured synchronously, inside the drop event that
   * calls this (FK-PIT-0148); only then does anything wait.
   */
  const importDropped = useCallback((files: readonly File[]) => {
    if (busy.current) return Promise.resolve(null);
    const captured = resolveSelectedNativeFiles(files, 'drop')
      .then(value => ({ ok: true as const, value }), failure => ({ ok: false as const, failure }));
    const names = files.slice(0, LONG_TEXT_LIMITS.importPaths).map(file => file.name);
    return exclusive({ names, done: 0 }, async () => {
      const selection = await captured;
      if (!selection.ok || !selection.value.ok) throw new LongTextClientError('file_unreadable');
      const paths = selection.value.data.map(file => file.filePath);
      const result = await unwrap(window.longText.importFiles({
        paths: paths.slice(0, LONG_TEXT_LIMITS.importPaths), source: 'drop', defaults: defaultsRef.current(),
      }));
      for (const path of paths.slice(LONG_TEXT_LIMITS.importPaths)) result.skipped.push({ name: baseName(path), reason: 'limit_exceeded' });
      return finish(result);
    });
  }, [exclusive, finish]);

  const importText = useCallback((name: string, text: string, format: LongTextFormat) => exclusive({ names: [name], done: 0 }, async () => {
    const summary = await unwrap(window.longText.importText({ name, text, format, defaults: defaultsRef.current() }));
    accept([summary]);
    return summary;
  }), [exclusive, accept]);

  return { documents, storageBytes, listState, importing, reload, subscribe, accept, drop, pickFiles, importDropped, importText };
}
