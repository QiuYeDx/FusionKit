import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { LIMITS, StudioError } from '../../../src/subtitle-studio/domain';
import { STUDIO_CHANNELS, requestSchemas, droppedSubtitlesRequestSchema, droppedTranscriptionMediaRequestSchema, transcriptionRequestSchemas, summarizeDocument, summarizeTask, type StudioResult } from '../../../src/subtitle-studio/ipc-contract';
import { DocumentRepository } from './document-repository';
import { readSubtitleWithSource } from './input-service';
import { resolveDroppedInputPaths, resolveDroppedSubtitlePaths, type SubtitleInputSelection } from './drop-input-service';
import { selectTranslationTasks } from './translation-overview';
import { SourceLocationService } from './source-location-service';
import { ExportService, publishSource, unusedOutputPath } from './export-service';
import { TranslationService } from './translation-service';
import { createAutomaticTranslationCoordinator } from './automatic-translation';
import { BilingualService } from './bilingual-service';
import { BatchService } from './batch-service';
import { selectLibrary } from './library-service';
import { STUDIO_BATCH_LIMIT, type BatchImportResult } from '../../../src/subtitle-studio/batch-contract';
import { createTranscriptionRuntime, type TranscriptionRuntime } from './transcription/runtime';
import { authorizeTranscriptionMedia, handleTranscriptionRequest, transcriptionIpcError } from './transcription-ipc';
import type { SpeechResourceService } from '../speech-resources/service';

export function registerSubtitleStudio(sharedResources?: SpeechResourceService) {
  const repository = new DocumentRepository(path.join(app.getPath('userData'), 'subtitle-studio', 'documents'));
  const translation = new TranslationService(repository);
  const automaticTranslation = createAutomaticTranslationCoordinator({ repository, translation });
  const bilingual = new BilingualService(repository);
  const exports = new ExportService(repository);
  const batches = new BatchService(repository, translation);
  const sources = new SourceLocationService(repository);
  const owners = new Map<number, { sender: WebContents; capability: string; documents: Set<string>; unavailable: Map<string, string> }>();
  const allowed = new Set<number>();
  let runtime: TranscriptionRuntime | undefined;
  let closed = false;
  let shutdown: Promise<void> | undefined;
  const retirements = new Set<Promise<void>>();
  let retirementFailures: unknown[] = [];
  async function ensureRuntime() {
    if (closed) throw new StudioError('access_denied');
    runtime ??= createTranscriptionRuntime({ userDataRoot: app.getPath('userData'), environment: app.isPackaged
      ? { mode: 'packaged', resourcesPath: process.resourcesPath }
      : { mode: 'development', appRoot: app.getAppPath() } }, { sharedResources, automaticTranslation }, repository);
    await runtime.initialize();
    if (closed) throw new StudioError('access_denied');
    return runtime;
  }
  function forgetOwner(id: number) {
    const owner = owners.get(id);
    owners.delete(id);
    for (const service of [translation, exports, batches]) {
      try { service.forgetOwner(id); } catch (error) { retirementFailures.push(error); }
    }
    if (!owner || !runtime) return;
    try {
      // releaseOwner fences synchronously, while its Promise retains asynchronous cleanup.
      const pending = runtime.releaseOwner({ webContentsId: id, ownerSessionId: owner.capability });
      retirements.add(pending);
      void pending.then(() => { retirements.delete(pending); }, error => { retirements.delete(pending); retirementFailures.push(error); });
    } catch (error) { retirementFailures.push(error); }
  }
  const rendererUrl = process.env.VITE_DEV_SERVER_URL || pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href;
  const trusted = (url: string) => {
    try { const target = new URL(url); target.hash = ''; const expected = new URL(rendererUrl); expected.hash = ''; return target.href === expected.href; }
    catch { return false; }
  };
  const unsubscribe = repository.subscribe(event => {
    for (const owner of owners.values()) {
      if (!owner.sender.isDestroyed() && trusted(owner.sender.mainFrame.url)) {
        owner.sender.send(STUDIO_CHANNELS.changed, { capability: owner.capability, event });
        if (event.deleted) owner.documents.delete(event.documentId);
      }
    }
  });
  const envelope = z.object({ capability: z.string().uuid(), payload: z.unknown() }).strict();
  ipcMain.on(STUDIO_CHANNELS.register, (event, request) => {
    if (closed || !allowed.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url) || !z.object({}).strict().safeParse(request).success) { event.returnValue = null; return; }
    const owner = { sender: event.sender, capability: randomUUID(), documents: new Set<string>(), unavailable: new Map<string, string>() };
    forgetOwner(event.sender.id);
    owners.set(event.sender.id, owner);
    event.returnValue = owner.capability;
  });

  function ownerFor(event: IpcMainInvokeEvent, input: unknown) {
    const parsed = envelope.safeParse(input);
    const owner = owners.get(event.sender.id);
    if (closed || !parsed.success || !owner || owner.sender !== event.sender || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url) || owner.capability !== parsed.data.capability) throw new StudioError('access_denied');
    return { owner, payload: parsed.data.payload };
  }
  async function importSelections(selections: readonly SubtitleInputSelection[], encoding: z.infer<typeof requestSchemas.importSubtitles>['encoding'], owner: { documents: Set<string> }, alive: () => void): Promise<BatchImportResult> {
    if (selections.length > STUDIO_BATCH_LIMIT) throw new StudioError('limit_exceeded');
    const value: BatchImportResult = { items: [] };
    const seen = new Set<string>();
    for (const selection of selections) {
      alive();
      if (selection.path === undefined) { value.items.push({ fileName: selection.fileName, ok: false, error: selection.error }); continue; }
      const identity = path.resolve(selection.path);
      const key = process.platform === 'win32' ? identity.toLocaleLowerCase('en-US') : identity;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const { document, sourceLocation } = await readSubtitleWithSource(identity, encoding); alive();
        await repository.create(document, alive, sourceLocation); alive(); owner.documents.add(document.id);
        value.items.push({ fileName: document.origin.displayName, ok: true, document: summarizeDocument(document) });
      } catch (error) { alive(); value.items.push({ fileName: selection.fileName, ok: false, error: error instanceof StudioError ? error.code : 'document_unavailable' }); }
    }
    return value;
  }
  ipcMain.handle(STUDIO_CHANNELS.importDroppedSubtitles, async (event, input): Promise<StudioResult<unknown>> => {
    try {
      const { owner, payload } = ownerFor(event, input);
      const parsed = droppedSubtitlesRequestSchema.safeParse(payload);
      if (!parsed.success) throw new StudioError('invalid_input');
      const alive = () => { if (closed || owners.get(event.sender.id) !== owner || event.sender.isDestroyed() || !trusted(event.sender.mainFrame.url)) throw new StudioError('access_denied'); };
      await translation.initialize(); alive();
      const selections = await resolveDroppedSubtitlePaths(parsed.data.paths); alive();
      return { ok: true, value: await importSelections(selections, parsed.data.encoding, owner, alive) };
    } catch (error) { return { ok: false, error: error instanceof StudioError ? error.code : 'document_unavailable' }; }
  });
  ipcMain.handle(STUDIO_CHANNELS.dropTranscriptionMedia, async (event, input): Promise<StudioResult<unknown>> => {
    try {
      const { owner, payload } = ownerFor(event, input);
      const parsed = droppedTranscriptionMediaRequestSchema.safeParse(payload);
      if (!parsed.success) throw new StudioError('invalid_input');
      const alive = () => { if (closed || owners.get(event.sender.id) !== owner || event.sender.isDestroyed() || !trusted(event.sender.mainFrame.url)) throw new StudioError('access_denied'); };
      const selections = await resolveDroppedInputPaths(parsed.data.paths); alive();
      const current = await ensureRuntime(); alive();
      const value = await authorizeTranscriptionMedia(selections, current, { webContentsId: event.sender.id, ownerSessionId: owner.capability }, alive);
      alive();
      return { ok: true, value };
    } catch (error) { return { ok: false, error: transcriptionIpcError(error) }; }
  });
  for (const method of Object.keys(requestSchemas) as (keyof typeof requestSchemas)[]) {
    ipcMain.handle(STUDIO_CHANNELS[method], async (event, input): Promise<StudioResult<unknown>> => {
      try {
        const { owner, payload } = ownerFor(event, input);
        const parsed = requestSchemas[method].safeParse(payload);
        if (!parsed.success) throw new StudioError('invalid_input');
        const alive = () => { if (closed || owners.get(event.sender.id) !== owner || event.sender.isDestroyed() || !trusted(event.sender.mainFrame.url)) throw new StudioError('access_denied'); };
        if (method === 'revealSource') {
          const request = requestSchemas.revealSource.parse(payload);
          if (request.kind === 'transcription') {
            const current = await ensureRuntime(); alive();
            await current.tasks.revealInput({ webContentsId: event.sender.id, ownerSessionId: owner.capability }, request.id,
              inputPath => { alive(); shell.showItemInFolder(inputPath); }, alive);
          } else {
            if (!owner.documents.has(request.id)) throw new StudioError('access_denied');
            const source = await sources.inspect(request.id, alive);
            if (source.summary.status !== 'ready') throw new StudioError('output_write_failed');
            await sources.publish(request.id, source.bindingId, async (directory, verify) => {
              await verify(); alive();
              if (await shell.openPath(directory)) throw new StudioError('output_write_failed');
            }, alive);
          }
          alive(); return { ok: true, value: null };
        }
        if (Object.hasOwn(transcriptionRequestSchemas, method)) {
          if (method === 'enqueueTranscription' && requestSchemas.enqueueTranscription.parse(payload).autoTranslation) {
            await automaticTranslation.initialize(); alive();
          }
          const current = await ensureRuntime(); alive();
          const value = await handleTranscriptionRequest({ method, payload, sender: event.sender,
            owner: { webContentsId: event.sender.id, ownerSessionId: owner.capability }, runtime: current, alive });
          alive();
          return { ok: true, value };
        }
        await translation.initialize(); alive();
        if (method === 'listTranslationTasks') {
          const snapshot = await repository.listSnapshot(); alive();
          const value = selectTranslationTasks(snapshot, requestSchemas.listTranslationTasks.parse(payload));
          // Opening an overview row uses the same per-document capability as library selection.
          value.items.forEach(item => owner.documents.add(item.documentId));
          return { ok: true, value };
        }
        if (method === 'listDocuments') {
          const snapshot = await repository.listSnapshot(); alive();
          const value = selectLibrary(snapshot, requestSchemas.listDocuments.parse(payload));
          value.documents.forEach(doc => owner.documents.add(doc.id));
          owner.unavailable = new Map(snapshot.unavailable.map(item => [item.id, item.token]));
          return { ok: true, value };
        }
        if (method === 'getSourceLocation' || method === 'selectSourceDirectory') {
          const { documentId } = requestSchemas.getSourceLocation.parse(payload);
          if (!owner.documents.has(documentId)) throw new StudioError('access_denied');
          if (method === 'getSourceLocation') return { ok: true, value: await sources.get(documentId, alive) };
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new StudioError('access_denied');
          const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }); alive();
          if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
          return { ok: true, value: await sources.selectDirectory(documentId, selection.filePaths[0], alive) };
        }
        if (method === 'revealUnavailable' || method === 'deleteUnavailable') {
          const request = requestSchemas.revealUnavailable.parse(payload);
          if (owner.unavailable.get(request.documentId) !== request.token) throw new StudioError('access_denied');
          if (method === 'revealUnavailable') {
            const directory = await repository.revealUnavailable(request.documentId, request.token, alive); alive();
            shell.showItemInFolder(directory);
            return { ok: true, value: null };
          }
          const value = await repository.deleteUnavailable(request.documentId, request.token, alive); alive();
          owner.unavailable.delete(request.documentId);
          return { ok: true, value };
        }
        if (method === 'importSubtitles' || method === 'importSubtitle') {
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new StudioError('access_denied');
          const selection = await dialog.showOpenDialog(window, { properties: method === 'importSubtitles' ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name: 'SRT / LRC / VTT / ASS', extensions: ['srt', 'lrc', 'vtt', 'ass'] }] }); alive();
          if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
          const value = await importSelections(selection.filePaths.map(file => ({ path: file, fileName: path.basename(file) })), requestSchemas.importSubtitles.parse(payload).encoding, owner, alive);
          if (method === 'importSubtitles') return { ok: true, value };
          const item = value.items[0];
          if (!item?.ok) throw new StudioError(item?.error ?? 'invalid_input');
          return { ok: true, value: item.document };
        }
        if (method === 'planTranslationBatch' || method === 'planExportBatch' || method === 'exportSources') {
          const input = requestSchemas[method].parse(payload);
          if (input.documents.some(doc => !owner.documents.has(doc.documentId))) throw new StudioError('access_denied');
          if (method === 'planTranslationBatch') return { ok: true, value: await batches.planTranslation(event.sender.id, requestSchemas.planTranslationBatch.parse(payload), alive) };
          if (method === 'planExportBatch') return { ok: true, value: await batches.planExport(event.sender.id, requestSchemas.planExportBatch.parse(payload), alive) };
          if (requestSchemas.exportSources.parse(payload).destination === 'source-directory') return { ok: true, value: await batches.exportSources(input.documents, undefined, alive, 'source-directory') };
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new StudioError('access_denied');
          const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }); alive();
          if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
          return { ok: true, value: await batches.exportSources(input.documents, selection.filePaths[0], alive) };
        }
        if (method === 'createTranslationBatch') {
          const { batchId, apiKey } = requestSchemas.createTranslationBatch.parse(payload);
          return { ok: true, value: await batches.createTranslation(event.sender.id, batchId, apiKey, alive) };
        }
        if (method === 'exportBatch') {
          const { batchId, acceptedLosses, destination } = requestSchemas.exportBatch.parse(payload);
          batches.inspectExport(event.sender.id, batchId, acceptedLosses);
          if (destination === 'source-directory') return { ok: true, value: await batches.export(event.sender.id, batchId, acceptedLosses, undefined, alive, destination) };
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new StudioError('access_denied');
          const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }); alive();
          if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
          return { ok: true, value: await batches.export(event.sender.id, batchId, acceptedLosses, selection.filePaths[0], alive) };
        }
        const request = requestSchemas.exportSource.pick({ documentId: true, revision: true }).strip().parse(payload);
        if (!owner.documents.has(request.documentId)) throw new StudioError('access_denied');
        if (method === 'planExport') {
          const { options } = requestSchemas.planExport.parse(payload);
          const value = await exports.plan(event.sender.id, request.documentId, request.revision, options, alive); alive();
          return { ok: true, value };
        }
        if (method === 'exportDocument') {
          const { planId, acceptedLosses, destination } = requestSchemas.exportDocument.parse(payload);
          const plan = exports.inspect(event.sender.id, request.documentId, request.revision, planId, acceptedLosses);
          if (destination === 'source-directory') return { ok: true, value: await exports.publishToSource(event.sender.id, request.documentId, request.revision, planId, acceptedLosses, alive) };
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new StudioError('access_denied');
          const defaultPath = plan.options.conflictPolicy === 'overwrite' ? path.join(app.getPath('downloads'), plan.fileName)
            : await unusedOutputPath(app.getPath('downloads'), plan.fileName); alive();
          const selection = await dialog.showSaveDialog(window, { defaultPath, filters: [{ name: plan.options.format.toUpperCase(), extensions: [plan.options.format] }] }); alive();
          if (selection.canceled || !selection.filePath) return { ok: true, value: null };
          const usingDefault = process.platform === 'win32'
            ? path.resolve(selection.filePath).toLowerCase() === path.resolve(defaultPath).toLowerCase()
            : path.resolve(selection.filePath) === path.resolve(defaultPath);
          // Re-evaluate indices from the original leaf if a competing export claimed the suggestion.
          const outputPath = usingDefault ? path.join(path.dirname(defaultPath), plan.fileName) : selection.filePath;
          const value = await exports.publish(event.sender.id, request.documentId, request.revision, planId, acceptedLosses, outputPath, alive, plan.options.conflictPolicy ?? 'indexed');
          return { ok: true, value };
        }
        if (method === 'cancelTask') {
          const { taskId } = requestSchemas.cancelTask.parse(payload);
          const value = await translation.cancel(request.documentId, request.revision, taskId, alive); alive();
          return { ok: true, value };
        }
        if (method === 'resumeTask') {
          const { taskId, model, apiKey } = requestSchemas.resumeTask.parse(payload);
          const value = await translation.resume(request.documentId, request.revision, taskId, model, apiKey, alive); alive();
          return { ok: true, value };
        }
        if (method === 'previewBilingual') {
          const { options, offset, reviewOnly } = requestSchemas.previewBilingual.parse(payload);
          const value = await bilingual.preview(request.documentId, request.revision, options, offset, alive, reviewOnly); alive();
          return { ok: true, value };
        }
        if (method === 'applyBilingual') {
          const { options } = requestSchemas.applyBilingual.parse(payload);
          const value = await bilingual.apply(request.documentId, request.revision, options, alive); alive();
          return { ok: true, value: summarizeDocument(value) };
        }
        if (method === 'removeTranslationTrack') {
          const { trackId } = requestSchemas.removeTranslationTrack.parse(payload);
          const value = await bilingual.removeTrack(request.documentId, request.revision, trackId, alive); alive();
          return { ok: true, value: summarizeDocument(value) };
        }
        if (method === 'planTranslation') {
          const { config } = requestSchemas.planTranslation.parse(payload);
          const value = await translation.plan(event.sender.id, request.documentId, request.revision, config, alive); alive();
          return { ok: true, value };
        }
        if (method === 'createTranslation') {
          const { planId, apiKey } = requestSchemas.createTranslation.parse(payload);
          const value = await translation.start(event.sender.id, request.documentId, request.revision, planId, apiKey, alive); alive();
          return { ok: true, value };
        }
        if (method === 'deleteDocument') {
          const value = await repository.delete(request.documentId, request.revision, alive); alive();
          return { ok: true, value };
        }
        if (method === 'removeTask') {
          const { taskId } = requestSchemas.removeTask.parse(payload);
          const snapshot = await repository.removeTask(request.documentId, request.revision, taskId, alive); alive();
          return { ok: true, value: summarizeDocument(snapshot.document) };
        }
        const snapshot = await repository.readSnapshot(request.documentId); alive();
        const doc = snapshot.document;
        if (doc.revision !== request.revision) throw new StudioError('revision_conflict');
        if (method === 'readDocumentPage') {
          const { offset, nodeOffset = 0 } = requestSchemas.readDocumentPage.parse(payload);
          const cues = doc.cues.slice(offset, offset + LIMITS.pageSize);
          const raw = doc.schemaVersion === 1 ? doc.preservation : null;
          const nodes = raw?.nodes.slice(nodeOffset, nodeOffset + LIMITS.pageSize) ?? [];
          const cueIds = new Set(cues.map(cue => cue.id));
          const translationTracks = doc.translationTracks.map(track => ({ ...track, entries: Object.fromEntries(Object.entries(track.entries).filter(([id]) => cueIds.has(id))) }));
          return { ok: true, value: { summary: summarizeDocument(doc, snapshot.tasks), cues, offset, nodeOffset, nodeCount: raw?.nodes.length ?? 0, rawNodes: nodes.map(node => ({ id: node.id, text: raw!.rawText.slice(node.start, node.end) })), translationTracks, tasks: snapshot.tasks.map(summarizeTask) } };
        }
        if (method !== 'exportSource') throw new StudioError('invalid_input');
        if (!doc.capabilities.preserveSource) throw new StudioError('unsupported_feature');
        if (requestSchemas.exportSource.parse(payload).destination === 'source-directory') return { ok: true, value: await exports.exportOriginalToSource(request.documentId, request.revision, alive) };
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new StudioError('access_denied');
        const defaultPath = await unusedOutputPath(app.getPath('downloads'), doc.origin.displayName); alive();
        const selection = await dialog.showSaveDialog(window, { defaultPath, filters: [{ name: doc.origin.format.toUpperCase(), extensions: [doc.origin.format] }] }); alive();
        if (selection.canceled || !selection.filePath) return { ok: true, value: null };
        const output = await repository.withExistingDocument(request.documentId, async () => {
          alive();
          const usingDefault = process.platform === 'win32'
            ? path.resolve(selection.filePath!).toLowerCase() === path.resolve(defaultPath).toLowerCase()
            : path.resolve(selection.filePath!) === path.resolve(defaultPath);
          return publishSource(doc, usingDefault ? path.join(path.dirname(defaultPath), doc.origin.displayName) : selection.filePath!, alive, usingDefault ? 'indexed' : 'replace');
        });
        return { ok: true, value: { fileName: path.basename(output) } };
      } catch (error) { return { ok: false, error: Object.hasOwn(transcriptionRequestSchemas, method) ? transcriptionIpcError(error) : error instanceof StudioError ? error.code : 'document_unavailable' }; }
    });
  }
  return {
    attach(sender: WebContents) {
      if (closed || allowed.has(sender.id)) return;
      allowed.add(sender.id);
      sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) forgetOwner(sender.id); });
      sender.once('destroyed', () => { forgetOwner(sender.id); allowed.delete(sender.id); });
    },
    dispose(reason: 'app_quit' | 'update' | 'fatal' = 'app_quit'): Promise<void> {
      if (shutdown) return shutdown;
      closed = true;
      let automaticCleanup: Promise<void> | undefined;
      // Cache before owner cancellation can dispatch synchronous abort listeners.
      shutdown = Promise.resolve().then(async () => {
        const failures = retirementFailures; retirementFailures = [];
        const results = await Promise.allSettled([
          Promise.resolve().then(async () => {
            // Stop and join admissions before interrupting the translation runs they created.
            try { await automaticCleanup; } catch (error) { failures.push(error); }
            await translation.dispose();
          }),
          Promise.resolve().then(() => runtime?.shutdown(reason)),
          ...retirements,
        ]);
        for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
        retirementFailures = [];
        if (failures.length) throw new AggregateError(failures, 'Subtitle Studio cleanup failed.');
      }).catch(error => { shutdown = undefined; throw error; });
      try { automaticCleanup = automaticTranslation.shutdown(); } catch (error) { retirementFailures.push(error); }
      for (const id of owners.keys()) forgetOwner(id);
      for (const cleanup of [() => exports.dispose(), () => batches.dispose(), unsubscribe,
        () => allowed.clear(), () => ipcMain.removeAllListeners(STUDIO_CHANNELS.register), () => ipcMain.removeHandler(STUDIO_CHANNELS.importDroppedSubtitles), () => ipcMain.removeHandler(STUDIO_CHANNELS.dropTranscriptionMedia),
        ...(Object.keys(requestSchemas) as (keyof typeof requestSchemas)[]).map(method => () => ipcMain.removeHandler(STUDIO_CHANNELS[method]))]) {
        try { cleanup(); } catch (error) { retirementFailures.push(error); }
      }
      return shutdown;
    },
  };
}
