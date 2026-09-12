import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface SpeechMigrationFile {
  readonly relativePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  /** Fixed catalog metadata only. Large resource payloads are never copied. */
  readonly contents?: Uint8Array;
}
export type SpeechMigrationSourceRoot = 'local-subtitle' | 'subtitle-studio/transcription';
export interface SpeechMigrationSource {
  readonly root: SpeechMigrationSourceRoot;
  readonly relativeDirectory: string;
  readonly files: readonly SpeechMigrationFile[];
}
export interface SpeechMigrationResource {
  readonly id: string;
  readonly relativeDirectory: string;
  readonly files: readonly SpeechMigrationFile[];
  readonly sources: readonly SpeechMigrationSource[];
}
export interface SpeechMigrationIssue {
  readonly code: 'invalid_source' | 'target_conflict' | 'cross_device' | 'recovery_required'
    | 'cleanup_pending' | 'migration_failed' | 'cancelled' | 'invalid_root' | 'unknown_transaction';
  readonly resourceId?: string;
  readonly sourceRoot?: SpeechMigrationSourceRoot;
  readonly message: string;
}
export interface SpeechResourceMigrationResult {
  readonly resources: readonly {
    readonly id: string;
    readonly status: 'ready' | 'missing' | 'blocked';
    readonly migratedFrom?: SpeechMigrationSourceRoot;
    readonly deduplicatedSources: readonly SpeechMigrationSourceRoot[];
    readonly issues: readonly SpeechMigrationIssue[];
  }[];
  readonly issues: readonly SpeechMigrationIssue[];
  readonly cleanupPending: boolean;
}
export interface SpeechMigrationCheckpoint {
  readonly event: string;
  readonly resourceId: string;
  readonly transactionId?: string;
  readonly sourceRoot?: SpeechMigrationSourceRoot;
}
export interface MigrateSpeechResourcesOptions {
  readonly userDataRoot: string;
  readonly sharedRoot: string;
  readonly resources: readonly SpeechMigrationResource[];
  readonly signal?: AbortSignal;
  /** Fault-injection observation; never replaces verification or filesystem operations. */
  readonly hooks?: { readonly checkpoint?: (point: SpeechMigrationCheckpoint) => void | Promise<void> };
}

type Identity = { dev: string; ino: string };
type Observation = { identity: Identity; size: number; mtime: string; ctime: string };
type Tree = { root: Identity; files: Map<string, Observation>; directories: Map<string, Identity> };
type Journal = {
  version: 1; transactionId: string; resourceId: string; fingerprint: string; sourceIndex: number;
  mode: 'adopt' | 'deduplicate'; state: 'prepared' | 'deleting';
  transactionIdentity: Identity; sourceIdentity: Identity; targetIdentity: Identity | null;
};
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const active = new Map<string, Promise<SpeechResourceMigrationResult>>();
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const identity = (stats: { dev: bigint; ino: bigint }): Identity => ({ dev: String(stats.dev), ino: String(stats.ino) });
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const issueMessages = {
  invalid_source: 'An existing resource does not match its fixed installation contract; it was preserved.',
  target_conflict: 'The shared resource destination is not a verified compatible installation; it was preserved.',
  cross_device: 'The existing resource is on another volume; automatic migration did not copy or delete it.',
  recovery_required: 'A resource migration needs recovery before this resource can be used.',
  cleanup_pending: 'Verified resource bytes are retained, but old-copy cleanup still needs to complete.',
  migration_failed: 'Local resource migration did not complete; existing bytes were retained.',
  cancelled: 'Local resource migration was interrupted; existing bytes were retained.',
  invalid_root: 'A resource directory could not be bound to its expected private location.',
  unknown_transaction: 'Unrecognized migration entries were preserved for inspection.',
} as const;
class MigrationFailure extends Error {
  constructor(readonly code: SpeechMigrationIssue['code']) { super(issueMessages[code]); }
}

/** Call before either transcription domain initializes resource consumers or startup cleaners. */
export function migrateSpeechResources(options: MigrateSpeechResourcesOptions): Promise<SpeechResourceMigrationResult> {
  const normalized = validateOptions(options);
  const existing = active.get(normalized.sharedRoot);
  if (existing) return existing;
  const operation = Promise.resolve().then(() => migrate(normalized));
  active.set(normalized.sharedRoot, operation);
  void operation.finally(() => { if (active.get(normalized.sharedRoot) === operation) active.delete(normalized.sharedRoot); }).catch(() => {});
  return operation;
}

async function migrate(options: MigrateSpeechResourcesOptions): Promise<SpeechResourceMigrationResult> {
  const issues: SpeechMigrationIssue[] = [];
  const results: Array<SpeechResourceMigrationResult['resources'][number]> = [];
  const migrationRoot = path.join(options.sharedRoot, '.migration');
  let sharedIdentity: Identity;
  let migrationIdentity: Identity;
  try {
    await assertDirectoryChain(options.userDataRoot);
    await ensureDirectory(options.sharedRoot);
    sharedIdentity = await directoryIdentity(options.sharedRoot);
    await ensureDirectory(migrationRoot);
    migrationIdentity = await directoryIdentity(migrationRoot);
  } catch {
    const failure = makeIssue('invalid_root');
    return { resources: options.resources.map(r => ({ id: r.id, status: 'blocked', deduplicatedSources: [], issues: [failure] })), issues: [failure], cleanupPending: true };
  }
  const assertRoots = async () => {
    await assertDirectoryChain(options.userDataRoot);
    await assertDirectoryChain(options.sharedRoot);
    await assertIdentity(options.sharedRoot, sharedIdentity);
    await assertIdentity(migrationRoot, migrationIdentity);
  };
  const entries = await readdir(migrationRoot);
  const knownNames = new Set<string>();
  const journals = new Map<string, Journal[]>();
  for (const name of entries.filter(n => /^[a-f0-9]{16}\.json$/.test(n))) {
    const id = name.slice(0, -5);
    try {
      const journal = await readJournal(path.join(migrationRoot, name));
      const resource = options.resources.find(r => r.id === journal.resourceId);
      if (journal.transactionId !== id || !resource || journal.fingerprint !== fingerprint(resource)
        || !resource.sources[journal.sourceIndex]) throw new MigrationFailure('recovery_required');
      knownNames.add(name); knownNames.add(id);
      const group = journals.get(resource.id) ?? []; group.push(journal); journals.set(resource.id, group);
    } catch { issues.push(makeIssue('unknown_transaction')); }
  }
  if (entries.some(name => !knownNames.has(name))) issues.push(makeIssue('unknown_transaction'));
  if (issues.length) return { resources: options.resources.map(r => ({ id: r.id, status: 'blocked', deduplicatedSources: [], issues })), issues, cleanupPending: true };

  for (const resource of options.resources as readonly SpeechMigrationResource[]) {
    const resourceIssues: SpeechMigrationIssue[] = [];
    const deduplicatedSources: SpeechMigrationSourceRoot[] = [];
    let migratedFrom: SpeechMigrationSourceRoot | undefined;
    const target = contained(options.sharedRoot, resource.relativeDirectory);
    const checkpoint = async (event: string, journal?: Journal, source?: SpeechMigrationSource) => {
      await options.hooks?.checkpoint?.({ event, resourceId: resource.id,
        ...(journal ? { transactionId: journal.transactionId } : {}), ...(source ? { sourceRoot: source.root } : {}) });
    };
    const abort = () => { if (options.signal?.aborted) throw new MigrationFailure('cancelled'); };
    const sourcePath = (source: SpeechMigrationSource) => contained(contained(options.userDataRoot, source.root), source.relativeDirectory);
    const payloadPath = (journal: Journal) => path.join(migrationRoot, journal.transactionId, 'payload');
    const transactionPath = (journal: Journal) => path.join(migrationRoot, journal.transactionId);
    const assertTransaction = async (journal: Journal) => {
      await assertRoots(); await assertIdentity(transactionPath(journal), journal.transactionIdentity);
      const current = await readJournal(path.join(migrationRoot, `${journal.transactionId}.json`));
      if (JSON.stringify(current) !== JSON.stringify(journal)) throw new MigrationFailure('recovery_required');
    };
    const persist = async (journal: Journal, first = false) => {
      await assertRoots(); await assertIdentity(transactionPath(journal), journal.transactionIdentity);
      const next = path.join(transactionPath(journal), 'next-journal.json');
      const encoded = Buffer.from(`${JSON.stringify(journal)}\n`);
      if (await exists(next)) {
        const old = await readSmallFile(next, MAX_JOURNAL_BYTES);
        if (!old.equals(encoded)) throw new MigrationFailure('recovery_required');
      } else await writeExclusive(next, encoded);
      const final = path.join(migrationRoot, `${journal.transactionId}.json`);
      if (first && await exists(final)) throw new MigrationFailure('recovery_required');
      if (!first) {
        const previous = await readJournal(final);
        if (JSON.stringify(previous) !== JSON.stringify(journal)
          && JSON.stringify(previous) !== JSON.stringify({ ...journal, state: 'prepared' })) throw new MigrationFailure('recovery_required');
      }
      await rename(next, final);
      await syncDirectory(migrationRoot);
    };
    const completeTransaction = async (journal: Journal) => {
      await assertTransaction(journal);
      const tx = transactionPath(journal);
      const allowed = new Map(resource.sources[journal.sourceIndex]!.files.map((f, i) => [`backup-${i}`, f]));
      for (const name of await readdir(tx)) {
        const expected = allowed.get(name);
        if (!expected || expected.byteSize > MAX_METADATA_BYTES) throw new MigrationFailure('recovery_required');
        const observation = await verifyFile(path.join(tx, name), expected);
        await assertTransaction(journal); await unlinkObserved(path.join(tx, name), observation);
      }
      await assertIdentity(tx, journal.transactionIdentity); await rmdir(tx);
      const journalPath = path.join(migrationRoot, `${journal.transactionId}.json`);
      const receipt = await observeRegularFile(journalPath);
      const current = await readJournal(journalPath);
      if (JSON.stringify(current) !== JSON.stringify(journal)) throw new MigrationFailure('recovery_required');
      await unlinkObserved(journalPath, receipt); await syncDirectory(migrationRoot);
      await checkpoint('transaction-complete', journal);
    };
    const cleanupPayload = async (journal: Journal) => {
      await assertTransaction(journal);
      const targetTree = await verifyTree(target, resource.files);
      if (!journal.targetIdentity || !same(targetTree.root, journal.targetIdentity)) throw new MigrationFailure('target_conflict');
      const payload = payloadPath(journal);
      if (await exists(payload)) {
        await assertIdentity(payload, journal.sourceIdentity);
        const tree = await verifyTree(payload, resource.sources[journal.sourceIndex]!.files, journal.state === 'deleting');
        if (journal.state !== 'deleting') { journal.state = 'deleting'; await persist(journal); }
        for (const [relative, observation] of tree.files) {
          await assertTransaction(journal); await assertTreeDirectories(payload, tree);
          await checkpoint('before-delete-file', journal);
          await assertTreeDirectories(target, targetTree);
          for (const [relativeTarget, expectedTarget] of targetTree.files) {
            const current = await observeRegularFile(contained(target, relativeTarget));
            if (!same(current.identity, expectedTarget.identity) || current.size !== expectedTarget.size || current.mtime !== expectedTarget.mtime) throw new MigrationFailure('target_conflict');
          }
          await unlinkObserved(contained(payload, relative), observation);
          await checkpoint('after-delete-file', journal);
        }
        for (const [relative, expected] of [...tree.directories].sort((a, b) => b[0].length - a[0].length)) {
          const directory = relative ? contained(payload, relative) : payload;
          await assertIdentity(directory, expected); await rmdir(directory);
        }
      }
      await completeTransaction(journal);
    };
    const convertMetadata = async (journal: Journal) => {
      const source = resource.sources[journal.sourceIndex]!;
      const tx = transactionPath(journal), payload = payloadPath(journal);
      await assertTransaction(journal); await assertIdentity(payload, journal.sourceIdentity);
      const data = resource.files.filter(f => f.contents === undefined);
      const sourceMetadata = source.files.filter(f => !data.some(d => sameContract(d, f)));
      const union = new Map<string, SpeechMigrationFile[]>();
      for (const f of [...source.files, ...resource.files]) union.set(f.relativePath, [...union.get(f.relativePath) ?? [], f]);
      await verifyTransitionTree(payload, union, data);
      for (const file of resource.files.filter(f => f.contents !== undefined)) {
        const destination = contained(payload, file.relativePath);
        const previous = source.files.find(f => f.relativePath === file.relativePath);
        if (await matchesFile(destination, file)) continue;
        const index = resource.files.indexOf(file), temporary = path.join(tx, `metadata-${index}`);
        if (await exists(temporary)) await verifyFile(temporary, file);
        else await writeExclusive(temporary, file.contents!);
        await checkpoint('metadata-prepared', journal, source);
        await assertTransaction(journal);
        if (await exists(destination)) {
          if (!previous) throw new MigrationFailure('recovery_required');
          await verifyFile(destination, previous);
          const backup = path.join(tx, `backup-${source.files.indexOf(previous)}`);
          if (await exists(backup)) throw new MigrationFailure('recovery_required');
          await renameAbsent(destination, backup);
        }
        await ensureParents(payload, file.relativePath);
        await renameAbsent(temporary, destination);
        await verifyFile(destination, file);
        await checkpoint('metadata-rewritten', journal, source);
      }
      for (const file of sourceMetadata) {
        if (resource.files.some(f => f.relativePath === file.relativePath)) continue;
        const old = contained(payload, file.relativePath), backup = path.join(tx, `backup-${source.files.indexOf(file)}`);
        if (await exists(old)) { await verifyFile(old, file); await renameAbsent(old, backup); }
        else await verifyFile(backup, file);
      }
      await removeEmptyExtraDirectories(payload, expectedDirectories(resource.files));
      await verifyTree(payload, resource.files);
    };
    const resume = async (journal: Journal) => {
      const source = resource.sources[journal.sourceIndex]!, sourceDirectory = sourcePath(source);
      const payload = payloadPath(journal), tx = transactionPath(journal);
      // The journal outlives its private directory so interruption during receipt removal is recoverable.
      if (!(await exists(tx))) {
        const tree = await verifyTree(target, resource.files);
        const expected = journal.mode === 'adopt' ? journal.sourceIdentity : journal.targetIdentity;
        if (!expected || !same(tree.root, expected)) throw new MigrationFailure('recovery_required');
        const journalPath = path.join(migrationRoot, `${journal.transactionId}.json`);
        await unlinkObserved(journalPath, await observeRegularFile(journalPath));
        return;
      }
      await assertTransaction(journal);
      if (journal.mode === 'adopt' && await exists(target)) {
        const finalTree = await verifyTree(target, resource.files);
        if (!same(finalTree.root, journal.sourceIdentity) || await exists(payload)) throw new MigrationFailure('target_conflict');
        await completeTransaction(journal); return;
      }
      if (!(await exists(payload))) {
        if (journal.mode === 'deduplicate' && journal.state === 'deleting') { await cleanupPayload(journal); return; }
        await assertRoots(); await assertDirectoryChain(path.dirname(sourceDirectory));
        const sourceTree = await verifyTree(sourceDirectory, source.files);
        if (!same(sourceTree.root, journal.sourceIdentity)) throw new MigrationFailure('recovery_required');
        if (sourceTree.root.dev !== journal.transactionIdentity.dev) throw new MigrationFailure('cross_device');
        abort(); await checkpoint('before-source-rename', journal, source);
        await assertDirectoryChain(path.dirname(sourceDirectory)); await assertIdentity(sourceDirectory, journal.sourceIdentity);
        await renameAbsent(sourceDirectory, payload);
        await assertIdentity(payload, journal.sourceIdentity); await syncDirectory(tx);
        await checkpoint(journal.mode === 'adopt' ? 'source-renamed' : 'source-quarantined', journal, source);
      }
      if (journal.mode === 'deduplicate') { await cleanupPayload(journal); return; }
      await convertMetadata(journal);
      await assertTransaction(journal); await ensureParents(options.sharedRoot, resource.relativeDirectory);
      await checkpoint('before-publish', journal, source);
      await assertRoots(); await assertDirectoryChain(path.dirname(target)); await assertIdentity(payload, journal.sourceIdentity);
      await renameAbsent(payload, target); await syncDirectory(path.dirname(target));
      const finalTree = await verifyTree(target, resource.files);
      if (!same(finalTree.root, journal.sourceIdentity)) throw new MigrationFailure('recovery_required');
      await checkpoint('published', journal, source);
      await completeTransaction(journal);
    };
    const createTransaction = async (sourceIndex: number, mode: Journal['mode']) => {
      const source = resource.sources[sourceIndex]!;
      await assertRoots(); await assertDirectoryChain(path.dirname(sourcePath(source)));
      const tree = await verifyTree(sourcePath(source), source.files);
      await checkpoint('source-verified', undefined, source); abort();
      if (tree.root.dev !== migrationIdentity.dev) throw new MigrationFailure('cross_device');
      const targetIdentity = mode === 'deduplicate' ? (await verifyTree(target, resource.files)).root : null;
      const transactionId = randomBytes(8).toString('hex'), tx = path.join(migrationRoot, transactionId);
      if (process.platform === 'win32') {
        for (const root of [path.join(tx, 'payload'), target]) for (const file of [...resource.files, ...source.files]) {
          const absolute = contained(root, file.relativePath);
          if (path.dirname(absolute).length > 245 || absolute.length > (file.contents === undefined ? 245 : 259)) throw new MigrationFailure('invalid_root');
        }
      }
      await mkdir(tx, { mode: 0o700 });
      const journal: Journal = { version: 1, transactionId, resourceId: resource.id, fingerprint: fingerprint(resource), sourceIndex,
        mode, state: 'prepared', transactionIdentity: await directoryIdentity(tx), sourceIdentity: tree.root, targetIdentity };
      await persist(journal, true); await checkpoint('journal-written', journal, source);
      await resume(journal);
    };
    let recoveryFailed = false;
    for (const journal of journals.get(resource.id) ?? []) {
      try { await resume(journal); if (journal.mode === 'adopt') migratedFrom = resource.sources[journal.sourceIndex]!.root;
        else deduplicatedSources.push(resource.sources[journal.sourceIndex]!.root); }
      catch (error) { recoveryFailed = true; resourceIssues.push(makeIssue(failureCode(error, 'recovery_required'), resource.id, resource.sources[journal.sourceIndex]!.root)); }
    }
    let ready = false;
    if (!recoveryFailed) {
      try { if (await exists(target)) { await assertRoots(); await assertDirectoryChain(path.dirname(target)); await verifyTree(target, resource.files); ready = true; } }
      catch { resourceIssues.push(makeIssue('target_conflict', resource.id)); recoveryFailed = true; }
    }
    if (!recoveryFailed) for (let index = 0; index < resource.sources.length; index++) {
      const source = resource.sources[index]!, directory = sourcePath(source);
      try {
        abort(); await assertDirectoryChain(path.dirname(directory), true);
        if (!(await exists(directory))) continue;
        try { await verifyTree(directory, source.files); } catch { resourceIssues.push(makeIssue('invalid_source', resource.id, source.root)); continue; }
        await checkpoint(ready ? 'before-source-cleanup' : 'before-migration', undefined, source);
        await createTransaction(index, ready ? 'deduplicate' : 'adopt');
        if (ready) deduplicatedSources.push(source.root); else { migratedFrom = source.root; ready = true; }
      } catch (error) { resourceIssues.push(makeIssue(failureCode(error, ready ? 'cleanup_pending' : 'migration_failed'), resource.id, source.root)); recoveryFailed = true; break; }
    }
    issues.push(...resourceIssues);
    results.push({ id: resource.id, status: recoveryFailed ? 'blocked' : ready ? 'ready' : resourceIssues.length ? 'blocked' : 'missing',
      ...(migratedFrom ? { migratedFrom } : {}), deduplicatedSources, issues: resourceIssues });
  }
  return { resources: results, issues, cleanupPending: issues.some(i => i.code !== 'invalid_source') };
}

function validateOptions(options: MigrateSpeechResourcesOptions): MigrateSpeechResourcesOptions {
  if (!options || !path.isAbsolute(options.userDataRoot) || !path.isAbsolute(options.sharedRoot)
    || path.resolve(options.userDataRoot) === path.parse(path.resolve(options.userDataRoot)).root
    || path.resolve(options.sharedRoot) !== path.join(path.resolve(options.userDataRoot), 'speech-resources')
    || !Array.isArray(options.resources) || options.resources.length > 32) throw new TypeError('Invalid fixed speech-resource migration roots.');
  const ids = new Set<string>(), targets = new Set<string>(), allSources = new Set<string>();
  for (const resource of options.resources as readonly SpeechMigrationResource[]) {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(resource.id) || ids.has(resource.id)) throw new TypeError('Invalid resource catalog identity.');
    ids.add(resource.id); validateRelative(resource.relativeDirectory);
    if ([...targets].some(t => t === resource.relativeDirectory.toLowerCase() || t.startsWith(`${resource.relativeDirectory.toLowerCase()}/`)
      || resource.relativeDirectory.toLowerCase().startsWith(`${t}/`))) throw new TypeError('Overlapping resource target.');
    targets.add(resource.relativeDirectory.toLowerCase()); validateFiles(resource.files, true);
    if (!Array.isArray(resource.sources) || resource.sources.length > 2) throw new TypeError('Invalid fixed migration sources.');
    const sourceKeys = new Set<string>();
    for (const source of resource.sources as readonly SpeechMigrationSource[]) {
      if (!['local-subtitle', 'subtitle-studio/transcription'].includes(source.root)) throw new TypeError('Unknown migration source root.');
      validateRelative(source.relativeDirectory); validateFiles(source.files, false);
      const key = `${source.root}/${source.relativeDirectory}`.toLowerCase();
      if (sourceKeys.has(key) || allSources.has(key)) throw new TypeError('Duplicate fixed migration source.'); sourceKeys.add(key); allSources.add(key);
      for (const file of resource.files.filter(f => f.contents === undefined)) {
        if (!source.files.some(s => sameContract(s, file))) throw new TypeError('Payload migration would require copying or transforming bytes.');
      }
      for (const sourceFile of source.files) if (!resource.files.some(f => f.contents === undefined && sameContract(f, sourceFile))
        && sourceFile.byteSize > MAX_METADATA_BYTES) throw new TypeError('Only bounded catalog metadata can be rewritten.');
    }
  }
  return { ...options, userDataRoot: path.resolve(options.userDataRoot), sharedRoot: path.resolve(options.sharedRoot) };
}
function validateFiles(files: readonly SpeechMigrationFile[], metadata: boolean) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 128) throw new TypeError('Invalid expected resource tree.');
  const names = new Set<string>(); let metadataBytes = 0;
  for (const f of files) {
    validateRelative(f.relativePath);
    if (names.has(f.relativePath.toLowerCase()) || !Number.isSafeInteger(f.byteSize) || f.byteSize < 1 || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new TypeError('Invalid expected resource file.');
    names.add(f.relativePath.toLowerCase());
    if (f.contents !== undefined) {
      if (!metadata || !(f.contents instanceof Uint8Array) || f.contents.byteLength !== f.byteSize || sha(f.contents) !== f.sha256) throw new TypeError('Invalid fixed metadata bytes.');
      metadataBytes += f.byteSize;
    }
  }
  if (metadataBytes > MAX_METADATA_BYTES) throw new TypeError('Migration metadata is too large.');
  for (const file of names) if ([...names].some(other => other !== file && other.startsWith(`${file}/`))) throw new TypeError('Resource file/directory collision.');
}
function validateRelative(value: string) {
  if (typeof value !== 'string' || value.length > 220 || !value || value.includes('\\') || value.startsWith('/')
    || value.split('/').some(p => !/^[A-Za-z0-9._-]+$/.test(p) || p === '.' || p === '..' || /[. ]$/.test(p)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new TypeError('Invalid fixed relative resource path.');
}
function contained(root: string, relative: string): string { validateRelative(relative); return path.join(root, ...relative.split('/')); }
function sameContract(a: SpeechMigrationFile, b: SpeechMigrationFile) { return a.relativePath === b.relativePath && a.byteSize === b.byteSize && a.sha256 === b.sha256; }
function fingerprint(resource: SpeechMigrationResource) { return sha(JSON.stringify(resource, (key, value) => key === 'contents' ? undefined : value)); }
function makeIssue(code: SpeechMigrationIssue['code'], resourceId?: string, sourceRoot?: SpeechMigrationSourceRoot): SpeechMigrationIssue {
  return { code, message: issueMessages[code], ...(resourceId ? { resourceId } : {}), ...(sourceRoot ? { sourceRoot } : {}) };
}
function failureCode(error: unknown, fallback: SpeechMigrationIssue['code']): SpeechMigrationIssue['code'] {
  if (error instanceof MigrationFailure) return error.code;
  return (error as NodeJS.ErrnoException)?.code === 'EXDEV' ? 'cross_device' : fallback;
}
async function exists(file: string) { try { await lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function directoryIdentity(directory: string): Promise<Identity> {
  const value = await lstat(directory, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) throw new MigrationFailure('invalid_root');
  return identity(value);
}
async function assertIdentity(directory: string, expected: Identity) { if (!same(await directoryIdentity(directory), expected)) throw new MigrationFailure('recovery_required'); }
async function assertDirectoryChain(directory: string, missingAllowed = false) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (missingAllowed && !(await exists(current))) return;
    await directoryIdentity(current);
  }
  const canonical = await realpath(absolute);
  if (path.resolve(canonical).toLowerCase() !== absolute.toLowerCase()) throw new MigrationFailure('invalid_root');
}
async function ensureDirectory(directory: string) { try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } await assertDirectoryChain(directory); }
async function ensureParents(root: string, relative: string) {
  const parts = relative.split('/'); parts.pop(); let current = root;
  for (const part of parts) { current = path.join(current, part); await ensureDirectory(current); }
}
async function observeRegularFile(file: string): Promise<Observation> {
  const value = await lstat(file, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink() || value.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new MigrationFailure('invalid_source');
  return { identity: identity(value), size: Number(value.size), mtime: String(value.mtimeNs), ctime: String(value.ctimeNs) };
}
async function verifyFile(file: string, expected: SpeechMigrationFile): Promise<Observation> {
  const before = await observeRegularFile(file);
  if (before.size !== expected.byteSize) throw new MigrationFailure('invalid_source');
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!same(identity(opened), before.identity) || opened.size !== BigInt(before.size)) throw new MigrationFailure('invalid_source');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let offset = 0;
    while (offset < expected.byteSize) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.byteSize - offset), offset);
      if (!bytesRead) throw new MigrationFailure('invalid_source'); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || !same(identity(opened), identity(after)) || hash.digest('hex') !== expected.sha256) throw new MigrationFailure('invalid_source');
  } finally { await handle.close(); }
  const closed = await observeRegularFile(file);
  if (!same(before.identity, closed.identity) || before.size !== closed.size || before.mtime !== closed.mtime) throw new MigrationFailure('invalid_source');
  return closed;
}
async function matchesFile(file: string, expected: SpeechMigrationFile) { if (!(await exists(file))) return false; try { await verifyFile(file, expected); return true; } catch { return false; } }
function expectedDirectories(files: readonly SpeechMigrationFile[]) {
  const dirs = new Set(['']);
  for (const f of files) { const parts = f.relativePath.split('/'); parts.pop(); while (parts.length) { dirs.add(parts.join('/')); parts.pop(); } }
  return dirs;
}
async function verifyTree(root: string, files: readonly SpeechMigrationFile[], missingAllowed = false): Promise<Tree> {
  const expected = new Map(files.map(f => [f.relativePath, f])), allowedDirectories = expectedDirectories(files);
  const tree: Tree = { root: await directoryIdentity(root), files: new Map(), directories: new Map() };
  async function walk(relative: string) {
    const directory = relative ? contained(root, relative) : root;
    tree.directories.set(relative, await directoryIdentity(directory));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new MigrationFailure('invalid_source');
      if (entry.isDirectory()) { if (!allowedDirectories.has(name)) throw new MigrationFailure('invalid_source'); await walk(name); }
      else { const f = expected.get(name); if (!f) throw new MigrationFailure('invalid_source'); tree.files.set(name, await verifyFile(contained(root, name), f)); }
    }
  }
  await walk(''); if (!missingAllowed && tree.files.size !== expected.size) throw new MigrationFailure('invalid_source');
  await assertTreeDirectories(root, tree); return tree;
}
async function assertTreeDirectories(root: string, tree: Tree) { for (const [relative, expected] of tree.directories) await assertIdentity(relative ? contained(root, relative) : root, expected); }
async function verifyTransitionTree(root: string, union: Map<string, SpeechMigrationFile[]>, required: readonly SpeechMigrationFile[]) {
  const dirs = expectedDirectories([...union.values()].flat()), observed = new Set<string>();
  async function walk(relative: string) {
    const directory = relative ? contained(root, relative) : root; await directoryIdentity(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new MigrationFailure('recovery_required');
      if (entry.isDirectory()) { if (!dirs.has(name)) throw new MigrationFailure('recovery_required'); await walk(name); }
      else { const alternatives = union.get(name); if (!alternatives) throw new MigrationFailure('recovery_required');
        let valid = false; for (const f of alternatives) if (await matchesFile(contained(root, name), f)) { valid = true; break; }
        if (!valid) throw new MigrationFailure('recovery_required'); observed.add(name); }
    }
  }
  await walk(''); if (required.some(f => !observed.has(f.relativePath))) throw new MigrationFailure('recovery_required');
}
async function removeEmptyExtraDirectories(root: string, allowed: Set<string>, relative = ''): Promise<void> {
  const current = relative ? contained(root, relative) : root, proof = await directoryIdentity(current);
  for (const entry of await readdir(current, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await removeEmptyExtraDirectories(root, allowed, relative ? `${relative}/${entry.name}` : entry.name);
  if (relative && !allowed.has(relative)) { await assertIdentity(current, proof); await rmdir(current); }
}
async function unlinkObserved(file: string, expected: Observation) { const current = await observeRegularFile(file);
  if (!same(current.identity, expected.identity) || current.size !== expected.size || current.mtime !== expected.mtime) throw new MigrationFailure('recovery_required');
  await unlink(file); if (await exists(file)) throw new MigrationFailure('cleanup_pending'); }
async function renameAbsent(source: string, target: string) {
  if (await exists(target)) throw new MigrationFailure('target_conflict');
  await rename(source, target);
}
async function writeExclusive(file: string, contents: Uint8Array) { const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); } }
async function readSmallFile(file: string, limit: number) { const before = await observeRegularFile(file); if (before.size > limit) throw new MigrationFailure('recovery_required');
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW); try { const observed = await handle.stat({ bigint: true }); if (!same(identity(observed), before.identity)) throw new MigrationFailure('recovery_required'); const bytes = await handle.readFile(); if (bytes.length !== before.size) throw new MigrationFailure('recovery_required'); return bytes; } finally { await handle.close(); } }
async function readJournal(file: string): Promise<Journal> {
  const j = JSON.parse((await readSmallFile(file, MAX_JOURNAL_BYTES)).toString('utf8')) as Journal;
  const fields = ['version', 'transactionId', 'resourceId', 'fingerprint', 'sourceIndex', 'mode', 'state', 'transactionIdentity', 'sourceIdentity', 'targetIdentity'];
  const validIdentity = (x: Identity) => x && Object.keys(x).sort().join(',') === 'dev,ino' && /^\d+$/.test(x.dev) && /^\d+$/.test(x.ino);
  if (!j || Object.keys(j).sort().join(',') !== fields.sort().join(',') || j.version !== 1 || !/^[a-f0-9]{16}$/.test(j.transactionId)
    || !/^[a-f0-9]{64}$/.test(j.fingerprint) || !Number.isSafeInteger(j.sourceIndex) || j.sourceIndex < 0
    || !['adopt', 'deduplicate'].includes(j.mode) || !['prepared', 'deleting'].includes(j.state)
    || !validIdentity(j.transactionIdentity) || !validIdentity(j.sourceIdentity) || (j.targetIdentity !== null && !validIdentity(j.targetIdentity))) throw new MigrationFailure('recovery_required');
  return j;
}
async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY | NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); }
}
