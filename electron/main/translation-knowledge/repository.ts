import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { KnowledgePackage } from '../../../src/translation-knowledge/schemas';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { canonicalize, sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import { validatePackage } from '../../../src/translation-knowledge/validation';
import { diagnostic, KnowledgeServiceError } from './errors';
import { changeSetSchema, maintenanceCommitSchema, purgeJournalSchema, type HistoryFile, type ImportChangeSet, type StoredMaintenanceCommit } from './maintenance-storage';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receiptSchema = z.strictObject({ id: z.uuid(), packageName: z.string(), createdAt: z.iso.datetime(), added: integer, updated: integer, skipped: integer, adopted: integer, generation: integer });
const approvalSchema = z.strictObject({ revision: integer.positive(), digest: digestSchema, method: z.enum(['human', 'trusted_import']), approvedAt: z.iso.datetime() });
const committedSchema = z.strictObject({ ownerDigest: digestSchema, requestDigest: digestSchema, packageDigest: digestSchema, receiptId: z.uuid() });
const stateSchema = z.strictObject({ format: z.union([z.literal(1), z.literal(2)]), generation: integer, data: z.unknown(), approvals: z.record(z.uuid(), approvalSchema), imports: z.array(receiptSchema), commits: z.record(z.uuid(), committedSchema), importedOriginal: z.unknown().optional(), importChanges: z.record(z.uuid(), changeSetSchema).optional(), maintenanceCommits: z.record(z.uuid(), maintenanceCommitSchema).optional(), undoneImportIds: z.array(z.uuid()).optional(), purgeOperationId: z.uuid().optional(), cleanupPending: z.boolean().optional() });
const pointerBase = { version: z.literal(1), generation: integer, file: z.string().regex(/^generation-\d+-[a-f0-9-]{36}\.json$/), digest: digestSchema };
const pointerSchema = z.strictObject({ ...pointerBase, previous: z.strictObject(pointerBase).optional() });
type Pointer = z.infer<typeof pointerSchema>;
export interface StoredLibrary extends LibrarySnapshot {
  format: 2;
  commits: Record<string, z.infer<typeof committedSchema>>;
  /** The exact imported package is retained in that immutable generation for provenance. */
  importedOriginal?: KnowledgePackage;
  importChanges: Record<string, ImportChangeSet>;
  maintenanceCommits: Record<string, StoredMaintenanceCommit>;
  undoneImportIds: string[];
  purgeOperationId?: string;
  cleanupPending: boolean;
}
export type PublicationStage = 'generation_synced' | 'generation_directory_synced' | 'before_pointer_rename' | 'pointer_renamed' | 'pointer_directory_synced' | 'purge_journal_synced' | 'before_history_unlink' | 'history_unlinked' | 'purge_cleanup_synced';
export interface RepositoryOptions {
  /** Fault injection for the real filesystem publication protocol, never exposed over IPC. */
  publicationHook?: (stage: PublicationStage) => void | Promise<void>;
}
const roots = new Set<string>();
const JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
const byteDigest = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export function emptyPackage(): KnowledgePackage {
  return { format: 'fusionkit.translation-knowledge', schemaVersion: 1, package: { id: randomUUID(), revision: 1, name: 'Translation knowledge', description: '', purpose: 'backup', createdAt: new Date().toISOString(), generator: { name: 'FusionKit', version: '0.3.1' } }, subjects: [], collections: [], sources: [], entries: [], styles: [], recipes: [], preferenceTemplates: [] };
}

function validateStored(input: unknown): StoredLibrary {
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('STORAGE_FORMAT', 'The knowledge library metadata is invalid; existing files have been preserved.')]);
  const checked = validatePackage(parsed.data.data);
  if (!checked.valid || !checked.data) throw new KnowledgeServiceError('storage_unavailable', checked.errors);
  if (parsed.data.importedOriginal !== undefined) {
    const original = validatePackage(parsed.data.importedOriginal);
    if (!original.valid) throw new KnowledgeServiceError('storage_unavailable', original.errors);
  }
  const state: StoredLibrary = { ...parsed.data, format: 2, data: checked.data, importChanges: parsed.data.importChanges ?? {}, maintenanceCommits: parsed.data.maintenanceCommits ?? {}, undoneImportIds: parsed.data.undoneImportIds ?? [], cleanupPending: parsed.data.cleanupPending ?? false } as StoredLibrary;
  const entriesById = new Map(state.data.entries.map(entry => [entry.id, entry]));
  for (const [id, approval] of Object.entries(state.approvals)) {
    const entry = entriesById.get(id);
    if (!entry || entry.state !== 'ready' || entry.revision !== approval.revision || sha256Canonical(entry) !== approval.digest) {
      throw new KnowledgeServiceError('storage_unavailable', [diagnostic('APPROVAL_MISMATCH', 'A stored approval does not match its exact entry version.')]);
    }
  }
  const receiptIds = new Set(state.imports.map(item => item.id));
  const receiptsById = new Map(state.imports.map(item => [item.id, item]));
  if (receiptIds.size !== state.imports.length || state.imports.some(item => item.generation > state.generation) || Object.entries(state.commits).some(([id, value]) => value.receiptId !== id || !receiptIds.has(id)) || state.imports.some(item => !state.commits[item.id])) {
    throw new KnowledgeServiceError('storage_unavailable', [diagnostic('IMPORT_RECEIPT_MISMATCH', 'Stored import identities and receipts are inconsistent.')]);
  }
  for (const [id, changeSet] of Object.entries(state.importChanges)) {
    if (changeSet.id !== id || !receiptIds.has(id) || changeSet.generation !== receiptsById.get(id)?.generation || new Set(changeSet.changes.map(item => item.id)).size !== changeSet.changes.length || changeSet.changes.some(item => item.before && item.before.id !== item.id)) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('IMPORT_CHANGESET_MISMATCH', 'Stored import changes do not match their receipt identity.')]);
  }
  if (new Set(state.undoneImportIds).size !== state.undoneImportIds.length || state.undoneImportIds.some(id => !receiptIds.has(id)) || Object.entries(state.maintenanceCommits).some(([id, item]) => id !== item.receipt.id || item.receipt.generation > state.generation)) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('MAINTENANCE_RECEIPT_MISMATCH', 'Stored maintenance identities are inconsistent.')]);
  return state;
}

/** One main-process owner per canonical root; all reads and publications join one queue. */
export class KnowledgeRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private root?: string;
  private closed = false;
  private initialized = false;
  private cleanupPending = false;
  constructor(private readonly requestedRoot: string, private readonly options: RepositoryOptions = {}) {}

  async read(): Promise<StoredLibrary> {
    return this.serial(async () => { await this.initialize(); await this.recoverPurge(); return this.load(); });
  }

  async historyInventory(): Promise<HistoryFile[]> { return this.serial(async () => { await this.initialize(); await this.recoverPurge(); return this.historyFiles(); }); }

  async transact<T>(operation: (state: StoredLibrary) => { state?: StoredLibrary; result: (published: StoredLibrary) => T; purgeOperationId?: string }, guard?: () => void): Promise<T> {
    return this.serial(async () => {
      await this.initialize();
      await this.recoverPurge();
      const current = await this.load();
      guard?.();
      const transaction = operation(structuredClone(current));
      if (!transaction.state) {
        // A replay may follow a previously published but unconfirmed import.
        // Reconfirm directory durability before returning its existing receipt.
        try { await this.syncDirectory(); }
        catch { throw new KnowledgeServiceError('write_failed', [diagnostic('PUBLICATION_UNCERTAIN', 'The saved generation is readable, but its durability still could not be confirmed.')]); }
        return transaction.result(current);
      }
      if (this.cleanupPending) throw new KnowledgeServiceError('write_failed', [diagnostic('PURGE_CLEANUP_PENDING', 'History cleanup must finish before changing the library. Reload to retry cleanup.')]);
      transaction.state.generation = current.generation + 1;
      transaction.state.data.package.revision = transaction.state.generation + 1;
      transaction.state.data.package.createdAt = new Date().toISOString();
      transaction.state.cleanupPending = Boolean(transaction.purgeOperationId);
      await this.publish(validateStored(transaction.state), guard, transaction.purgeOperationId);
      if (transaction.purgeOperationId) await this.recoverPurge();
      transaction.state.cleanupPending = this.cleanupPending;
      return transaction.result(transaction.state);
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.queue;
    if (this.root) roots.delete(this.root);
    this.root = undefined;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new KnowledgeServiceError('storage_unavailable'));
    const pending = this.queue.then(async () => {
      if (this.closed) throw new KnowledgeServiceError('storage_unavailable');
      try { return await operation(); }
      catch (error) {
        if (error instanceof KnowledgeServiceError) throw error;
        throw new KnowledgeServiceError('storage_unavailable', [diagnostic('STORAGE_IO', 'The knowledge library could not be read. Existing files have been preserved.')]);
      }
    });
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.root) {
      await fs.mkdir(this.requestedRoot, { recursive: true, mode: 0o700 });
      const canonical = await fs.realpath(this.requestedRoot);
      if (roots.has(canonical)) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('LIBRARY_BUSY', 'The knowledge library already has an active owner.')]);
      roots.add(canonical);
      this.root = canonical;
    }
    try { await fs.lstat(path.join(this.root, 'current.json')); }
    catch (error) {
      if (!isMissing(error)) throw error;
      const files = await fs.readdir(this.root);
      if (files.some(name => !name.startsWith('.pending-'))) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('CURRENT_MISSING', 'The library pointer is missing while library files exist. Restore or inspect the preserved files before continuing.')]);
      await this.publish({ format: 2, generation: 0, data: emptyPackage(), approvals: {}, imports: [], commits: {}, importChanges: {}, maintenanceCommits: {}, undoneImportIds: [], cleanupPending: false });
    }
    await this.load();
    this.initialized = true;
  }

  private async readPointer(): Promise<Pointer> {
    const text = await this.readRegular(path.join(this.root!, 'current.json'), 4096);
    const parsed = pointerSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('CURRENT_CORRUPT', 'The knowledge library pointer is invalid. Previous generations remain available for recovery.')]);
    return parsed.data;
  }

  private async load(): Promise<StoredLibrary> {
    const pointer = await this.readPointer();
    const bytes = await this.readRegular(path.join(this.root!, pointer.file), 256 * 1024 * 1024);
    if (byteDigest(bytes) !== pointer.digest) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('GENERATION_DIGEST', 'The current knowledge generation failed its integrity check. No data was replaced.')]);
    const state = validateStored(JSON.parse(bytes));
    if (state.generation !== pointer.generation) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('GENERATION_MISMATCH', 'The current pointer and knowledge generation disagree.')]);
    state.cleanupPending = this.cleanupPending;
    return state;
  }

  private async readRegular(file: string, maxBytes: number): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.readBinaryRegular(file, maxBytes));
  }

  private async readBinaryRegular(file: string, maxBytes: number): Promise<Buffer> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('STORAGE_FILE', 'A knowledge library file has an unexpected type or size.')]);
    return fs.readFile(file);
  }

  private async writeSynced(file: string, bytes: string, created?: () => void): Promise<void> {
    const handle = await fs.open(file, 'wx', 0o600);
    created?.();
    try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }

  private async syncDirectory(): Promise<void> {
    let handle;
    try { handle = await fs.open(this.root!, 'r'); await handle.sync(); }
    catch (error) {
      // Windows does not expose a portable directory-fsync primitive in Node. Both
      // files are flushed; replacement still uses one rename and is never delete+move.
      if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error;
    } finally { await handle?.close(); }
  }

  private async publish(state: StoredLibrary, guard?: () => void, purgeOperationId?: string): Promise<void> {
    const identity = randomUUID();
    const generationFile = `generation-${state.generation}-${identity}.json`;
    const pendingFile = path.join(this.root!, `.pending-${identity}.json`);
    const fullGenerationFile = path.join(this.root!, generationFile);
    let published = false;
    let generationCreated = false;
    const journalFile = purgeOperationId ? path.join(this.root!, `purge-${purgeOperationId}.json`) : undefined;
    const pendingJournalFile = purgeOperationId ? path.join(this.root!, `.pending-purge-${purgeOperationId}.json`) : undefined;
    let journalCreated = false;
    let pendingJournalCreated = false;
    try {
      const bytes = canonicalize(state);
      if (Buffer.byteLength(bytes) > 256 * 1024 * 1024) throw new KnowledgeServiceError('limit_exceeded');
      let previous: Pointer | undefined;
      try { previous = await this.readPointer(); } catch (error) { if (!isMissing(error)) throw error; }
      const history = purgeOperationId ? await this.historyFiles() : [];
      const pointer: Pointer = { version: 1, generation: state.generation, file: generationFile, digest: byteDigest(bytes), ...(previous && !purgeOperationId ? { previous: { version: 1, generation: previous.generation, file: previous.file, digest: previous.digest } } : {}) };
      const journalBytes = purgeOperationId ? canonicalize({ format: 1, id: purgeOperationId, generation: state.generation, target: { name: generationFile, digest: pointer.digest }, files: history }) : undefined;
      if (journalBytes && Buffer.byteLength(journalBytes) > JOURNAL_MAX_BYTES) throw new KnowledgeServiceError('limit_exceeded', [diagnostic('PURGE_JOURNAL_LIMIT', 'This library has too many historical files for one supported cleanup operation. No history was removed.')]);
      await this.writeSynced(fullGenerationFile, bytes, () => { generationCreated = true; });
      await this.options.publicationHook?.('generation_synced');
      await this.syncDirectory();
      await this.options.publicationHook?.('generation_directory_synced');
      if (journalFile && pendingJournalFile && journalBytes) {
        await this.writeSynced(pendingJournalFile, journalBytes, () => { pendingJournalCreated = true; });
        await fs.rename(pendingJournalFile, journalFile);
        pendingJournalCreated = false; journalCreated = true;
        await this.syncDirectory();
        await this.options.publicationHook?.('purge_journal_synced');
      }
      await this.writeSynced(pendingFile, JSON.stringify(pointer));
      await this.options.publicationHook?.('before_pointer_rename');
      guard?.();
      await fs.rename(pendingFile, path.join(this.root!, 'current.json'));
      published = true;
      if (purgeOperationId) this.cleanupPending = true;
      await this.options.publicationHook?.('pointer_renamed');
      await this.syncDirectory();
      await this.options.publicationHook?.('pointer_directory_synced');
    } catch (error) {
      if (published) throw new KnowledgeServiceError('write_failed', [diagnostic('PUBLICATION_UNCERTAIN', 'The new generation was published, but durability confirmation failed. Reload the library; retrying this import will use its existing receipt.')]);
      // Only files created by this attempt may be removed. Old generations and
      // every already-published generation are immutable and always retained.
      await fs.unlink(pendingFile).catch(() => undefined);
      if (generationCreated) await fs.unlink(fullGenerationFile).catch(() => undefined);
      if (journalCreated && journalFile) await fs.unlink(journalFile).catch(() => undefined);
      if (pendingJournalCreated && pendingJournalFile) await fs.unlink(pendingJournalFile).catch(() => undefined);
      if (error instanceof KnowledgeServiceError) throw error;
      throw new KnowledgeServiceError('write_failed', [diagnostic('PUBLICATION_FAILED', 'The knowledge update was not published. The previous generation is unchanged.')]);
    }
  }

  private async historyFiles(): Promise<HistoryFile[]> {
    const files: HistoryFile[] = [];
    for (const name of await fs.readdir(this.root!)) {
      if (name === 'current.json') continue;
      if (!/^(?:generation-\d+-[a-f0-9-]{36}|\.pending-(?:purge-)?[a-f0-9-]{36})\.json$/.test(name)) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('HISTORY_UNKNOWN_FILE', 'The library contains an unexpected file. Resolve it before permanently clearing history.')]);
      const bytes = await this.readBinaryRegular(path.join(this.root!, name), 256 * 1024 * 1024);
      files.push({ name, digest: byteDigest(bytes) });
    }
    return files;
  }

  /** A published purge is completed without consulting a renderer or revocable owner. */
  private async recoverPurge(): Promise<void> {
    const journals = (await fs.readdir(this.root!)).filter(name => /^purge-[a-f0-9-]{36}\.json$/.test(name));
    if (!journals.length) {
      if (this.cleanupPending) { try { await this.syncDirectory(); } catch { return; } }
      this.cleanupPending = false; return;
    }
    if (journals.length !== 1) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('PURGE_JOURNAL_AMBIGUOUS', 'Multiple history cleanup journals require inspection before continuing.')]);
    const journalPath = path.join(this.root!, journals[0]);
    const parsed = purgeJournalSchema.safeParse(JSON.parse(await this.readRegular(journalPath, JOURNAL_MAX_BYTES)));
    if (!parsed.success || journals[0] !== `purge-${parsed.data.id}.json` || new Set(parsed.data.files.map(item => item.name)).size !== parsed.data.files.length || parsed.data.files.some(item => item.name === parsed.data.target.name)) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('PURGE_JOURNAL_INVALID', 'The history cleanup journal failed validation; no files were removed.')]);
    const journal = parsed.data;
    const pointer = await this.readPointer();
    if (pointer.file !== journal.target.name || pointer.digest !== journal.target.digest) {
      if (pointer.generation >= journal.generation) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('PURGE_PUBLICATION_MISMATCH', 'History cleanup cannot identify its published generation.')]);
      // The pointer never switched: discard only the matching staged generation.
      await this.unlinkVerified(journal.target);
      await fs.unlink(journalPath); await this.syncDirectory(); this.cleanupPending = false; return;
    }
    const state = await this.load();
    if (state.purgeOperationId !== journal.id || state.generation !== journal.generation || pointer.previous) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('PURGE_STATE_MISMATCH', 'The published generation does not authorize this cleanup journal.')]);
    this.cleanupPending = true;
    try {
      const started = Date.now();
      let removed = 0;
      for (const file of journal.files) {
        await this.options.publicationHook?.('before_history_unlink');
        if (await this.unlinkVerified(file)) removed++;
        await this.options.publicationHook?.('history_unlinked');
        if (removed >= 128 || removed > 0 && Date.now() - started > 1500) { await this.syncDirectory(); return; }
      }
      await this.syncDirectory();
      await this.options.publicationHook?.('purge_cleanup_synced');
      await fs.unlink(journalPath);
      await this.syncDirectory();
      this.cleanupPending = false;
    } catch {
      // The sanitized current generation is usable; writing remains fenced until
      // every exact historical file has been removed and the directory synced.
      this.cleanupPending = true;
    }
  }

  private async unlinkVerified(file: HistoryFile): Promise<boolean> {
    const fullPath = path.join(this.root!, file.name);
    let bytes: Buffer;
    try { bytes = await this.readBinaryRegular(fullPath, 256 * 1024 * 1024); }
    catch (error) { if (isMissing(error)) return false; throw error; }
    if (byteDigest(bytes) !== file.digest) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('PURGE_FILE_CHANGED', 'A history file changed after cleanup was planned. It was not removed.')]);
    await fs.unlink(fullPath);
    return true;
  }
}
