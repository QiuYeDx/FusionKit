import type { BrowserWindow, Clipboard, Dialog, OpenDialogOptions, Shell } from 'electron';
import path from 'node:path';
import type { LongTextChangeEvent } from '../../../src/long-text/channels';
import {
  LONG_TEXT_LIMITS, SEGMENT_KINDS,
  type DocumentSummary, type LongTextRequest, type LongTextSettings, type LongTextValues, type SegmentRow,
} from '../../../src/long-text/contract';
import { project } from '../../../src/long-text/inline';
import type { Flag } from '../../../src/long-text/model';
import { checkUserEdit } from '../../../src/long-text/quality';
import { LoadedDocument, settingsDigest } from './document-state';
import { previewLines } from './encoding';
import { LongTextExporter } from './exporter';
import { IMPORT_EXTENSIONS, LongTextImporter } from './importer';
import type { LongTextHandlers } from './ipc';
import { selectionForLanguages, type ReadKnowledge } from './knowledge';
import { DocumentLedger } from './ledger';
import { emptyObserved, estimateDocument, type ObservedTotals } from './planner';
import { effectiveLanguages, LongTextOperationError, unavailableSummary, type LongTextRepository } from './repository';
import { RequestPool } from './request-pool';
import { LENGTH_RATIOS, retranslate as retranslateSegment, Run, type RunHooks, type RunnerServices, type RunnerTarget, type SendText } from './runner';

/**
 * The commands of the long text translator (design §5.3) on top of the repository, the importer, runs
 * and the exporter. At most three documents stay loaded (least recently used first out); a document with
 * a run, a retranslation or a command in progress is never unloaded, so one document never has two
 * in-memory copies. Commands that change a document run one after another per document. Change events
 * carry a global sequence number; `segments` events of a document are merged over 120 ms.
 */

export interface LongTextServiceOptions {
  repository: LongTextRepository;
  readKnowledge: ReadKnowledge;
  send: SendText;
  /** Delivers a change event to the renderer. */
  emit: (event: LongTextChangeEvent) => void;
  dialog: Pick<Dialog, 'showOpenDialog'>;
  clipboard: Pick<Clipboard, 'writeText'>;
  shell: Pick<Shell, 'showItemInFolder'>;
  /** `app`: the Documents folder is the export folder until one is chosen. */
  paths: { getPath(name: 'documents'): string };
  /** The window native dialogs belong to. */
  getWindow?: () => BrowserWindow | null;
  /** Global request slots; shared by every document. */
  pool?: RequestPool;
  now?: () => number;
}

interface Entry {
  readonly id: string;
  readonly document: LoadedDocument;
  readonly target: RunnerTarget;
  run: Run | null;
  /** A run is being validated and set up. */
  starting: boolean;
  /** Translations are being cleared; a retranslation must not slip in. */
  clearing: boolean;
  /** Retranslations in progress, by the controller that aborts them. */
  readonly retranslations: Map<AbortController, Promise<unknown>>;
}

interface PendingSegments {
  start: number;
  end: number;
  /** Null once more than 64 pages changed (the event then carries the range only). */
  pages: Set<number> | null;
  timer: ReturnType<typeof setTimeout>;
}

const SEGMENT_EVENT_DELAY_MS = 120;
const EVENT_PAGES = 64;
const BOM = '\uFEFF';

const notFound = () => new LongTextOperationError('not_found');
const hasTranslations = (summary: Pick<DocumentSummary, 'counts'>) => summary.counts.done + summary.counts.failed > 0;

export class LongTextService implements LongTextHandlers {
  private readonly repository: LongTextRepository;
  private readonly importer: LongTextImporter;
  private readonly exporter: LongTextExporter;
  private readonly runner: RunnerServices;
  private readonly now: () => number;

  /** Every listed document; loaded ones are refreshed from memory whenever they are read. */
  private readonly summaries = new Map<string, DocumentSummary>();
  /** Loaded documents, least recently used first. */
  private readonly loaded = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<Entry>>();
  /** Commands holding a document: it stays loaded until they finish. */
  private readonly holds = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly removing = new Set<string>();
  /** Measured usage per document for the estimate; kept while the app runs, across unloading. */
  private readonly observed = new Map<string, ObservedTotals>();
  private readonly segmentEvents = new Map<string, PendingSegments>();
  private readonly background = new Set<Promise<unknown>>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly options: LongTextServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.runner = { send: options.send, pool: options.pool ?? new RequestPool(), readKnowledge: options.readKnowledge, now: this.now };
    this.importer = new LongTextImporter({
      repository: this.repository,
      documents: () => [...this.summaries.values()],
      readKnowledge: options.readKnowledge,
      onCreated: summary => {
        this.summaries.set(summary.id, summary);
        this.listChanged(summary.id, summary);
      },
      now: this.now,
    });
    this.exporter = new LongTextExporter({
      paths: options.paths, dialog: options.dialog, clipboard: options.clipboard, shell: options.shell,
      getWindow: options.getWindow, now: this.now,
    });
  }

  /** Startup: recovers the folder and reads the list; runs a previous session left running become interrupted. */
  async ready(): Promise<void> {
    for (const summary of await this.repository.recover()) this.summaries.set(summary.id, summary);
  }

  // Library and import.

  async list(): Promise<LongTextValues['list']> {
    // Size first: an event sent during the walk is then already in the list the reply carries, and
    // nothing can be sent between the snapshot and the reply, so the renderer never rolls one back.
    const storageBytes = await this.repository.storageBytes();
    return { documents: this.listed(), storageBytes };
  }

  /** The native file dialog, then an import of what was chosen (at most 50 files; the rest are skipped). */
  async pickFiles({ filterName, defaults }: LongTextRequest<'pickFiles'>): Promise<LongTextValues['pickFiles']> {
    const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'], filters: [{ name: filterName, extensions: [...IMPORT_EXTENSIONS] }] };
    const window = this.options.getWindow?.();
    const { dialog } = this.options;
    const selection = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths.length) return { documents: [], duplicates: [], skipped: [] };
    const result = await this.importer.importFiles(selection.filePaths.slice(0, LONG_TEXT_LIMITS.importPaths), defaults);
    for (const file of selection.filePaths.slice(LONG_TEXT_LIMITS.importPaths)) result.skipped.push({ name: path.basename(file), reason: 'limit_exceeded' });
    return result;
  }

  importFiles({ paths, defaults }: LongTextRequest<'importFiles'>): Promise<LongTextValues['importFiles']> {
    return this.importer.importFiles(paths, defaults);
  }

  /** A leading BOM is dropped: it is not text, and S must match what `source.txt` decodes to. */
  importText({ name, text, format, defaults }: LongTextRequest<'importText'>): Promise<LongTextValues['importText']> {
    return this.importer.importText(name, text.startsWith(BOM) ? text.slice(BOM.length) : text, format, defaults);
  }

  // Reads.

  read({ documentId }: LongTextRequest<'read'>): Promise<LongTextValues['read']> {
    return this.use(documentId, entry => entry.document.detail());
  }

  readPage({ documentId, page }: LongTextRequest<'readPage'>): Promise<LongTextValues['readPage']> {
    return this.use(documentId, entry => entry.document.readPage(page));
  }

  query({ documentId, filter, offset, limit }: LongTextRequest<'query'>): Promise<LongTextValues['query']> {
    return this.use(documentId, entry => entry.document.query(filter, offset, limit));
  }

  locate({ documentId, from, direction }: LongTextRequest<'locate'>): Promise<LongTextValues['locate']> {
    return this.use(documentId, entry => entry.document.locate(from, direction));
  }

  /** The output limit is kept within half the context window, as a run's model is (`modelSchema`). */
  estimate({ documentId, scope, contextWindow, maxOutputTokens }: LongTextRequest<'estimate'>): Promise<LongTextValues['estimate']> {
    return this.use(documentId, entry =>
      estimateDocument(entry.document, scope, Math.min(maxOutputTokens, Math.floor(contextWindow / 2)), this.observedOf(documentId)));
  }

  async previewEncoding({ documentId, encoding }: LongTextRequest<'previewEncoding'>): Promise<LongTextValues['previewEncoding']> {
    if (this.known(documentId).source.kind !== 'file') throw new LongTextOperationError('invalid_request');
    const bytes = await this.repository.withDocument(documentId, files => files.readOriginal());
    if (!bytes) throw new LongTextOperationError('source_missing');
    return previewLines(bytes, encoding);
  }

  readLedger({ documentId }: LongTextRequest<'readLedger'>): Promise<LongTextValues['readLedger']> {
    return this.use(documentId, entry => ({ entries: entry.document.ledger.map(item => ({ ...item })) }));
  }

  // Settings and structure.

  /**
   * Saves the settings when `expectedRevision` is current (`conflict` otherwise). The materials take the
   * document's effective languages. A change of the effective languages is refused while the document is
   * being translated (`busy`) and, when translations exist, unless `clearTranslations` clears all of
   * them, locked ones included (`translations_exist`).
   */
  updateSettings({ documentId, expectedRevision, settings, clearTranslations }: LongTextRequest<'updateSettings'>): Promise<LongTextValues['updateSettings']> {
    return this.mutate(documentId, async entry => {
      const { document } = entry;
      const { manifest } = document;
      if (manifest.revision !== expectedRevision) throw new LongTextOperationError('conflict');
      const before = effectiveLanguages(manifest);
      const after = effectiveLanguages({ settings, detected: manifest.detected });
      if (after.source === after.target) throw new LongTextOperationError('same_language');
      const languageChanged = before.source !== after.source || before.target !== after.target;
      if (languageChanged && this.active(entry)) throw new LongTextOperationError('busy');
      if (languageChanged && hasTranslations(document.summary()) && !clearTranslations) throw new LongTextOperationError('translations_exist');
      const next: LongTextSettings = { ...settings, knowledge: selectionForLanguages(settings.knowledge, after) };
      if (languageChanged) await this.clearTranslations(entry, false);
      await document.updateManifest(draft => {
        draft.settings = next;
      }, { bump: true, immediate: true });
      this.documentChanged(documentId);
      return document.detail();
    });
  }

  confirmEncoding({ documentId }: LongTextRequest<'confirmEncoding'>): Promise<LongTextValues['confirmEncoding']> {
    return this.mutate(documentId, async entry => {
      const { document } = entry;
      if (!document.manifest.encoding) throw new LongTextOperationError('invalid_request');
      if (!document.manifest.encoding.confirmed) {
        await document.updateManifest(draft => {
          if (draft.encoding) draft.encoding.confirmed = true;
        }, { immediate: true });
        this.documentChanged(documentId);
      }
      return document.detail();
    });
  }

  /**
   * Decodes the imported bytes again and/or segments again (design §2 F4, R-LT-04/05). Refused while
   * the document is being translated, and, when translations exist, unless `discardTranslations`. The
   * loaded copy is closed first; requests arriving meanwhile wait for the new one.
   */
  resegment({ documentId: id, encoding, txtSplit, discardTranslations }: LongTextRequest<'resegment'>): Promise<LongTextValues['resegment']> {
    return this.mutate(id, async entry => {
      const { document } = entry;
      if (this.active(entry)) throw new LongTextOperationError('busy');
      if (encoding && !document.manifest.encoding) throw new LongTextOperationError('invalid_request');
      if (hasTranslations(document.summary()) && !discardTranslations) throw new LongTextOperationError('translations_exist');
      // Pending segment ranges refer to the old segmentation; the document event below makes readers start over.
      this.dropSegments(id);
      this.loaded.delete(id);
      const replaced = this.close(entry)
        .then(() => this.importer.resegment(document, { encoding, txtSplit }))
        .then(() => {
          this.observed.delete(id);
        });
      // Loaded again either way: the new segmentation, or the old one when replacing it failed.
      const next = await this.reopen(id, () => replaced.catch(() => undefined));
      await replaced;
      this.documentChanged(id);
      this.listChanged(id, this.summaryOf(id));
      return next.document.detail();
    });
  }

  // Runs.

  /**
   * Starts a run (§6.8.1). One run per document (`busy`); a low-confidence encoding must be confirmed
   * first (`encoding_unconfirmed`). The run itself checks the model, the languages and the materials.
   */
  start(request: LongTextRequest<'start'>): Promise<LongTextValues['start']> {
    const id = request.documentId;
    return this.mutate(id, async entry => {
      if (this.running(entry)) throw new LongTextOperationError('busy');
      const { document } = entry;
      const { encoding, sample } = document.manifest;
      if (encoding && !encoding.confirmed) throw new LongTextOperationError('encoding_unconfirmed');
      const digest = settingsDigest(document.manifest);
      entry.starting = true;
      let run: Run;
      try {
        run = await Run.start(entry.target, {
          kind: request.kind, fromIndex: request.fromIndex,
          resample: request.resample ? sample?.indices ?? [] : null,
          model: request.model, apiKey: request.apiKey, settingsDigest: digest,
        }, this.runner, this.hooks(entry, digest));
      } finally {
        entry.starting = false;
      }
      entry.run = run;
      document.attachRun(() => run.view());
      this.documentChanged(id);
      void run.done.then(() => this.finished(entry, run));
      return { runId: run.id };
    });
  }

  /** Graceful or immediate; a document without a run reads as paused. */
  pause({ documentId, immediate }: LongTextRequest<'pause'>): Promise<LongTextValues['pause']> {
    return this.serial(documentId, async () => {
      this.known(documentId);
      const run = this.loaded.get(documentId)?.run;
      return { status: run ? run.pause(immediate) : 'paused' };
    });
  }

  /** Translates one segment again (§6.9.6); it may run beside a run of the same document. */
  retranslate({ documentId, index, rev, instruction, model, apiKey }: LongTextRequest<'retranslate'>): Promise<LongTextValues['retranslate']> {
    return this.use(documentId, async entry => {
      if (entry.clearing) throw new LongTextOperationError('busy');
      const controller = new AbortController();
      const job = retranslateSegment(entry.target, { index, rev, instruction, model, apiKey }, this.runner, controller.signal);
      entry.retranslations.set(controller, job);
      try {
        await job;
      } finally {
        entry.retranslations.delete(controller);
      }
      return entry.document.row(index);
    });
  }

  // Single segments.

  /** Saves the user's translation; Markdown edits are checked for markup they dropped (`markup_missing`). */
  edit({ documentId, index, rev, text }: LongTextRequest<'edit'>): Promise<LongTextValues['edit']> {
    return this.changeSegment(documentId, index, document => {
      if (!document.isTranslatable(index)) throw new LongTextOperationError('invalid_request');
      const kind = SEGMENT_KINDS[document.table.kind[index]];
      const { marks } = project(document.displayAt(index), kind, document.format, { refs: document.refs });
      const flags: Flag[] = checkUserEdit({ target: text, marks, format: document.format }).map(flag => ({ ...flag, dismissed: false }));
      return document.edit(index, rev, text, flags);
    });
  }

  setLocked({ documentId, index, rev, locked }: LongTextRequest<'setLocked'>): Promise<LongTextValues['setLocked']> {
    return this.changeSegment(documentId, index, document => document.setLocked(index, rev, locked));
  }

  undo({ documentId, index, rev }: LongTextRequest<'undo'>): Promise<LongTextValues['undo']> {
    return this.changeSegment(documentId, index, document => document.undo(index, rev));
  }

  dismissFlag({ documentId, index, rev, code }: LongTextRequest<'dismissFlag'>): Promise<LongTextValues['dismissFlag']> {
    return this.changeSegment(documentId, index, document => document.dismissFlag(index, rev, code));
  }

  /** Clears every translation (locked ones too unless `keepLocked`); refused while the document is being translated. */
  clear({ documentId, keepLocked }: LongTextRequest<'clear'>): Promise<LongTextValues['clear']> {
    return this.mutate(documentId, async entry => {
      if (this.active(entry)) throw new LongTextOperationError('busy');
      const changed = await this.clearTranslations(entry, keepLocked);
      this.documentChanged(documentId);
      return { changed };
    });
  }

  updateLedger({ documentId, upserts, deletes }: LongTextRequest<'updateLedger'>): Promise<LongTextValues['updateLedger']> {
    return this.mutate(documentId, async entry => {
      const entries = await entry.target.ledger.update(upserts, deletes);
      this.documentChanged(documentId);
      return { entries };
    });
  }

  // Export.

  /** Not queued with the document's commands: the native dialog may stay open for long. */
  chooseExportFolder({ documentId }: LongTextRequest<'chooseExportFolder'>): Promise<LongTextValues['chooseExportFolder']> {
    return this.use(documentId, async entry => {
      const chosen = await this.exporter.chooseFolder(entry.document);
      if (chosen) this.documentChanged(documentId);
      return chosen;
    });
  }

  export({ documentId, mode, destination }: LongTextRequest<'export'>): Promise<LongTextValues['export']> {
    return this.mutate(documentId, async entry => {
      const exported = await this.exporter.export(entry.document, mode, destination);
      this.documentChanged(documentId);
      return exported;
    });
  }

  copy({ documentId, mode }: LongTextRequest<'copy'>): Promise<LongTextValues['copy']> {
    return this.use(documentId, entry => this.exporter.copy(entry.document, mode));
  }

  reveal({ documentId, target }: LongTextRequest<'reveal'>): Promise<LongTextValues['reveal']> {
    return this.use(documentId, entry => this.exporter.reveal(entry.document, target));
  }

  // Lifecycle of documents.

  rename({ documentId, name }: LongTextRequest<'rename'>): Promise<LongTextValues['rename']> {
    return this.mutate(documentId, async entry => {
      await entry.document.updateManifest(draft => {
        draft.name = name;
      }, { immediate: true });
      const summary = this.summaryOf(documentId);
      this.listChanged(documentId, summary);
      return summary;
    });
  }

  /** Stops the document's run and retranslations, waits for them, then deletes its folder. */
  remove({ documentId: id }: LongTextRequest<'remove'>): Promise<LongTextValues['remove']> {
    return this.serial(id, async () => {
      this.known(id);
      this.removing.add(id);
      try {
        await this.opening.get(id)?.catch(() => undefined);
        const entry = this.loaded.get(id);
        if (entry) {
          entry.run?.pause(true);
          for (const controller of entry.retranslations.keys()) controller.abort();
          await Promise.allSettled([entry.run?.done, ...entry.retranslations.values()]);
          this.loaded.delete(id);
          await this.close(entry);
        }
        await this.repository.remove(id);
      } finally {
        this.removing.delete(id);
      }
      this.dropSegments(id);
      this.summaries.delete(id);
      this.observed.delete(id);
      this.send({ kind: 'deleted', documentId: id });
      this.listChanged(id);
      return {};
    });
  }

  /**
   * Before quitting (synchronous): aborts every run and retranslation, stops the event and index timers
   * and writes pending manifest changes. Runs keep the status they had on disk, which startup turns into
   * `interrupted`; the documents are closed in the background.
   */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.segmentEvents.values()) clearTimeout(pending.timer);
    this.segmentEvents.clear();
    const entries = [...this.loaded.values()];
    for (const entry of entries) {
      entry.run?.pause(true);
      for (const controller of entry.retranslations.keys()) controller.abort();
      entry.document.flushManifestSync();
    }
    this.repository.dispose();
    this.track(Promise.allSettled(entries.flatMap(entry => [entry.run?.done, ...entry.retranslations.values()]))
      .then(() => Promise.all(entries.map(entry => this.close(entry)))));
  }

  /** Resolves once queued commands, background closes and every queued write have settled. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.queues.values(), ...this.opening.values(), ...this.background]);
    await this.repository.idle();
  }

  // Loading and unloading.

  /** Runs `task` with the loaded document, which stays loaded until the task settles. */
  private async use<T>(id: string, task: (entry: Entry) => T | Promise<T>): Promise<T> {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    try {
      let entry = await this.entry(id);
      // A resegmentation may have replaced the copy meanwhile, or a removal begun; `task` starts in this
      // same turn, so what it registers synchronously (a retranslation) is seen by both.
      while (this.removing.has(id) || this.loaded.get(id) !== entry) entry = await this.entry(id);
      return await task(entry);
    } finally {
      const holds = (this.holds.get(id) ?? 1) - 1;
      if (holds > 0) this.holds.set(id, holds);
      else this.holds.delete(id);
      this.trim();
    }
  }

  /** Commands that change a document run one after another. */
  private mutate<T>(id: string, task: (entry: Entry) => Promise<T>): Promise<T> {
    return this.serial(id, () => this.use(id, task));
  }

  private serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return result;
  }

  private entry(id: string): Promise<Entry> {
    const summary = this.removing.has(id) ? undefined : this.summaries.get(id);
    if (!summary) return Promise.reject(notFound());
    const loaded = this.loaded.get(id);
    if (loaded) {
      this.loaded.delete(id);
      this.loaded.set(id, loaded);
      return Promise.resolve(loaded);
    }
    const opening = this.opening.get(id);
    if (opening) return opening;
    if (summary.unavailable) return Promise.reject(new LongTextOperationError('unavailable'));
    return this.reopen(id, async () => undefined);
  }

  /** Runs `before`, then loads the document; requests for it wait for the result meanwhile. */
  private reopen(id: string, before: () => Promise<void>): Promise<Entry> {
    const pending = before().then(() => this.open(id));
    this.opening.set(id, pending);
    const forget = () => {
      if (this.opening.get(id) === pending) this.opening.delete(id);
    };
    pending.then(forget, forget);
    return pending;
  }

  private async open(id: string): Promise<Entry> {
    const opened = await LoadedDocument.open(this.repository, id, { ratio: LENGTH_RATIOS, onSegments: range => this.queueSegments(id, range), now: this.now });
    if ('unavailable' in opened) {
      const summary = unavailableSummary(id, opened.unavailable, this.summaries.get(id), opened.name, this.now());
      this.summaries.set(id, summary);
      this.listChanged(id, summary);
      throw new LongTextOperationError('unavailable');
    }
    const entry: Entry = {
      id, document: opened,
      target: { document: opened, ledger: new DocumentLedger(opened, { now: this.now }), observed: this.observedOf(id) },
      run: null, starting: false, clearing: false, retranslations: new Map(),
    };
    this.loaded.set(id, entry);
    this.summaries.set(id, opened.summary());
    return entry;
  }

  /** Writes what the document and its glossary still hold and waits for the document's queued writes. */
  private close(entry: Entry): Promise<void> {
    // Both calls queue their writes at once, ahead of anything a later load of the document queues.
    const ledger = entry.target.ledger.flush().catch(error => console.warn('[long-text] Could not save the glossary', error));
    const document = entry.document.close().catch(error => console.warn('[long-text] Could not save the document', error));
    return Promise.all([ledger, document]).then(() => undefined);
  }

  /** Unloads the least recently used documents beyond three that nothing holds. */
  private trim(): void {
    if (this.closed) return;
    for (const [id, entry] of this.loaded) {
      if (this.loaded.size <= LONG_TEXT_LIMITS.loadedDocuments) return;
      if (this.pinned(entry)) continue;
      this.loaded.delete(id);
      this.summaries.set(id, entry.document.summary());
      this.track(this.close(entry));
    }
  }

  /** A run stays pinned until it has settled completely, after its final status is already visible. */
  private pinned(entry: Entry): boolean {
    return entry.run !== null || this.active(entry) || entry.clearing || this.holds.has(entry.id);
  }

  /** The document is being translated: a run is starting, running or pausing. */
  private running(entry: Entry): boolean {
    const status = entry.run?.view().status;
    return entry.starting || status === 'running' || status === 'pausing';
  }

  /** A run or a retranslation is in progress. */
  private active(entry: Entry): boolean {
    return this.running(entry) || entry.retranslations.size > 0;
  }

  private track(promise: Promise<unknown>): void {
    this.background.add(promise);
    const forget = () => this.background.delete(promise);
    promise.then(forget, forget);
  }

  // Helpers of the commands.

  private known(id: string): DocumentSummary {
    const summary = this.removing.has(id) ? undefined : this.summaries.get(id);
    if (!summary) throw notFound();
    return summary;
  }

  private observedOf(id: string): ObservedTotals {
    let observed = this.observed.get(id);
    if (!observed) this.observed.set(id, observed = emptyObserved());
    return observed;
  }

  private changeSegment(id: string, index: number, change: (document: LoadedDocument) => Promise<SegmentRow>): Promise<SegmentRow> {
    return this.mutate(id, async entry => {
      const row = await change(entry.document);
      entry.document.emit({ start: index, end: index });
      return row;
    });
  }

  /**
   * Clears translations in one write; the document reads as never translated again (no full run
   * started, no sample), so the primary button offers a fresh full translation.
   */
  private async clearTranslations(entry: Entry, keepLocked: boolean): Promise<number> {
    const { document } = entry;
    entry.clearing = true;
    try {
      const changed = await document.clearAll(keepLocked);
      await document.updateManifest(draft => {
        draft.fullRunStarted = false;
        draft.sample = null;
      }, { immediate: true });
      if (changed.length) document.emit({ start: Math.min(...changed), end: Math.max(...changed) });
      return changed.length;
    } finally {
      entry.clearing = false;
    }
  }

  private hooks(entry: Entry, digest: string): RunHooks {
    const { document } = entry;
    return {
      save: async (record, start) => {
        // After `dispose` the run record stays as it is on disk; startup marks it interrupted.
        if (this.closed) return;
        await document.updateManifest(draft => {
          const index = draft.runs.findIndex(run => run.id === record.id);
          if (index >= 0) draft.runs[index] = record;
          else draft.runs.unshift(record);
          if (start?.fullRunStarted) draft.fullRunStarted = true;
          if (start?.sample) draft.sample = { indices: start.sample, settingsDigest: digest, at: this.now() };
          // A failed status or finish write stays in memory and is saved again later; a failed start
          // leaves no phantom 'running' record (the run reports storage_failed).
        }, { immediate: true, keepOnFailure: !start });
      },
      changed: () => this.documentChanged(entry.id),
    };
  }

  private finished(entry: Entry, run: Run): void {
    if (entry.run !== run) return;
    entry.run = null;
    entry.document.attachRun(null);
    this.documentChanged(entry.id);
    this.trim();
  }

  // Change events.

  private summaryOf(id: string): DocumentSummary {
    const entry = this.loaded.get(id);
    if (!entry) return this.summaries.get(id)!;
    const summary = entry.document.summary();
    this.summaries.set(id, summary);
    return summary;
  }

  /** The list, most recently updated first. */
  private listed(): DocumentSummary[] {
    return [...this.summaries.keys()].map(id => this.summaryOf(id)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private send(event: Omit<LongTextChangeEvent, 'sequence'>): void {
    if (this.closed) return;
    this.options.emit({ sequence: ++this.sequence, ...event });
  }

  private scheduleIndex(): void {
    if (!this.closed) this.repository.scheduleIndex(() => this.listed());
  }

  private listChanged(id: string | null, summary?: DocumentSummary): void {
    this.send({ kind: 'list', documentId: id, ...(summary ? { summary } : {}) });
    this.scheduleIndex();
  }

  private documentChanged(id: string): void {
    if (this.removing.has(id) || !this.summaries.has(id)) return;
    const summary = this.summaryOf(id);
    this.send({ kind: 'document', documentId: id, revision: summary.revision, summary });
    this.scheduleIndex();
  }

  /** `segments` events of a document are merged over 120 ms: the union of the ranges, the pages they touch, the latest summary. */
  private queueSegments(id: string, range: { start: number; end: number }): void {
    if (this.closed) return;
    let pending = this.segmentEvents.get(id);
    if (pending) {
      pending.start = Math.min(pending.start, range.start);
      pending.end = Math.max(pending.end, range.end);
    } else {
      pending = { start: range.start, end: range.end, pages: new Set(), timer: setTimeout(() => this.flushSegments(id), SEGMENT_EVENT_DELAY_MS) };
      this.segmentEvents.set(id, pending);
    }
    const table = this.loaded.get(id)?.document.table;
    if (!table || range.start < 0 || range.end >= table.count) {
      pending.pages = null;
      return;
    }
    for (let page = table.page[range.start]; pending.pages && page <= table.page[range.end]; page++) {
      pending.pages.add(page);
      if (pending.pages.size > EVENT_PAGES) pending.pages = null;
    }
  }

  private dropSegments(id: string): void {
    const pending = this.segmentEvents.get(id);
    if (pending) clearTimeout(pending.timer);
    this.segmentEvents.delete(id);
  }

  private flushSegments(id: string): void {
    const pending = this.segmentEvents.get(id);
    this.segmentEvents.delete(id);
    if (!pending || this.removing.has(id) || !this.summaries.has(id)) return;
    const summary = this.summaryOf(id);
    this.send({
      kind: 'segments', documentId: id, revision: summary.revision,
      range: { start: pending.start, end: pending.end },
      ...(pending.pages ? { pages: [...pending.pages].sort((a, b) => a - b) } : {}),
      summary,
    });
  }
}
