import { app, BrowserWindow, dialog, ipcMain, type WebContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { KNOWLEDGE_CHANNELS, type KnowledgeResult, type SaveRecordRequest } from '../../../src/translation-knowledge/ipc-contract';
import { KnowledgeService } from './service';
import { KnowledgeServiceError } from './errors';
import { KnowledgeExportPlans } from './export-plans';
import { knowledgeEnvelopeSchema, knowledgeRequestSchemas, publicKnowledgeChannels, trustedKnowledgeUrl } from './ipc';

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function readKnowledgeFile(filePath: string): Promise<string> {
  const file = await open(filePath, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new KnowledgeServiceError('invalid_input');
    if (stats.size > MAX_FILE_BYTES) throw new KnowledgeServiceError('limit_exceeded');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, MAX_FILE_BYTES + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw new KnowledgeServiceError('limit_exceeded');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks, total)); }
    catch { throw new KnowledgeServiceError('invalid_input', [{ code: 'INVALID_UTF8', path: '', message: 'The selected file is not valid UTF-8.' }]); }
  } finally { await file.close(); }
}

/** Publish a complete new file without replacing an existing user file. */
export async function publishKnowledgeFile(filePath: string, contents: string, alive: () => void = () => {}): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.fktk-${randomUUID()}.tmp`);
  let created = false;
  try {
    const bytes = Buffer.from(contents, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) throw new KnowledgeServiceError('limit_exceeded');
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    alive();
    try { await link(temporary, filePath); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new KnowledgeServiceError('file_exists');
      if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM'].includes(code ?? '')) throw new KnowledgeServiceError('unsupported_destination');
      throw error;
    }
    // A successfully linked output must survive subsequent cleanup/durability failures.
    await unlink(temporary); created = false;
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    if (created) await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export function registerTranslationKnowledge() {
  const service = new KnowledgeService(path.join(app.getPath('userData'), 'translation-knowledge'));
  const exportPlans = new KnowledgeExportPlans(() => service.read());
  const rendererUrl = process.env.VITE_DEV_SERVER_URL || pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href;
  const allowed = new Set<number>();
  const owners = new Map<number, { sender: WebContents; capability: string }>();
  const detach = new Map<number, () => void>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let disposing: Promise<void> | undefined;
  let resolveClosing!: () => void;
  const closing = new Promise<void>(resolve => { resolveClosing = resolve; });
  // Native dialogs may remain open while before-quit is waiting for this join.
  // Detach only their UI waits; admitted file IO and repository publications still join.
  const waitForDialog = <T>(operation: Promise<T>): Promise<T> => Promise.race([
    operation,
    closing.then(() => { throw new KnowledgeServiceError('access_denied'); }),
  ]);
  function forgetOwner(id: number) {
    const owner = owners.get(id); owners.delete(id);
    if (owner) { service.releaseOwner(owner.capability); exportPlans.releaseOwner(owner.capability); }
  }
  const register = (event: IpcMainEvent, input: unknown) => {
    if (closed || !allowed.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame || !event.senderFrame || !trustedKnowledgeUrl(event.senderFrame.url, rendererUrl) || !knowledgeRequestSchemas.read.safeParse(input).success) { event.returnValue = null; return; }
    forgetOwner(event.sender.id);
    const owner = { sender: event.sender, capability: randomUUID() };
    owners.set(event.sender.id, owner); event.returnValue = owner.capability;
  };
  ipcMain.on(KNOWLEDGE_CHANNELS.register, register);
  for (const method of Object.keys(knowledgeRequestSchemas) as (keyof typeof knowledgeRequestSchemas)[]) {
    ipcMain.handle(KNOWLEDGE_CHANNELS[method], (event: IpcMainInvokeEvent, input: unknown) => {
      const operation = (async (): Promise<KnowledgeResult<unknown>> => {
        try {
          const parsed = knowledgeEnvelopeSchema.safeParse(input);
          const owner = owners.get(event.sender.id);
          if (!parsed.success || !owner || owner.sender !== event.sender || parsed.data.capability !== owner.capability || event.senderFrame !== event.sender.mainFrame) throw new KnowledgeServiceError('access_denied');
          const alive = () => { if (closed || owners.get(event.sender.id) !== owner || event.sender.isDestroyed() || !trustedKnowledgeUrl(event.sender.mainFrame.url, rendererUrl)) throw new KnowledgeServiceError('access_denied'); };
          alive();
          const payload = knowledgeRequestSchemas[method].safeParse(parsed.data.payload);
          if (!payload.success) throw new KnowledgeServiceError('invalid_input');
          const window = BrowserWindow.fromWebContents(event.sender);
          if (!window) throw new KnowledgeServiceError('access_denied');
          let value: unknown;
          if (method === 'read') { value = await service.read(); alive(); }
          else if (method === 'importDroppedFile') {
            const request = knowledgeRequestSchemas.importDroppedFile.parse(payload.data);
            const text = await readKnowledgeFile(request.path); alive();
            value = await service.planImport(owner.capability, text); alive();
          }
          else if (method === 'selectImport') {
            const selected = await waitForDialog(dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'FusionKit Translation Knowledge', extensions: ['fktk.json', 'json'] }] }));
            alive();
            if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: null };
            const text = await readKnowledgeFile(selected.filePaths[0]); alive();
            value = await service.planImport(owner.capability, text); alive();
          } else if (method === 'commitImport') {
            exportPlans.invalidate();
            value = await service.commitImport(owner.capability, knowledgeRequestSchemas.commitImport.parse(payload.data), alive);
          } else if (method === 'saveRecord') {
            exportPlans.invalidate();
            value = await service.saveRecord(payload.data as SaveRecordRequest, alive);
          } else if (method === 'reviewEntries') {
            exportPlans.invalidate();
            value = await service.reviewEntries(knowledgeRequestSchemas.reviewEntries.parse(payload.data), alive);
          } else if (method === 'planMaintenance') {
            value = await service.planMaintenance(owner.capability, knowledgeRequestSchemas.planMaintenance.parse(payload.data)); alive();
          } else if (method === 'commitMaintenance') {
            exportPlans.invalidate();
            value = await service.commitMaintenance(owner.capability, knowledgeRequestSchemas.commitMaintenance.parse(payload.data), alive);
          } else if (method === 'planExport') {
            value = await exportPlans.plan(owner.capability, knowledgeRequestSchemas.planExport.parse(payload.data), alive);
          } else {
            const request = knowledgeRequestSchemas.exportFile.parse(payload.data);
            await exportPlans.prepare(owner.capability, request, alive);
            const fileName = `translation-knowledge-${new Date().toISOString().replace(/[:.]/g, '-')}.fktk.json`;
            const selected = await waitForDialog(dialog.showSaveDialog(window, { defaultPath: fileName, filters: [{ name: 'FusionKit Translation Knowledge', extensions: ['fktk.json'] }] }));
            alive();
            if (selected.canceled || !selected.filePath) return { ok: true, value: null };
            const exported = await exportPlans.prepare(owner.capability, request, alive);
            await publishKnowledgeFile(selected.filePath, exported.text, () => { alive(); exportPlans.guard(owner.capability, request.planId); });
            value = { fileName: path.basename(selected.filePath), entries: exported.preview.counts.entries, purpose: exported.preview.purpose };
          }
          return { ok: true, value };
        } catch (error) {
          return error instanceof KnowledgeServiceError
            ? { ok: false, error: error.code, ...(error.diagnostics?.length ? { diagnostics: error.diagnostics } : {}) }
            : { ok: false, error: method === 'read' ? 'storage_unavailable' : 'write_failed' };
        }
      })();
      pending.add(operation); void operation.finally(() => pending.delete(operation));
      return operation;
    });
  }
  return {
    attach(contents: WebContents) {
      if (closed || allowed.has(contents.id)) return;
      allowed.add(contents.id);
      const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) forgetOwner(contents.id); };
      const destroyed = () => { forgetOwner(contents.id); allowed.delete(contents.id); detach.delete(contents.id); };
      contents.on('did-start-navigation', navigation); contents.once('destroyed', destroyed);
      detach.set(contents.id, () => { contents.removeListener('did-start-navigation', navigation); contents.removeListener('destroyed', destroyed); });
    },
    dispose(): Promise<void> {
      if (disposing) return disposing;
      closed = true;
      exportPlans.dispose();
      resolveClosing();
      for (const id of owners.keys()) forgetOwner(id);
      for (const remove of detach.values()) remove(); detach.clear(); allowed.clear();
      ipcMain.removeListener(KNOWLEDGE_CHANNELS.register, register);
      for (const channel of publicKnowledgeChannels) ipcMain.removeHandler(channel);
      disposing = Promise.allSettled([...pending]).then(() => service.dispose());
      return disposing;
    },
  };
}
