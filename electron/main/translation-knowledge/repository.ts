import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { KnowledgePackage } from '../../../src/translation-knowledge/schemas';
import type { LibrarySnapshot } from '../../../src/translation-knowledge/ipc-contract';
import { canonicalize, sha256Canonical } from '../../../src/translation-knowledge/canonicalize';
import { validatePackage } from '../../../src/translation-knowledge/validation';
import { diagnostic, KnowledgeServiceError } from './errors';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receiptSchema = z.strictObject({ id: z.uuid(), packageName: z.string(), createdAt: z.iso.datetime(), added: integer, updated: integer, skipped: integer, adopted: integer, generation: integer });
const approvalSchema = z.strictObject({ revision: integer.positive(), digest: digestSchema, method: z.enum(['human', 'trusted_import']), approvedAt: z.iso.datetime() });
const committedSchema = z.strictObject({ ownerDigest: digestSchema, requestDigest: digestSchema, packageDigest: digestSchema, receiptId: z.uuid() });
const stateSchema = z.strictObject({ format: z.literal(1), generation: integer, data: z.unknown(), approvals: z.record(z.uuid(), approvalSchema), imports: z.array(receiptSchema), commits: z.record(z.uuid(), committedSchema), importedOriginal: z.unknown().optional() });
const pointerBase = { version: z.literal(1), generation: integer, file: z.string().regex(/^generation-\d+-[a-f0-9-]{36}\.json$/), digest: digestSchema };
const pointerSchema = z.strictObject({ ...pointerBase, previous: z.strictObject(pointerBase).optional() });
type Pointer = z.infer<typeof pointerSchema>;
export interface StoredLibrary extends LibrarySnapshot {
  format: 1;
  commits: Record<string, z.infer<typeof committedSchema>>;
  /** The exact imported package is retained in that immutable generation for provenance. */
  importedOriginal?: KnowledgePackage;
}
export type PublicationStage = 'generation_synced' | 'generation_directory_synced' | 'before_pointer_rename' | 'pointer_renamed' | 'pointer_directory_synced';
export interface RepositoryOptions {
  /** Fault injection for the real filesystem publication protocol, never exposed over IPC. */
  publicationHook?: (stage: PublicationStage) => void | Promise<void>;
}
const roots = new Set<string>();
const byteDigest = (text: string) => createHash('sha256').update(text).digest('hex');
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
  const state = { ...parsed.data, data: checked.data } as StoredLibrary;
  for (const [id, approval] of Object.entries(state.approvals)) {
    const entry = state.data.entries.find(item => item.id === id);
    if (!entry || entry.state !== 'ready' || entry.revision !== approval.revision || sha256Canonical(entry) !== approval.digest) {
      throw new KnowledgeServiceError('storage_unavailable', [diagnostic('APPROVAL_MISMATCH', 'A stored approval does not match its exact entry version.')]);
    }
  }
  const receiptIds = new Set(state.imports.map(item => item.id));
  if (receiptIds.size !== state.imports.length || state.imports.some(item => item.generation > state.generation) || Object.entries(state.commits).some(([id, value]) => value.receiptId !== id || !receiptIds.has(id)) || state.imports.some(item => !state.commits[item.id])) {
    throw new KnowledgeServiceError('storage_unavailable', [diagnostic('IMPORT_RECEIPT_MISMATCH', 'Stored import identities and receipts are inconsistent.')]);
  }
  return state;
}

/** One main-process owner per canonical root; all reads and publications join one queue. */
export class KnowledgeRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private root?: string;
  private closed = false;
  private initialized = false;
  constructor(private readonly requestedRoot: string, private readonly options: RepositoryOptions = {}) {}

  async read(): Promise<StoredLibrary> {
    return this.serial(async () => { await this.initialize(); return this.load(); });
  }

  async transact<T>(operation: (state: StoredLibrary) => { state?: StoredLibrary; result: (published: StoredLibrary) => T }, guard?: () => void): Promise<T> {
    return this.serial(async () => {
      await this.initialize();
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
      transaction.state.generation = current.generation + 1;
      transaction.state.data.package.revision = transaction.state.generation + 1;
      transaction.state.data.package.createdAt = new Date().toISOString();
      await this.publish(validateStored(transaction.state), guard);
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
      await this.publish({ format: 1, generation: 0, data: emptyPackage(), approvals: {}, imports: [], commits: {} });
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
    return state;
  }

  private async readRegular(file: string, maxBytes: number): Promise<string> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('STORAGE_FILE', 'A knowledge library file has an unexpected type or size.')]);
    return new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file));
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

  private async publish(state: StoredLibrary, guard?: () => void): Promise<void> {
    const identity = randomUUID();
    const generationFile = `generation-${state.generation}-${identity}.json`;
    const pendingFile = path.join(this.root!, `.pending-${identity}.json`);
    const fullGenerationFile = path.join(this.root!, generationFile);
    let published = false;
    let generationCreated = false;
    try {
      const bytes = canonicalize(state);
      if (Buffer.byteLength(bytes) > 256 * 1024 * 1024) throw new KnowledgeServiceError('limit_exceeded');
      let previous: Pointer | undefined;
      try { previous = await this.readPointer(); } catch (error) { if (!isMissing(error)) throw error; }
      const pointer: Pointer = { version: 1, generation: state.generation, file: generationFile, digest: byteDigest(bytes), ...(previous ? { previous: { version: 1, generation: previous.generation, file: previous.file, digest: previous.digest } } : {}) };
      await this.writeSynced(fullGenerationFile, bytes, () => { generationCreated = true; });
      await this.options.publicationHook?.('generation_synced');
      await this.syncDirectory();
      await this.options.publicationHook?.('generation_directory_synced');
      await this.writeSynced(pendingFile, JSON.stringify(pointer));
      await this.options.publicationHook?.('before_pointer_rename');
      guard?.();
      await fs.rename(pendingFile, path.join(this.root!, 'current.json'));
      published = true;
      await this.options.publicationHook?.('pointer_renamed');
      await this.syncDirectory();
      await this.options.publicationHook?.('pointer_directory_synced');
    } catch (error) {
      if (published) throw new KnowledgeServiceError('write_failed', [diagnostic('PUBLICATION_UNCERTAIN', 'The new generation was published, but durability confirmation failed. Reload the library; retrying this import will use its existing receipt.')]);
      // Only files created by this attempt may be removed. Old generations and
      // every already-published generation are immutable and always retained.
      await fs.unlink(pendingFile).catch(() => undefined);
      if (generationCreated) await fs.unlink(fullGenerationFile).catch(() => undefined);
      if (error instanceof KnowledgeServiceError) throw error;
      throw new KnowledgeServiceError('write_failed', [diagnostic('PUBLICATION_FAILED', 'The knowledge update was not published. The previous generation is unchanged.')]);
    }
  }
}
