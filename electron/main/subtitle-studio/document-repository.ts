import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { idSchema, LIMITS, StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { validateSnapshot, type DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';

export type CommitStage = 'generation-write' | 'generation-sync' | 'generation-ready' | 'previous-ready' | 'current-write' | 'current-sync' | 'current-publish' | 'delete-publish' | 'delete-cleanup';
export type RepositoryEvent = { documentId: string; revision: number; sequence: number; deleted: boolean };
type SharedState = { tail: Promise<unknown>; activities: Map<string, Set<AbortController>>; sequence: number; listeners: Set<(event: RepositoryEvent) => void> };
const roots = new Map<string, SharedState>();
const pointerSchema = z.object({ generation: idSchema, digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
type Pointer = z.infer<typeof pointerSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class DocumentRepository {
  private readonly state: SharedState;
  private readonly root: string;
  constructor(root: string, private readonly options: { fault?: (stage: CommitStage) => void } = {}) {
    this.root = path.resolve(root);
    if (!roots.has(this.root)) roots.set(this.root, { tail: Promise.resolve(), activities: new Map(), sequence: 0, listeners: new Set() });
    this.state = roots.get(this.root)!;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.state.tail.then(action);
    this.state.tail = result.catch(() => undefined);
    return result;
  }
  private directory(id: string) {
    if (!idSchema.safeParse(id).success) throw new StudioError('invalid_input');
    return path.join(this.root, id);
  }
  private tombstone(id: string) { this.directory(id); return path.join(this.root, '.deleted', `${id}.json`); }
  private async isDeleted(id: string) {
    try { await lstat(this.tombstone(id)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async assertDirectory(directory: string) {
    if (!(await lstat(directory)).isDirectory()) throw new StudioError('document_unavailable');
  }
  private async readFile(filePath: string, limit: number) {
    if (!(await lstat(filePath)).isFile()) throw new StudioError('document_unavailable');
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit) throw new StudioError('document_unavailable');
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }
  private async synced(filePath: string, content: string, writeStage?: CommitStage, syncStage?: CommitStage) {
    const handle = await open(filePath, 'wx', 0o600);
    try {
      if (writeStage) this.options.fault?.(writeStage);
      await handle.writeFile(content, 'utf8');
      if (syncStage) this.options.fault?.(syncStage);
      await handle.sync();
    } finally { await handle.close(); }
  }
  private async syncDirectory(directory: string) {
    // Windows cannot open directories for fsync. Files are synced before rename on all platforms.
    if (process.platform === 'win32') return;
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async publish(filePath: string, content: string, stage?: CommitStage, guard: () => void = () => {}) {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await this.synced(temporary, content, stage === 'current-publish' ? 'current-write' : undefined, stage === 'current-publish' ? 'current-sync' : undefined);
      if (stage) this.options.fault?.(stage);
      guard();
      await rename(temporary, filePath);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  private async committed(id: string): Promise<{ snapshot: DocumentSnapshot; pointer: Pointer }> {
    const directory = this.directory(id);
    if (await this.isDeleted(id)) throw new StudioError('document_unavailable');
    try { await this.assertDirectory(directory); } catch { throw new StudioError('document_unavailable'); }
    // Only published pointers establish commits; orphan generations may be interrupted writes.
    for (const name of ['current.json', 'previous.json']) {
      try {
        const pointer = pointerSchema.parse(JSON.parse(await this.readFile(path.join(directory, name), 1024)));
        const json = await this.readFile(path.join(directory, `${pointer.generation}.json`), LIMITS.snapshotBytes);
        if (pointer.digest && digest(json) !== pointer.digest) throw new Error('Digest mismatch');
        const snapshot = validateSnapshot(JSON.parse(json));
        if (snapshot.document.id !== id) throw new Error('Identity mismatch');
        return { snapshot, pointer: { ...pointer, digest: digest(json) } };
      } catch { /* Try the previous published commit. */ }
    }
    throw new StudioError('document_unavailable');
  }
  private async commit(snapshot: DocumentSnapshot, previous?: Pointer, guard: () => void = () => {}) {
    const validated = validateSnapshot(snapshot);
    const json = JSON.stringify(validated);
    if (Buffer.byteLength(json) > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
    const directory = this.directory(validated.document.id);
    const generation = randomUUID();
    await this.synced(path.join(directory, `${generation}.json`), json, 'generation-write', 'generation-sync');
    await this.syncDirectory(directory);
    this.options.fault?.('generation-ready');
    if (previous) {
      await this.publish(path.join(directory, 'previous.json'), JSON.stringify(previous));
      await this.syncDirectory(directory);
      this.options.fault?.('previous-ready');
    }
    await this.publish(path.join(directory, 'current.json'), JSON.stringify({ generation, digest: digest(json) }), 'current-publish', guard);
    await this.syncDirectory(directory);
    const keep = new Set(['current.json', 'previous.json', `${generation}.json`, `${previous?.generation}.json`]);
    for (const entry of await readdir(directory).catch(() => [])) {
      if (!keep.has(entry) && (entry.endsWith('.tmp') || idSchema.safeParse(entry.replace(/\.json$/, '')).success)) await rm(path.join(directory, entry), { force: true }).catch(() => undefined);
    }
    this.emit(validated.document.id, validated.document.revision, false);
    return validated;
  }
  private emit(documentId: string, revision: number, deleted: boolean) {
    const event = { documentId, revision, deleted, sequence: ++this.state.sequence };
    for (const listener of this.state.listeners) { try { listener(event); } catch { /* Observers cannot roll back commits. */ } }
  }
  subscribe(listener: (event: RepositoryEvent) => void) {
    this.state.listeners.add(listener);
    return () => { this.state.listeners.delete(listener); };
  }
  create(value: SubtitleDocument, guard: () => void = () => {}): Promise<SubtitleDocument> {
    return this.serial(async () => {
      const snapshot = validateSnapshot({ schemaVersion: 1, document: value, tasks: [] });
      const directory = this.directory(value.id);
      if (await this.isDeleted(value.id)) throw new StudioError('document_unavailable');
      await mkdir(this.root, { recursive: true });
      await mkdir(directory);
      try { return (await this.commit(snapshot, undefined, guard)).document; }
      catch (error) { await rm(directory, { recursive: true, force: true }).catch(() => undefined); throw error; }
    });
  }
  readSnapshot(id: string): Promise<DocumentSnapshot> { return this.serial(async () => (await this.committed(id)).snapshot); }
  async read(id: string): Promise<SubtitleDocument> { return (await this.readSnapshot(id)).document; }
  withDocument<T>(id: string, revision: number, action: (document: SubtitleDocument) => Promise<T>) {
    return this.serial(async () => {
      const { snapshot } = await this.committed(id);
      if (snapshot.document.revision !== revision) throw new StudioError('revision_conflict');
      return action(snapshot.document);
    });
  }
  listSnapshot() {
    return this.serial(async () => {
      await mkdir(this.root, { recursive: true });
      const deletedFolder = path.join(this.root, '.deleted');
      try {
        await this.assertDirectory(deletedFolder);
        for (const entry of await readdir(deletedFolder)) {
          const id = entry.replace(/\.json$/, '');
          if (entry.endsWith('.json') && idSchema.safeParse(id).success) await this.cleanup(id);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const entries = await readdir(this.root, { withFileTypes: true });
      const documents: SubtitleDocument[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && idSchema.safeParse(entry.name).success && !await this.isDeleted(entry.name)) documents.push((await this.committed(entry.name)).snapshot.document);
      }
      return { documents, sequence: this.state.sequence };
    });
  }
  async list() { return (await this.listSnapshot()).documents; }
  transact(id: string, expectedRevision: number, mutate: (snapshot: DocumentSnapshot) => void, guard: () => void = () => {}): Promise<DocumentSnapshot> {
    return this.serial(async () => {
      const { snapshot, pointer } = await this.committed(id);
      if (snapshot.document.revision !== expectedRevision) throw new StudioError('revision_conflict');
      const result: unknown = mutate(snapshot);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
        throw new StudioError('invalid_input');
      }
      if (snapshot.document.id !== id || snapshot.document.revision !== expectedRevision) throw new StudioError('invalid_input');
      snapshot.document.revision++;
      return this.commit(snapshot, pointer, guard);
    });
  }
  removeTask(id: string, expectedRevision: number, taskId: string, guard: () => void = () => {}) {
    return this.transact(id, expectedRevision, snapshot => {
      const task = snapshot.tasks.find(item => item.id === taskId);
      if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) throw new StudioError('invalid_input');
      if (snapshot.tasks.some(item => item.status === 'queued' || item.status === 'running')) throw new StudioError('revision_conflict');
      snapshot.tasks = snapshot.tasks.filter(item => item.id !== taskId);
    }, guard);
  }
  registerActivity(id: string, controller: AbortController) {
    this.directory(id);
    const activities = this.state.activities.get(id) ?? new Set<AbortController>();
    activities.add(controller); this.state.activities.set(id, activities);
    // Check the tombstone after already queued operations, including a concurrent deletion.
    void this.serial(async () => { if (await this.isDeleted(id)) controller.abort(); }).catch(() => controller.abort());
    return () => { activities.delete(controller); if (!activities.size) this.state.activities.delete(id); };
  }
  delete(id: string, expectedRevision: number, guard: () => void = () => {}) {
    return this.serial(async () => {
      const { snapshot } = await this.committed(id);
      if (snapshot.document.revision !== expectedRevision) throw new StudioError('revision_conflict');
      const folder = path.join(this.root, '.deleted');
      await mkdir(folder, { recursive: true }); await this.assertDirectory(folder);
      await this.publish(this.tombstone(id), JSON.stringify({ schemaVersion: 1, documentId: id, revision: expectedRevision + 1 }), 'delete-publish', guard);
      await this.syncDirectory(folder);
      for (const controller of this.state.activities.get(id) ?? []) controller.abort();
      this.state.activities.delete(id);
      this.emit(id, expectedRevision + 1, true);
      return this.cleanup(id);
    });
  }
  private async cleanup(id: string) {
    if (!await this.isDeleted(id)) throw new StudioError('invalid_input');
    try {
      this.options.fault?.('delete-cleanup');
      await rm(this.directory(id), { recursive: true, force: true });
      return { cleanupPending: false };
    } catch { return { cleanupPending: true }; }
  }
  retryCleanup(id: string) { return this.serial(() => this.cleanup(id)); }
}
