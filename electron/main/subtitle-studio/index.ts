import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { LIMITS, StudioError } from '../../../src/subtitle-studio/domain';
import { STUDIO_CHANNELS, requestSchemas, summarizeDocument, type StudioResult } from '../../../src/subtitle-studio/ipc-contract';
import { DocumentRepository } from './document-repository';
import { readSubtitle } from './input-service';
import { publishSource, unusedOutputPath } from './export-service';

export function registerSubtitleStudio() {
  const repository = new DocumentRepository(path.join(app.getPath('userData'), 'subtitle-studio', 'documents'));
  const owners = new Map<number, { sender: WebContents; capability: string; documents: Set<string> }>();
  const allowed = new Set<number>();
  const envelope = z.object({ capability: z.string().uuid(), payload: z.unknown() }).strict();
  ipcMain.on(STUDIO_CHANNELS.register, (event, request) => {
    if (!allowed.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame || !z.object({}).strict().safeParse(request).success) { event.returnValue = null; return; }
    const owner = { sender: event.sender, capability: randomUUID(), documents: new Set<string>() };
    owners.set(event.sender.id, owner);
    event.returnValue = owner.capability;
  });

  function ownerFor(event: IpcMainInvokeEvent, input: unknown) {
    const parsed = envelope.safeParse(input);
    const owner = owners.get(event.sender.id);
    if (!parsed.success || !owner || owner.sender !== event.sender || event.senderFrame !== event.sender.mainFrame || owner.capability !== parsed.data.capability) throw new StudioError('access_denied');
    return { owner, payload: parsed.data.payload };
  }
  for (const method of Object.keys(requestSchemas) as (keyof typeof requestSchemas)[]) {
    ipcMain.handle(STUDIO_CHANNELS[method], async (event, input): Promise<StudioResult<unknown>> => {
      try {
        const { owner, payload } = ownerFor(event, input);
        const parsed = requestSchemas[method].safeParse(payload);
        if (!parsed.success) throw new StudioError('invalid_input');
        const alive = () => { if (owners.get(event.sender.id) !== owner || event.sender.isDestroyed()) throw new StudioError('access_denied'); };
        if (method === 'listDocuments') {
          const { offset } = requestSchemas.listDocuments.parse(payload);
          const documents = await repository.list(); alive();
          const page = documents.slice(offset, offset + LIMITS.pageSize);
          page.forEach(doc => owner.documents.add(doc.id));
          return { ok: true, value: { documents: page.map(summarizeDocument), total: documents.length } };
        }
        if (method === 'importSubtitle') {
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new StudioError('access_denied');
          const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'SRT / LRC', extensions: ['srt', 'lrc'] }] }); alive();
          if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
          const doc = await readSubtitle(selection.filePaths[0], requestSchemas.importSubtitle.parse(payload).encoding); alive();
          await repository.create(doc); alive(); owner.documents.add(doc.id);
          return { ok: true, value: summarizeDocument(doc) };
        }
        const request = requestSchemas.exportSource.parse({ documentId: (parsed.data as { documentId: string }).documentId, revision: (parsed.data as { revision: number }).revision });
        if (!owner.documents.has(request.documentId)) throw new StudioError('access_denied');
        const doc = await repository.read(request.documentId); alive();
        if (doc.revision !== request.revision) throw new StudioError('revision_conflict');
        if (method === 'readDocumentPage') {
          const { offset, nodeOffset = 0 } = requestSchemas.readDocumentPage.parse(payload);
          const cues = doc.cues.slice(offset, offset + LIMITS.pageSize);
          const nodes = doc.preservation.nodes.slice(nodeOffset, nodeOffset + LIMITS.pageSize);
          return { ok: true, value: { summary: summarizeDocument(doc), cues, offset, nodeOffset, nodeCount: doc.preservation.nodes.length, rawNodes: nodes.map(node => ({ id: node.id, text: doc.preservation.rawText.slice(node.start, node.end) })) } };
        }
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new StudioError('access_denied');
        const selection = await dialog.showSaveDialog(window, { defaultPath: await unusedOutputPath(app.getPath('downloads'), doc.origin.displayName), filters: [{ name: doc.origin.format.toUpperCase(), extensions: [doc.origin.format] }] }); alive();
        if (selection.canceled || !selection.filePath) return { ok: true, value: null };
        await publishSource(doc, selection.filePath);
        return { ok: true, value: { fileName: path.basename(selection.filePath) } };
      } catch (error) { return { ok: false, error: error instanceof StudioError ? error.code : 'document_unavailable' }; }
    });
  }
  return {
    attach(sender: WebContents) {
      allowed.add(sender.id);
      sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) owners.delete(sender.id); });
      sender.once('destroyed', () => { owners.delete(sender.id); allowed.delete(sender.id); });
    },
    dispose() {
      owners.clear(); allowed.clear();
      ipcMain.removeAllListeners(STUDIO_CHANNELS.register);
      for (const method of Object.keys(requestSchemas) as (keyof typeof requestSchemas)[]) ipcMain.removeHandler(STUDIO_CHANNELS[method]);
    },
  };
}
