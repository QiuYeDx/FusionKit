import { lstat, mkdir, open, opendir, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { idSchema, LIMITS, StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';
import { validateSnapshot, type DocumentSnapshot } from '../../../src/subtitle-studio/persistence-contract';
import { assertExecutionRecordsSize, recordBaseDigest, validateExecutionRecord } from '../../../src/subtitle-studio/execution-record-contract';
import type { AutomaticTranslationIntent } from '../../../src/subtitle-studio/automatic-translation-contract';
import type { UnavailableDocument } from '../../../src/subtitle-studio/batch-contract';
import { bindSourceLocation, validateSourceLocationRecord, SOURCE_LOCATION_FILE, type SourceLocationCapture, type SourceLocationRecord } from './source-location-service';
import { knowledgeResourceReferences, validateFrozenKnowledgeSnapshot } from '../../../src/translation-knowledge/snapshot-contract';
import { automaticKnowledgeResourceReferences, validateFrozenAutomaticKnowledge } from '../../../src/translation-knowledge/automatic-snapshot-contract';
import { knowledgeReferenceKey } from '../../../src/translation-knowledge/task-reference-contract';
import { sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import type { KnowledgeReferenceInventory, KnowledgeTaskReference } from '../../../src/translation-knowledge/task-reference-contract';
import { validateAutomaticKnowledgeReport } from './automatic-knowledge-report';

export type CommitStage = 'generation-write' | 'generation-sync' | 'generation-ready' | 'previous-ready' | 'current-write' | 'current-sync' | 'current-publish' | 'current-directory-sync' | 'create-cleanup' | 'delete-publish' | 'delete-cleanup';
export type RepositoryEvent = { documentId: string; revision: number; sequence: number; deleted: boolean };
export type DocumentCreationReceipt = Readonly<{ status: 'committed'; documentId: string; revision: number; durability: 'confirmed' | 'uncertain'; replayed: boolean }>;
type PendingCreation = { digest: string; dev: number; ino: number };
type SharedState = { tail: Promise<unknown>; activities: Map<string, Set<AbortController>>; sequence: number; listeners: Set<(event: RepositoryEvent) => void>; pendingCreations: Map<string, PendingCreation> };
const roots = new Map<string, SharedState>();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const creationSchema = z.object({ digest: digestSchema, revision: z.number().int().positive().safe() }).strict();
const pointerSchema = z.object({ generation: idSchema, digest: digestSchema.optional(), creation: creationSchema.optional() }).strict();
type Pointer = z.infer<typeof pointerSchema>;
type CreationPublication = { identity: z.infer<typeof creationSchema>; published: boolean; durability: 'confirmed' | 'uncertain' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const KNOWLEDGE_REFERENCE_SCAN_LIMITS = { documents: 1000, files: 10000, bytes: 256 * 1024 * 1024, records: 5000, resources: 100000 } as const;
const deletedDocumentSchema = z.union([
  z.object({ schemaVersion: z.literal(1), documentId: idSchema, revision: z.number().int().positive().safe() }).strict(),
  z.object({ schemaVersion: z.literal(1), documentId: idSchema, kind: z.literal('unavailable') }).strict(),
]);
function validateRepositorySnapshot(value: unknown): DocumentSnapshot {
  const snapshot = validateSnapshot(value);
  const document = snapshot.document;
  if (document.schemaVersion === 2 && digest(JSON.stringify(document.preservation.transcript)) !== document.origin.transcriptDigest) throw new StudioError('invalid_input');
  return snapshot;
}

export class DocumentRepository {
  private readonly state: SharedState;
  private readonly root: string;
  constructor(root: string, private readonly options: { fault?: (stage: CommitStage) => void } = {}) {
    this.root = path.resolve(root);
    if (!roots.has(this.root)) roots.set(this.root, { tail: Promise.resolve(), activities: new Map(), sequence: 0, listeners: new Set(), pendingCreations: new Map() });
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
  private async publish(filePath: string, content: string, stage?: CommitStage, guard: () => void = () => {}, published?: () => void) {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await this.synced(temporary, content, stage === 'current-publish' ? 'current-write' : undefined, stage === 'current-publish' ? 'current-sync' : undefined);
      if (stage) this.options.fault?.(stage);
      guard();
      await rename(temporary, filePath);
      published?.();
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  private async committed(id: string): Promise<{ snapshot: DocumentSnapshot; pointer: Pointer; updatedAt: number }> {
    const directory = this.directory(id);
    if (await this.isDeleted(id)) throw new StudioError('document_unavailable');
    try { await this.assertDirectory(directory); } catch { throw new StudioError('document_unavailable'); }
    // Only published pointers establish commits; orphan generations may be interrupted writes.
    for (const name of ['current.json', 'previous.json']) {
      try {
        const pointer = pointerSchema.parse(JSON.parse(await this.readFile(path.join(directory, name), 1024)));
        const json = await this.readFile(path.join(directory, `${pointer.generation}.json`), LIMITS.snapshotBytes);
        if (pointer.digest && digest(json) !== pointer.digest) throw new Error('Digest mismatch');
        const snapshot = validateRepositorySnapshot(JSON.parse(json));
        if (snapshot.document.id !== id) throw new Error('Identity mismatch');
        return { snapshot, pointer: { ...pointer, digest: digest(json) }, updatedAt: (await lstat(path.join(directory, name))).mtimeMs };
      } catch { /* Try the previous published commit. */ }
    }
    throw new StudioError('document_unavailable');
  }
  private async commit(snapshot: DocumentSnapshot, previous?: Pointer, guard: () => void = () => {}, creation?: CreationPublication) {
    const validated = validateRepositorySnapshot(snapshot);
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
    const creationIdentity = previous?.creation ?? creation?.identity;
    await this.publish(path.join(directory, 'current.json'), JSON.stringify({ generation, digest: digest(json),
      ...(creationIdentity ? { creation: creationIdentity } : {}) }), 'current-publish', guard,
    creation ? () => { creation.published = true; } : undefined);
    if (creation) creation.durability = await this.confirmCreationDurability(directory);
    else await this.syncDirectory(directory);
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
  private async initialSource(document: SubtitleDocument, capture?: SourceLocationCapture) {
    if (!capture) return;
    const file = path.join(this.directory(document.id), SOURCE_LOCATION_FILE);
    const record = bindSourceLocation(document, capture);
    try { await this.synced(file, JSON.stringify(record)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = validateSourceLocationRecord(document, JSON.parse(await this.readFile(file, 128 * 1024)));
      if (JSON.stringify(previous.capture) !== JSON.stringify(record.capture)) throw new StudioError('revision_conflict');
    }
  }
  private async sourceLocation(document: SubtitleDocument): Promise<SourceLocationRecord | null> {
    try { return validateSourceLocationRecord(document, JSON.parse(await this.readFile(path.join(this.directory(document.id), SOURCE_LOCATION_FILE), 128 * 1024))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new StudioError('output_write_failed'); }
  }
  readSourceLocation(id: string) {
    return this.serial(async () => this.sourceLocation((await this.committed(id)).snapshot.document));
  }
  setSourceLocation(id: string, capture: SourceLocationCapture, guard: () => void = () => {}) {
    return this.serial(async () => {
      const document = (await this.committed(id)).snapshot.document;
      const record = bindSourceLocation(document, capture);
      await this.publish(path.join(this.directory(id), SOURCE_LOCATION_FILE), JSON.stringify(record), undefined, guard);
      await this.syncDirectory(this.directory(id));
    });
  }
  withSourceLocation<T>(id: string, bindingId: string, action: (record: SourceLocationRecord, update: (capture: SourceLocationCapture) => Promise<void>) => Promise<T>, revision?: number) {
    return this.serial(async () => {
      const document = (await this.committed(id)).snapshot.document;
      if (revision !== undefined && document.revision !== revision) throw new StudioError('revision_conflict');
      const record = await this.sourceLocation(document);
      if (!record || record.bindingId !== bindingId) throw new StudioError('revision_conflict');
      return action(record, async capture => {
        const next = bindSourceLocation(document, capture);
        await this.publish(path.join(this.directory(id), SOURCE_LOCATION_FILE), JSON.stringify(next));
        await this.syncDirectory(this.directory(id));
      });
    });
  }
  create(value: SubtitleDocument, guard: () => void = () => {}, sourceLocation?: SourceLocationCapture): Promise<SubtitleDocument> {
    return this.serial(async () => {
      const snapshot = validateRepositorySnapshot({ schemaVersion: 1, document: value, tasks: [] });
      const directory = this.directory(value.id);
      if (await this.isDeleted(value.id)) throw new StudioError('document_unavailable');
      await mkdir(this.root, { recursive: true });
      await mkdir(directory);
      try { await this.initialSource(snapshot.document, sourceLocation); return (await this.commit(snapshot, undefined, guard)).document; }
      catch (error) { await rm(directory, { recursive: true, force: true }).catch(() => undefined); throw error; }
    });
  }
  private async confirmCreationDurability(directory: string): Promise<DocumentCreationReceipt['durability']> {
    try {
      this.options.fault?.('current-directory-sync');
      await this.syncDirectory(directory);
      await this.syncDirectory(this.root);
      return 'confirmed';
    } catch { return 'uncertain'; }
  }
  /** Confirm one creation identity. A published document is never rolled back after a sync failure. */
  createConfirmed(value: SubtitleDocument, guard: () => void = () => {}, sourceLocation?: SourceLocationCapture,
    initial?: { automaticTranslation?: AutomaticTranslationIntent }): Promise<DocumentCreationReceipt> {
    let snapshot: DocumentSnapshot;
    try { snapshot = validateRepositorySnapshot({ schemaVersion: 1, document: value, tasks: [], ...(initial?.automaticTranslation ? { automaticTranslation: initial.automaticTranslation } : {}) }); }
    catch (error) { return Promise.reject(error); }
    if (snapshot.automaticTranslation?.preparationReport !== undefined) return Promise.reject(new StudioError('invalid_input'));
    const identity = { digest: digest(JSON.stringify(snapshot)), revision: snapshot.document.revision };
    return this.serial(async () => {
      guard();
      const id = snapshot.document.id;
      const directory = this.directory(id);
      if (await this.isDeleted(id)) throw new StudioError('document_unavailable');
      await mkdir(this.root, { recursive: true });
      let existing = false;
      try { await mkdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; existing = true; }
      if (existing) {
        const pending = this.state.pendingCreations.get(id);
        if (pending) {
          const stat = await lstat(directory);
          if (pending.digest !== identity.digest || !stat.isDirectory() || stat.dev !== pending.dev || stat.ino !== pending.ino) throw new StudioError('revision_conflict');
          // Only this process's retained creation receipt authorizes retrying an unpublished directory.
          for (const name of ['current.json', 'previous.json']) {
            try { await lstat(path.join(directory, name)); throw new StudioError('document_unavailable'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        } else {
          const committed = await this.committed(id);
          if (committed.pointer.creation?.digest !== identity.digest || committed.pointer.creation.revision !== identity.revision
            || committed.snapshot.document.revision < identity.revision) throw new StudioError('revision_conflict');
          guard();
          const durability = await this.confirmCreationDurability(directory);
          return Object.freeze({ status: 'committed', documentId: id, revision: identity.revision, durability, replayed: true });
        }
      }
      const publication: CreationPublication = { identity, published: false, durability: 'uncertain' };
      try {
        const stat = await lstat(directory);
        this.state.pendingCreations.set(id, { digest: identity.digest, dev: stat.dev, ino: stat.ino });
        await this.initialSource(snapshot.document, sourceLocation);
        await this.commit(snapshot, undefined, guard, publication);
        this.state.pendingCreations.delete(id);
        return Object.freeze({ status: 'committed', documentId: id, revision: identity.revision, durability: publication.durability, replayed: false });
      } catch (error) {
        if (publication.published) {
          this.state.pendingCreations.delete(id);
          return Object.freeze({ status: 'committed', documentId: id, revision: identity.revision, durability: 'uncertain', replayed: false });
        }
        try {
          this.options.fault?.('create-cleanup');
          await rm(directory, { recursive: true, force: true });
          this.state.pendingCreations.delete(id);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Document creation failed and cleanup remains pending.');
        }
        throw error;
      }
    });
  }
  readSnapshot(id: string): Promise<DocumentSnapshot> { return this.serial(async () => (await this.committed(id)).snapshot); }
  async read(id: string): Promise<SubtitleDocument> { return (await this.readSnapshot(id)).document; }
  /** Read-only safety inventory. Unlike listSnapshot/committed, inspect both pointers,
   * retain deletion remnants, and never hide an unreadable generation behind fallback. */
  inspectKnowledgeReferences(): Promise<KnowledgeReferenceInventory> {
    return this.serial(async () => {
      const unknown = new Set<string>();
      const references = new Map<string, KnowledgeTaskReference>();
      const recordDigests = new Map<string, string>();
      let files = 0, bytes = 0, records = 0, resources = 0, exhausted = false;
      const limit = () => { exhausted = true; unknown.add('$limit'); throw new StudioError('limit_exceeded'); };
      const names = async (directory: string): Promise<string[]> => {
        await this.assertDirectory(directory);
        const found: string[] = [];
        for await (const entry of await opendir(directory)) {
          if (++files > KNOWLEDGE_REFERENCE_SCAN_LIMITS.files) limit();
          found.push(entry.name);
        }
        return found.sort();
      };
      const read = async (file: string, maxBytes: number): Promise<string> => {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new StudioError('document_unavailable');
        bytes += stat.size;
        if (bytes > KNOWLEDGE_REFERENCE_SCAN_LIMITS.bytes) limit();
        return this.readFile(file, maxBytes);
      };
      const finish = (): KnowledgeReferenceInventory => {
        const items = [...references.values()].sort((a, b) => knowledgeReferenceKey(a) < knowledgeReferenceKey(b) ? -1 : knowledgeReferenceKey(a) > knowledgeReferenceKey(b) ? 1 : 0);
        for (const item of items) item.resources.sort((a, b) => `${a.group}:${a.id}:${a.revision}:${a.digest}` < `${b.group}:${b.id}:${b.revision}:${b.digest}` ? -1 : `${a.group}:${a.id}:${a.revision}:${a.digest}` > `${b.group}:${b.id}:${b.revision}:${b.digest}` ? 1 : 0);
        return { references: items, unknownDocuments: unknown.size, digest: sha256Canonical({ references: items, unknown: [...unknown].sort() }) };
      };
      let rootNames: string[];
      try { rootNames = await names(this.root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unknown.add('$root'); return finish(); }
      const documents = new Set<string>();
      const deleted = new Set<string>();
      for (const name of rootNames) {
        if (name === '.deleted') continue;
        if (idSchema.safeParse(name).success) documents.add(name);
        else unknown.add('$root');
      }
      if (rootNames.includes('.deleted')) {
        try {
          for (const name of await names(path.join(this.root, '.deleted'))) {
            const id = name.replace(/\.json$/, '');
            if (!name.endsWith('.json') || !idSchema.safeParse(id).success) { unknown.add('$deleted'); continue; }
            try {
              const tombstone = deletedDocumentSchema.parse(JSON.parse(await read(path.join(this.root, '.deleted', name), 4096)));
              if (tombstone.documentId !== id) throw new StudioError('invalid_input');
              deleted.add(id);
              // A valid, fully cleaned tombstone contains no execution body. In-memory
              // supplier leases are merged by application composition before purge.
              if (documents.has(id)) unknown.add(id);
            } catch { unknown.add(id); }
            if (exhausted) return finish();
          }
        } catch { unknown.add('$deleted'); }
      }
      const inspectSnapshot = (snapshot: DocumentSnapshot, id: string, current: boolean) => {
        const intent = snapshot.automaticTranslation;
        if (intent?.knowledge !== undefined) {
          if (++records > KNOWLEDGE_REFERENCE_SCAN_LIMITS.records) limit();
          try {
            const frozen = validateFrozenAutomaticKnowledge(intent.knowledge);
            const refs = automaticKnowledgeResourceReferences(frozen);
            resources += refs.length;
            if (resources > KNOWLEDGE_REFERENCE_SCAN_LIMITS.resources) limit();
            const identity = `automatic:${id}:${intent.intentId}`;
            const previousDigest = recordDigests.get(identity);
            if (previousDigest && previousDigest !== frozen.digest) unknown.add(id);
            recordDigests.set(identity, frozen.digest);
            const prior = references.get(identity);
            references.set(identity, { kind: 'automatic_preparation', preparationId: intent.intentId, documentId: id,
              displayName: snapshot.document.origin.displayName,
              status: current && !deleted.has(id) && intent.state === 'pending' ? 'active' : prior?.status ?? 'retained',
              resources: [...new Map([...(prior?.resources ?? []), ...refs].map(ref => [`${ref.group}:${ref.id}:${ref.revision}:${ref.digest}`, ref])).values()] });
          } catch { unknown.add(id); }
          if (exhausted) return;
        }
        const checked = new Map<string, { record: ReturnType<typeof validateExecutionRecord>; digest: string }>();
        for (const [key, raw] of Object.entries(snapshot.executionRecords ?? {})) {
          if (++records > KNOWLEDGE_REFERENCE_SCAN_LIMITS.records) limit();
          try {
            const record = validateExecutionRecord(raw, { documentId: id });
            if (record.id !== key) throw new StudioError('invalid_input');
            const identity = `${id}:${record.id}`;
            const baseDigest = recordBaseDigest(record), previousDigest = recordDigests.get(identity);
            checked.set(key, { record, digest: baseDigest });
            if (previousDigest && previousDigest !== baseDigest) unknown.add(id);
            recordDigests.set(identity, baseDigest);
            const knowledge = (record as typeof record & { knowledge?: unknown }).knowledge;
            if (knowledge === undefined) {
              // Only the shipped ordinary policy establishes that omitted knowledge
              // means no resource references; an unknown policy may have new semantics.
              if (record.policyVersion !== 'studio-translation/2;request-body/1') unknown.add(id);
              continue;
            }
            const refs = knowledgeResourceReferences(validateFrozenKnowledgeSnapshot(knowledge));
            resources += refs.length;
            if (resources > KNOWLEDGE_REFERENCE_SCAN_LIMITS.resources) limit();
            const existing = references.get(identity);
            if (existing) {
              existing.resources = [...new Map([...existing.resources, ...refs].map(ref => [`${ref.group}:${ref.id}:${ref.revision}:${ref.digest}`, ref])).values()];
            } else {
              const task = current && !deleted.has(id) ? snapshot.tasks.find(task => task.id === record.taskId) : undefined;
              references.set(identity, { documentId: id, taskId: record.taskId, trackId: record.trackId, recordId: record.id,
                displayName: snapshot.document.origin.displayName,
                status: task && ['queued', 'running', 'failed', 'interrupted', 'needs_configuration'].includes(task.status) ? 'active' : 'retained', resources: refs });
            }
          } catch { unknown.add(id); }
          if (exhausted) return;
        }
        for (const track of snapshot.document.translationTracks) if (track.executionRef) {
          const found = checked.get(track.executionRef.id);
          if (!found || found.digest !== track.executionRef.digest || found.record.trackId !== track.id) unknown.add(id);
        }
        for (const task of snapshot.tasks) if (task.translation?.checkpoint?.version === 2) {
          const found = checked.get(task.translation.checkpoint.executionRef.id);
          if (!found || found.digest !== task.translation.checkpoint.executionRef.digest || found.record.taskId !== task.id
            || found.record.trackId !== task.trackId || found.record.sourceDigest !== task.translation.checkpoint.sourceDigest) unknown.add(id);
        }
      };
      let documentCount = 0;
      for (const id of [...documents].sort()) {
        if (++documentCount > KNOWLEDGE_REFERENCE_SCAN_LIMITS.documents) { unknown.add('$limit'); break; }
        const directory = this.directory(id);
        try {
          const entries = await names(directory), expected = new Set(['current.json', 'previous.json', SOURCE_LOCATION_FILE]);
          for (const pointerName of ['current.json', 'previous.json']) {
            if (!entries.includes(pointerName)) { if (pointerName === 'current.json') unknown.add(id); continue; }
            try {
              const pointer = pointerSchema.parse(JSON.parse(await read(path.join(directory, pointerName), 1024)));
              const generationName = `${pointer.generation}.json`; expected.add(generationName);
              const json = await read(path.join(directory, generationName), LIMITS.snapshotBytes);
              if (pointer.digest && digest(json) !== pointer.digest) throw new StudioError('invalid_input');
              const snapshot = validateRepositorySnapshot(JSON.parse(json));
              if (snapshot.document.id !== id) throw new StudioError('invalid_input');
              inspectSnapshot(snapshot, id, pointerName === 'current.json');
            } catch { unknown.add(id); }
            if (exhausted) return finish();
          }
          for (const name of entries) {
            if (!expected.has(name)) { unknown.add(id); continue; }
            const stat = await lstat(path.join(directory, name));
            if (!stat.isFile() || stat.isSymbolicLink()) unknown.add(id);
          }
        } catch { unknown.add(id); }
        if (exhausted) break;
      }
      return finish();
    });
  }
  withDocument<T>(id: string, revision: number, action: (document: SubtitleDocument) => Promise<T>) {
    return this.serial(async () => {
      const { snapshot } = await this.committed(id);
      if (snapshot.document.revision !== revision) throw new StudioError('revision_conflict');
      return action(snapshot.document);
    });
  }
  /** Publish already frozen output without rejecting newer translation commits. */
  withExistingDocument<T>(id: string, action: () => Promise<T>) {
    return this.serial(async () => {
      await this.committed(id);
      return action();
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
      const records: { snapshot: DocumentSnapshot; updatedAt: number }[] = [];
      const unavailable: UnavailableDocument[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !idSchema.safeParse(entry.name).success || await this.isDeleted(entry.name)) continue;
        try { const record = await this.committed(entry.name); documents.push(record.snapshot.document); records.push(record); }
        catch (error) {
          // A broken or incompatible document must not disable the whole library or import.
          // Keep its published files untouched; callers still see an explicit recovery warning.
          if (!(error instanceof StudioError) || error.code !== 'document_unavailable') throw error;
          unavailable.push(await this.unavailableInfo(entry.name));
        }
      }
      return { documents, records, unavailable, unavailableDocuments: unavailable.length, sequence: this.state.sequence };
    });
  }
  async list() { return (await this.listSnapshot()).documents; }
  /** A recovery token describes the app-owned directory, never a renderer-provided path. */
  private async unavailableInfo(id: string): Promise<UnavailableDocument> {
    const directory = this.directory(id);
    const state: unknown[] = [];
    const record = async (name: string) => {
      try {
        const stat = await lstat(name ? path.join(directory, name) : directory);
        state.push([name, stat.dev, stat.ino, stat.size, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs, stat.isSymbolicLink()]);
        return stat;
      } catch (error) { state.push([name, (error as NodeJS.ErrnoException).code ?? 'unavailable']); return null; }
    };
    const directoryStat = await record('');
    if (directoryStat?.isDirectory() && !directoryStat.isSymbolicLink()) {
      try { for (const name of (await readdir(directory)).sort()) await record(name); }
      catch (error) { state.push(['entries', (error as NodeJS.ErrnoException).code ?? 'unavailable']); }
    }
    return { id, token: digest(JSON.stringify(state)), directory, reason: 'document_unavailable' };
  }
  private async verifyUnavailable(id: string, token: string) {
    if (await this.isDeleted(id)) throw new StudioError('document_unavailable');
    await this.assertDirectory(this.directory(id));
    let readable = false;
    try { await this.committed(id); readable = true; }
    catch (error) { if (!(error instanceof StudioError) || error.code !== 'document_unavailable') throw error; }
    if (readable) throw new StudioError('revision_conflict');
    const entry = await this.unavailableInfo(id);
    if (entry.token !== token) throw new StudioError('revision_conflict');
    return entry;
  }
  revealUnavailable(id: string, token: string, guard: () => void = () => {}) {
    return this.serial(async () => { const entry = await this.verifyUnavailable(id, token); guard(); return entry.directory; });
  }
  deleteUnavailable(id: string, token: string, guard: () => void = () => {}) {
    return this.serial(async () => {
      await this.verifyUnavailable(id, token);
      const folder = path.join(this.root, '.deleted');
      await mkdir(folder, { recursive: true }); await this.assertDirectory(folder);
      // Unreadable records have no trusted revision. Their tombstone is a distinct lifecycle record.
      await this.publish(this.tombstone(id), JSON.stringify({ schemaVersion: 1, documentId: id, kind: 'unavailable' }), 'delete-publish', guard);
      await this.syncDirectory(folder);
      this.state.sequence++;
      return this.cleanup(id);
    });
  }
  transact(id: string, expectedRevision: number, mutate: (snapshot: DocumentSnapshot) => void, guard: () => void = () => {}): Promise<DocumentSnapshot> {
    return this.serial(async () => {
      const { snapshot, pointer } = await this.committed(id);
      if (snapshot.document.revision !== expectedRevision) throw new StudioError('revision_conflict');
      const priorRecords = new Map(Object.entries(snapshot.executionRecords ?? {}).map(([key, record]) => [key, JSON.stringify(record)]));
      const priorReport = JSON.stringify(snapshot.automaticTranslation?.preparationReport);
      const priorAutomaticState = snapshot.automaticTranslation?.state;
      const result: unknown = mutate(snapshot);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
        throw new StudioError('invalid_input');
      }
      if (snapshot.document.id !== id || snapshot.document.revision !== expectedRevision) throw new StudioError('invalid_input');
      const nextReport = snapshot.automaticTranslation?.preparationReport;
      if (JSON.stringify(nextReport) !== priorReport) {
        // Published reports are immutable, including unreadable historical data.
        // Ordinary document mutations may retain them without revalidation.
        if (priorReport !== undefined || nextReport === undefined || priorAutomaticState !== 'pending') throw new StudioError('invalid_input');
        validateAutomaticKnowledgeReport(nextReport, snapshot, true);
      }
      if (snapshot.executionRecords !== undefined) assertExecutionRecordsSize(snapshot.executionRecords);
      for (const [key, raw] of Object.entries(snapshot.executionRecords ?? {})) {
        const before = priorRecords.get(key);
        if (before === JSON.stringify(raw)) continue;
        const record = validateExecutionRecord(raw, { documentId: id });
        if (record.id !== key) throw new StudioError('invalid_input');
        if (before !== undefined) {
          // Inputs and already-published requests are immutable. Only new batch requests append.
          let previous;
          try { previous = validateExecutionRecord(JSON.parse(before)); } catch { /* Explicit replacement may repair an unreadable record. */ }
          if (previous) {
            if (recordBaseDigest(previous) !== recordBaseDigest(record)) throw new StudioError('invalid_input');
            for (const [batchId, request] of Object.entries(previous.requests)) if (record.requests[batchId]?.digest !== request.digest) throw new StudioError('invalid_input');
          }
        }
      }
      for (const key of priorRecords.keys()) if (!Object.hasOwn(snapshot.executionRecords ?? {}, key) && snapshot.document.translationTracks.some(track => track.executionRef?.id === key)) throw new StudioError('invalid_input');
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
      // Execution provenance belongs to retained translation tracks, not task-list rows.
      if (snapshot.automaticTranslation?.translationTaskId === taskId) snapshot.automaticTranslation.state = 'cancelled';
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
