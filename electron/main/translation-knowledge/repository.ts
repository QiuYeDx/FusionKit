import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SCHEMA_VERSION, type KnowledgePackage } from '../../../src/translation-knowledge/schemas';
import { canonicalize } from '../../../src/translation-knowledge/canonicalize';
import { validatePackage } from '../../../src/translation-knowledge/validation';
import { diagnostic, KnowledgeServiceError } from './errors';

/** The pointer version identifies the whole storage layout. */
export const STORAGE_POINTER_VERSION = 2;
export const RETAINED_GENERATIONS = 20;
export const ARCHIVE_DIRECTORY = 'archive';
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const GENERATION_FILE = /^generation-(\d+)-[a-f0-9-]{36}\.json$/;
const stateSchema = z.strictObject({ format: z.literal(3), generation: integer, data: z.unknown() });
const pointerSchema = z.strictObject({ version: z.literal(STORAGE_POINTER_VERSION), generation: integer, file: z.string().regex(GENERATION_FILE), digest: digestSchema });
type Pointer = z.infer<typeof pointerSchema>;
export interface StoredLibrary { format: 3; generation: number; data: KnowledgePackage }
export type PublicationStage = 'generation_synced' | 'generation_directory_synced' | 'before_pointer_rename' | 'pointer_renamed' | 'pointer_directory_synced';
export interface RepositoryOptions {
  /** Fault injection for the real filesystem publication protocol, never exposed over IPC. */
  publicationHook?: (stage: PublicationStage) => void | Promise<void>;
  /** Fault injection before each file is moved into an archive. */
  archiveHook?: (name: string) => void | Promise<void>;
  /** Archive folder names are timestamps; tests may pin them. */
  now?: () => Date;
}
const roots = new Set<string>();
const byteDigest = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const archiveStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function emptyPackage(): KnowledgePackage {
  return { format: 'fusionkit.translation-knowledge', schemaVersion: SCHEMA_VERSION, package: { id: randomUUID(), revision: 1, name: 'Translation knowledge', description: '', createdAt: new Date().toISOString(), generator: { name: 'FusionKit' } }, collections: [], entries: [], presets: [] };
}

function validateStored(input: unknown): StoredLibrary {
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('STORAGE_FORMAT', 'The knowledge library metadata is invalid; existing files have been preserved.')]);
  const checked = validatePackage(parsed.data.data);
  if (!checked.valid || !checked.data) throw new KnowledgeServiceError('storage_unavailable', checked.errors);
  return { format: 3, generation: parsed.data.generation, data: checked.data };
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
      if (!transaction.state) return transaction.result(current);
      transaction.state.generation = current.generation + 1;
      transaction.state.data.package.revision = transaction.state.generation + 1;
      transaction.state.data.package.createdAt = new Date().toISOString();
      const published = validateStored(transaction.state);
      await this.publish(published, guard);
      await this.pruneGenerations();
      return transaction.result(published);
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
    let version: unknown;
    try { version = this.pointerVersion(await this.readRegular(path.join(this.root, 'current.json'), 64 * 1024)); }
    catch (error) {
      if (!isMissing(error)) throw error;
      const files = (await fs.readdir(this.root)).filter(name => name !== ARCHIVE_DIRECTORY && !name.startsWith('.pending-'));
      if (files.length) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('CURRENT_MISSING', 'The library pointer is missing while library files exist. Restore or inspect the preserved files before continuing.')]);
      await this.publishEmpty();
      version = STORAGE_POINTER_VERSION;
    }
    if (version !== STORAGE_POINTER_VERSION) {
      await this.archive();
      await this.publishEmpty();
    }
    await this.load();
    this.initialized = true;
  }

  /** Only the layout version is read; another layout's content is never interpreted. */
  private pointerVersion(text: string): unknown {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new KnowledgeServiceError('storage_unavailable', [diagnostic('CURRENT_CORRUPT', 'The knowledge library pointer is unreadable. Existing files have been preserved.')]); }
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as { version?: unknown }).version : undefined;
  }

  /** Moves a library stored in another layout aside, unchanged, so a fresh library can start. */
  private async archive(): Promise<void> {
    const destination = path.join(this.root!, ARCHIVE_DIRECTORY, archiveStamp(this.options.now?.() ?? new Date()));
    await fs.mkdir(destination, { recursive: true });
    // The pointer moves last: an interrupted archive is still recognized as another layout next time.
    const names = (await fs.readdir(this.root!)).filter(name => name !== ARCHIVE_DIRECTORY).sort((a, b) => Number(a === 'current.json') - Number(b === 'current.json'));
    try {
      for (const name of names) {
        await this.options.archiveHook?.(name);
        await fs.rename(path.join(this.root!, name), path.join(destination, name));
      }
    } catch {
      throw new KnowledgeServiceError('storage_unavailable', [diagnostic('ARCHIVE_FAILED', 'The previous knowledge library could not be moved into the archive folder. Files already moved remain there; the rest are unchanged.')]);
    }
  }

  private async publishEmpty(): Promise<void> {
    await this.publish({ format: 3, generation: 0, data: emptyPackage() });
  }

  private async readPointer(): Promise<Pointer> {
    const text = await this.readRegular(path.join(this.root!, 'current.json'), 64 * 1024);
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = undefined; }
    const parsed = pointerSchema.safeParse(value);
    if (!parsed.success) throw new KnowledgeServiceError('storage_unavailable', [diagnostic('CURRENT_CORRUPT', 'The knowledge library pointer is invalid. Recent generations remain available for recovery.')]);
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
      const pointer: Pointer = { version: STORAGE_POINTER_VERSION, generation: state.generation, file: generationFile, digest: byteDigest(bytes) };
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
      if (published) throw new KnowledgeServiceError('write_failed', [diagnostic('PUBLICATION_UNCERTAIN', 'The new generation was published, but durability confirmation failed. Reload the library before retrying.')]);
      // Only files created by this attempt may be removed; published generations stay.
      await fs.unlink(pendingFile).catch(() => undefined);
      if (generationCreated) await fs.unlink(fullGenerationFile).catch(() => undefined);
      if (error instanceof KnowledgeServiceError) throw error;
      throw new KnowledgeServiceError('write_failed', [diagnostic('PUBLICATION_FAILED', 'The knowledge update was not published. The previous generation is unchanged.')]);
    }
  }

  /** Keeps the most recent generations for recovery; failures only postpone the cleanup. */
  private async pruneGenerations(): Promise<void> {
    try {
      const current = (await this.readPointer()).file;
      const generations = (await fs.readdir(this.root!)).flatMap(name => {
        const match = GENERATION_FILE.exec(name);
        return match ? [{ name, generation: Number(match[1]) }] : [];
      }).sort((a, b) => b.generation - a.generation);
      for (const { name } of generations.slice(RETAINED_GENERATIONS)) {
        if (name === current) continue;
        const file = path.join(this.root!, name);
        const stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(file);
      }
    } catch (error) {
      console.warn('[translation-knowledge] Older generations could not be removed yet.', error);
    }
  }
}
