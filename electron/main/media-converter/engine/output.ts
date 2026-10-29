import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, stat, statfs, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { EngineReasonCode } from '../../../../src/media-converter/contract';
import { atomicWriteUtf8File } from '../../translation/atomic-file';
import { localSubtitleFilesystemObjectIdentityForHandle, localSubtitleFilesystemObjectIdentityForPath, sameLocalSubtitleFilesystemObjectIdentity,
  snapshotLocalSubtitleFilesystemObjectIdentity, type LocalSubtitleFilesystemObjectIdentity } from '../../subtitle-studio/transcription/native/filesystem-object-identity';
import { canonicalPath, fullyQualifiedPath, isMissingPathError } from './inputs';
import { usableObjectIdentity } from './probe';

/**
 * Output publishing (design §7). Every output is written to an exclusive
 * `.fusionkit-media-<id>.partial` beside its final name, recorded in `partials.json` before it
 * exists, and published only after the job succeeded: by hard link, which never replaces anything
 * (`name (1).ext`, `name (2).ext`, …), or over an exclusive placeholder where the volume cannot link.
 * Overwriting moves the old file to the recycle bin first. The identity recorded when the partial
 * was created is checked before it is published or deleted, so only the converter's own file is
 * ever moved or removed (FK-PIT-0044). Free space is checked per volume against the caps of every
 * running output, and the startup cleanup removes what a crash left behind.
 */

type Identity = LocalSubtitleFilesystemObjectIdentity;

export const OUTPUT_POLICY = Object.freeze({
  partialPrefix: '.fusionkit-media-',
  partialSuffix: '.partial',
  /** `name (1).ext` … `name (9999).ext`. */
  maxNumbered: 10_000,
  /** Free space kept beyond the caps of the running outputs (AC-ENGINE-06-4). */
  headroomBytes: 512 * 1024 * 1024,
  /** FAT32 (and FAT16 on Windows NT) holds at most 4 GiB − 1 byte per file. */
  fatMaxFileBytes: 2 ** 32 - 1,
  /** A final path in UTF-16 code units: MAX_PATH less the terminator. */
  maxPathChars: 259,
  /** Waits before the 2nd–5th attempt of a rename, unlink or trash refused with EBUSY/EPERM: about 2 s in all (FK-PIT-0071). */
  busyRetryDelaysMs: Object.freeze([150, 300, 600, 950]) as readonly number[],
  /** Times an overwrite moves a file that keeps reappearing under the output name to the recycle bin. */
  overwriteRounds: 3,
  volumeQueryTimeoutMs: 10_000,
  journalRecordsMax: 10_000,
});

export type OutputFailureCode = Extract<EngineReasonCode, 'disk_space_low' | 'file_too_large_for_volume' | 'output_is_input' | 'output_dir_unwritable'
  | 'output_path_too_long' | 'overwrite_trash_failed'>;
export type OutputWarning = Extract<EngineReasonCode, 'output_name_collision'>;
export type OutputConflictPolicy = 'number' | 'overwrite';

export class OutputError extends Error {
  /** `disk_space_low` only: what the volume needs and has, for the interface to show. */
  readonly space?: { readonly requiredBytes: number; readonly availableBytes: number };
  constructor(readonly code: OutputFailureCode, message: string, details: { space?: OutputError['space']; cause?: unknown } = {}) {
    super(message, { cause: details.cause });
    this.name = 'OutputError';
    this.space = details.space;
  }
}

const errorCode = (error: unknown) => typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
  ? (error as { code: string }).code : undefined;
const BUSY = new Set(['EBUSY', 'EPERM']);
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const sameIdentity = sameLocalSubtitleFilesystemObjectIdentity;
const toSafeNumber = (value: bigint) => value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);

/** Retries what Windows refuses while another process (an antivirus scan, say) holds the file: EBUSY and EPERM, five attempts over about 2 s. */
export async function retryWhileBusy<T>(operation: () => Promise<T>, sleep: (milliseconds: number) => Promise<void> = delay): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const wait = OUTPUT_POLICY.busyRetryDelaysMs[attempt];
      if (wait === undefined || !BUSY.has(errorCode(error) ?? '')) throw error;
      await sleep(wait);
    }
  }
}

// ── Names and limits ───────────────────────────────────────────────────────────────────────────

const PARTIAL_ID = /^[0-9a-f]{8}$/;
const PARTIAL_NAME = /^\.fusionkit-media-[0-9a-f]{8}\.partial$/;
export const partialName = (id: string) => `${OUTPUT_POLICY.partialPrefix}${id}${OUTPUT_POLICY.partialSuffix}`;
/** What Windows does not allow in a name (`:` would write an alternate data stream of another file), and its device names. */
const ILLEGAL_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/** `base.ext`, then `base (1).ext`, `base (2).ext`, … The base name comes cleaned from encode's naming; the extension may carry its dot or not. */
export function numberedName(baseName: string, extension: string, index: number): string {
  if (!baseName || baseName === '.' || baseName === '..' || ILLEGAL_NAME.test(baseName) || DEVICE_NAME.test(baseName.split('.')[0].replace(/[. ]+$/, ''))) {
    throw new TypeError('The output base name is invalid.');
  }
  if (extension && !/^\.?[A-Za-z0-9]{1,16}$/.test(extension)) throw new TypeError('The output extension is invalid.');
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('The output number is invalid.');
  const dotted = !extension ? '' : extension.startsWith('.') ? extension : `.${extension}`;
  return `${baseName}${index ? ` (${index})` : ''}${dotted}`;
}

function assertCap(capBytes: number) {
  if (!Number.isSafeInteger(capBytes) || capBytes <= 0) throw new TypeError('The output cap is invalid.');
}

/**
 * The byte and duration ceilings every output carries (FK-PIT-0042): `-fs <cap>`, and with a known
 * probed duration `-t <max(duration × 1.05, duration + 10 s)>`. Output options: they go before the output.
 */
export function outputLimitArgs(capBytes: number, durationUs: number | null): string[] {
  assertCap(capBytes);
  const args = ['-fs', String(capBytes)];
  if (durationUs !== null && Number.isFinite(durationUs) && durationUs > 0) {
    const limitUs = Math.ceil(Math.max(durationUs * 1.05, durationUs + 10_000_000));
    args.push('-t', `${Math.floor(limitUs / 1e6)}.${String(limitUs % 1e6).padStart(6, '0')}`);
  }
  return args;
}

// ── Volumes ────────────────────────────────────────────────────────────────────────────────────

/** File systems that cannot hold a file of 4 GiB, and those whose FileId can change on rename. */
const FAT_LIMITED = new Set(['fat', 'fat32']);
const FAT_FAMILY = new Set(['fat', 'fat32', 'exfat']);

/**
 * The file system of the drive holding `directory`, lower case (`ntfs`, `fat32`, `exfat`, `refs`, …):
 * `(Get-Volume -DriveLetter X).FileSystemType`. Null when unknown: a UNC path, another platform,
 * or a query that fails or times out. A folder that mounts another volume reports its drive's type.
 */
export async function windowsVolumeFileSystem(directory: string, platform: NodeJS.Platform | string = process.platform): Promise<string | null> {
  if (platform !== 'win32') return null;
  const letter = /^(?:\\\\[?.]\\)?([A-Za-z]):\\/.exec(path.win32.resolve(directory))?.[1];
  const systemRoot = process.env.SystemRoot;
  if (!letter || !systemRoot || !path.win32.isAbsolute(systemRoot)) return null;
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const query = `(Get-Volume -DriveLetter ${letter.toUpperCase()} -ErrorAction Stop).FileSystemType`;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query],
        { encoding: 'utf8', windowsHide: true, timeout: OUTPUT_POLICY.volumeQueryTimeoutMs, maxBuffer: 64 * 1024 },
        (error, output) => error ? reject(error) : resolve(output));
    });
    const value = stdout.trim().toLowerCase();
    return /^[a-z0-9]{1,16}$/.test(value) && value !== 'unknown' ? value : null;
  } catch { return null; }
}

/** The volume serial on Windows (`dev`), the device number elsewhere: what tells volumes apart. */
const defaultVolumeOf = async (directory: string) => (await stat(directory, { bigint: true })).dev.toString();

// ── Inputs ─────────────────────────────────────────────────────────────────────────────────────

export interface IdentityOptions {
  identityOfPath?: (target: string) => Promise<Identity>;
  platform?: NodeJS.Platform | string;
}

/**
 * Whether `target` is the same file as one of the inputs: by volume and FileId, which catches a
 * different case and a hard link; by the case-folded real path where either side has no usable
 * FileId (all zeros on FAT/exFAT). A target that does not exist is no input.
 */
export async function outputIsInput(target: string, inputs: readonly string[], options: IdentityOptions = {}): Promise<boolean> {
  if (!inputs.length) return false;
  const identityOf = options.identityOfPath ?? localSubtitleFilesystemObjectIdentityForPath;
  let output: Identity | null = null;
  try { output = await identityOf(target); } catch (error) { if (isMissingPathError(error)) return false; }
  let outputPath: string | undefined;
  for (const input of inputs) {
    let identity: Identity | null = null;
    try { identity = await identityOf(input); } catch (error) { if (isMissingPathError(error)) continue; }
    if (usableObjectIdentity(output) && usableObjectIdentity(identity)) {
      if (sameIdentity(output, identity)) return true;
      continue;
    }
    outputPath ??= await canonicalPath(target, options.platform);
    if (outputPath === await canonicalPath(input, options.platform)) return true;
  }
  return false;
}

// ── Journal ────────────────────────────────────────────────────────────────────────────────────

interface PartialRecord {
  readonly id: string;
  readonly path: string;
  readonly expectedName: string;
  /** `volumeOf` the partial's folder when it was recorded. */
  readonly volume: string;
  /** Null between the record and the exclusive create: only an empty file can then be ours. */
  readonly identity: Identity | null;
  readonly createdAt: number;
}

const journalSchema = z.object({ version: z.literal(1), records: z.array(z.unknown()).max(OUTPUT_POLICY.journalRecordsMax) });
const recordSchema = z.strictObject({
  id: z.string().regex(PARTIAL_ID),
  path: z.string().min(1).max(32_767),
  expectedName: z.string().regex(PARTIAL_NAME),
  volume: z.string().min(1).max(64),
  identity: z.unknown(),
  createdAt: z.number().int().min(0),
});

/** A record drives a deletion at startup, so it must name a partial of its own id and nothing else. */
function parseRecord(value: unknown): PartialRecord | undefined {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const record = parsed.data;
  if (!fullyQualifiedPath(record.path) || path.basename(record.path) !== record.expectedName || record.expectedName !== partialName(record.id)) return undefined;
  const identity = record.identity === null ? null : snapshotLocalSubtitleFilesystemObjectIdentity(record.identity);
  return identity === undefined ? undefined : { ...record, identity };
}

/**
 * `partials.json`: every partial the converter may have left on disk. Writes are atomic
 * (`atomicWriteUtf8File`) and serialized; each writes the whole current set.
 */
class PartialJournal {
  readonly #file: string;
  #records: Promise<Map<string, PartialRecord>> | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(file: string) { this.#file = file; }

  /** Loaded once; a load that failed (not a missing or corrupt file: those start empty) is tried again next time. */
  records(): Promise<Map<string, PartialRecord>> {
    if (!this.#records) {
      const pending = this.#load();
      this.#records = pending;
      pending.catch(() => { if (this.#records === pending) this.#records = undefined; });
    }
    return this.#records;
  }

  /** Durable once this resolves; a failed write leaves the previous record in place. */
  async put(record: PartialRecord) {
    const records = await this.records();
    const previous = records.get(record.id);
    records.set(record.id, record);
    try { await this.#flush(); }
    catch (error) {
      if (records.get(record.id) === record) { if (previous) records.set(record.id, previous); else records.delete(record.id); }
      throw error;
    }
  }

  /** Best effort: a record that stays on disk names a file that is gone, which the startup cleanup drops. */
  async drop(id: string) {
    const records = await this.records().catch(() => undefined);
    if (!records?.delete(id)) return;
    await this.#flush().catch(() => undefined);
  }

  async #load(): Promise<Map<string, PartialRecord>> {
    const records = new Map<string, PartialRecord>();
    let text: string;
    try { text = await retryWhileBusy(() => readFile(this.#file, 'utf8')); }
    catch (error) { if (isMissingPathError(error)) return records; throw error; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const journal = journalSchema.safeParse(parsed);
    if (!journal.success) {
      // Keep the unreadable journal for diagnosis; its partials stay on disk, nothing is deleted on a guess.
      await rename(this.#file, `${this.#file.replace(/\.json$/, '')}.corrupt.json`).catch(() => undefined);
      return records;
    }
    for (const value of journal.data.records) {
      const record = parseRecord(value);
      if (record) records.set(record.id, record);
    }
    return records;
  }

  #flush(): Promise<void> {
    const run = this.#writes.then(async () => {
      const records = await this.records();
      await atomicWriteUtf8File(this.#file, JSON.stringify({ version: 1, records: [...records.values()] }));
    });
    this.#writes = run.catch(() => undefined);
    return run;
  }
}

// ── Batch claims ───────────────────────────────────────────────────────────────────────────────

/**
 * Output names held within a batch: claimed by the item that resolved to them first, or published.
 * Another item of the batch never takes or replaces such a name; it is numbered instead and
 * carries `output_name_collision`.
 */
class OutputClaims {
  readonly #names = new Map<string, { owner: string; published: boolean }>();
  constructor(readonly platform: NodeJS.Platform | string) {}

  #key(target: string) {
    return this.platform === 'win32' ? path.win32.resolve(target).toLowerCase() : path.resolve(target);
  }

  /** False when another owner holds the name. */
  claim(owner: string, target: string): boolean {
    const key = this.#key(target);
    const holder = this.#names.get(key);
    if (holder && holder.owner !== owner) return false;
    if (!holder) this.#names.set(key, { owner, published: false });
    return true;
  }

  heldByOther(owner: string, target: string): boolean {
    const holder = this.#names.get(this.#key(target));
    return !!holder && holder.owner !== owner;
  }

  publish(owner: string, target: string) {
    this.#names.set(this.#key(target), { owner, published: true });
  }

  /** An item that stops without publishing gives its names back; what it published stays held until the batch ends. */
  release(owner: string) {
    for (const [key, holder] of this.#names) if (holder.owner === owner && !holder.published) this.#names.delete(key);
  }

  clear() {
    this.#names.clear();
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────────────────────

/** The file operations a publish performs; tests inject failures. */
export interface OutputFileSystem {
  open(target: string, flags: 'wx'): Promise<FileHandle>;
  link(existing: string, created: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
}

export interface MediaOutputsOptions {
  /** `userData/media-converter`: holds `partials.json` and `work/`. */
  root: string;
  /** Electron's `shell.trashItem`, passed in so this module never imports electron. */
  trashItem: (target: string) => Promise<void>;
  /** `fs.statfs(directory, {bigint: true})`. */
  statfs?: (directory: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  /** Lower-case file system of the volume holding `directory`, or null when unknown; defaults to {@link windowsVolumeFileSystem}. */
  volumeFileSystem?: (directory: string) => Promise<string | null>;
  /** A key that tells volumes apart; defaults to the folder's `dev` (the volume serial on Windows). */
  volumeOf?: (directory: string) => Promise<string>;
  identityOfPath?: (target: string) => Promise<Identity>;
  identityOfHandle?: (handle: FileHandle) => Promise<Identity>;
  fs?: Partial<OutputFileSystem>;
  sleep?: (milliseconds: number) => Promise<void>;
  platform?: NodeJS.Platform | string;
}

/** An exclusive partial: ffmpeg writes it with `-f <muxer> -y file:<path>`, which truncates it but keeps its identity. */
export interface PartialFile {
  readonly id: string;
  readonly path: string;
  readonly directory: string;
  readonly identity: Identity;
}

export interface OutputTarget {
  /** Item id, with the output index when an item writes several: who holds a name within the batch. */
  owner: string;
  /** Encode's cleaned base name, without the extension. */
  baseName: string;
  extension: string;
  conflict: OutputConflictPolicy;
  /** Every input of the queue: none is ever replaced (`output_is_input`). */
  inputs: readonly string[];
}
export interface PreflightRequest extends OutputTarget {
  directory: string;
  /** The `-fs` cap of this output (encode's `outputCapBytes`). */
  capBytes: number;
}
export interface PreflightResult { target: string; warnings: OutputWarning[] }
export interface PublishResult { path: string; replaced: boolean; warnings: OutputWarning[] }
export interface StartupCleanupReport { deleted: number; removed: number; kept: number; workCleared: boolean }

type Placement = { linkUnsupported: boolean };

/**
 * Partials, publishing and space for the converter's outputs. One instance per app: it holds the
 * journal, the space reserved by running outputs and the names claimed within the current batch.
 */
export class MediaOutputs {
  readonly #root: string;
  readonly #trashItem: (target: string) => Promise<void>;
  readonly #statfs: (directory: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  readonly #volumeFileSystem: (directory: string) => Promise<string | null>;
  readonly #volumeOf: (directory: string) => Promise<string>;
  readonly #identityOfPath: (target: string) => Promise<Identity>;
  readonly #identityOfHandle: (handle: FileHandle) => Promise<Identity>;
  readonly #fs: OutputFileSystem;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #platform: NodeJS.Platform | string;
  readonly #journal: PartialJournal;
  readonly #claims: OutputClaims;
  readonly #reservations = new Map<string, { volume: string; capBytes: number }>();
  readonly #fileSystems = new Map<string, Promise<string | null>>();
  /** Partials this instance created and has not settled: the startup cleanup never touches them. */
  readonly #live = new Set<string>();

  constructor(options: MediaOutputsOptions) {
    // The startup cleanup empties `<root>/work`: never a folder relative to the working directory.
    if (!fullyQualifiedPath(options.root)) throw new TypeError('The media converter state folder must be a full path.');
    this.#root = options.root;
    this.#trashItem = options.trashItem;
    this.#statfs = options.statfs ?? (directory => statfs(directory, { bigint: true }));
    this.#platform = options.platform ?? process.platform;
    this.#volumeFileSystem = options.volumeFileSystem ?? (directory => windowsVolumeFileSystem(directory, this.#platform));
    this.#volumeOf = options.volumeOf ?? defaultVolumeOf;
    this.#identityOfPath = options.identityOfPath ?? localSubtitleFilesystemObjectIdentityForPath;
    this.#identityOfHandle = options.identityOfHandle ?? localSubtitleFilesystemObjectIdentityForHandle;
    this.#fs = { open: (target, flags) => open(target, flags), link, rename, unlink, ...options.fs };
    this.#sleep = options.sleep ?? delay;
    this.#journal = new PartialJournal(path.join(this.#root, 'partials.json'));
    this.#claims = new OutputClaims(this.#platform);
  }

  get workRoot() {
    return path.join(this.#root, 'work');
  }

  /** `work/<id>`: the cwd, TEMP and 2-pass logs of one job. */
  workDirectory(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new TypeError('The work directory id is invalid.');
    return path.join(this.workRoot, id);
  }

  async removeWorkDirectory(id: string): Promise<boolean> {
    try { await rm(this.workDirectory(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; }
    catch { return false; }
  }

  // ── Before a job starts ──

  /**
   * The checks before an output starts, in order: the folder exists (`output_dir_unwritable`), the
   * path fits (`output_path_too_long`), it is no input (`output_is_input`), FAT32 can hold the cap
   * (`file_too_large_for_volume`), and the volume has room for the caps of every running output on
   * it plus this one plus 512 MB (`disk_space_low`). Passing reserves the cap until {@link release}
   * and claims the name for the batch; a name another item claimed carries `output_name_collision`.
   */
  async preflight(request: PreflightRequest): Promise<PreflightResult> {
    assertCap(request.capBytes);
    const target = this.#targetPath(request.directory, request);
    let folder: BigIntStats;
    try { folder = await stat(request.directory, { bigint: true }); }
    catch (error) { throw new OutputError('output_dir_unwritable', 'The output folder is unavailable.', { cause: error }); }
    if (!folder.isDirectory()) throw new OutputError('output_dir_unwritable', 'The output folder is not a folder.');
    if (target.length > OUTPUT_POLICY.maxPathChars) throw new OutputError('output_path_too_long', 'The output path is too long.');
    if (await outputIsInput(target, request.inputs, this.#identityOptions())) throw new OutputError('output_is_input', 'The output would replace an input.');
    let volume: string;
    try { volume = await this.#volumeOf(request.directory); }
    catch (error) { throw new OutputError('output_dir_unwritable', 'The output volume is unavailable.', { cause: error }); }
    if (request.capBytes > OUTPUT_POLICY.fatMaxFileBytes && FAT_LIMITED.has(await this.#fileSystemOf(request.directory) ?? '')) {
      throw new OutputError('file_too_large_for_volume', 'A FAT32 volume cannot hold a file this large.');
    }
    await this.#reserve(request.owner, request.directory, volume, request.capBytes);
    return { target, warnings: this.#claims.claim(request.owner, target) ? [] : ['output_name_collision'] };
  }

  /** The output's own name when a file is there that an overwrite would move to the recycle bin, for the confirmation before start. */
  async wouldReplace(directory: string, baseName: string, extension: string): Promise<string | null> {
    const target = path.join(directory, numberedName(baseName, extension, 0));
    try {
      const existing = await lstat(target);
      return existing.isFile() && !existing.isSymbolicLink() ? path.basename(target) : null;
    } catch { return null; }
  }

  /** Ends an output: its space reservation and the names it claimed without publishing are given back. */
  release(owner: string) {
    this.#reservations.delete(owner);
    this.#claims.release(owner);
  }

  /** The batch is over: published names may be claimed (or overwritten) again. */
  endBatch() {
    this.#claims.clear();
  }

  async #reserve(owner: string, directory: string, volume: string, capBytes: number) {
    let space: { bavail: bigint; bsize: bigint };
    try { space = await this.#statfs(directory); }
    catch (error) { throw new OutputError('output_dir_unwritable', 'The free space of the output volume is unknown.', { cause: error }); }
    // Synchronous from here on: two outputs starting together each see the other's reservation.
    const available = space.bavail * space.bsize;
    let required = BigInt(capBytes) + BigInt(OUTPUT_POLICY.headroomBytes);
    for (const [holder, reservation] of this.#reservations) if (holder !== owner && reservation.volume === volume) required += BigInt(reservation.capBytes);
    if (available < required) {
      throw new OutputError('disk_space_low', 'The output volume does not have enough free space.',
        { space: { requiredBytes: toSafeNumber(required), availableBytes: toSafeNumber(available) } });
    }
    this.#reservations.set(owner, { volume, capBytes });
  }

  // ── Partials ──

  /**
   * Records `.fusionkit-media-<id>.partial` in `partials.json`, then creates it exclusively in
   * `directory` and records its identity. Fails with `output_dir_unwritable`.
   */
  async createPartial(directory: string): Promise<PartialFile> {
    if (!fullyQualifiedPath(directory)) throw new OutputError('output_dir_unwritable', 'The output folder is not a full path.');
    const folder = path.normalize(directory);
    let volume: string;
    try { volume = await this.#volumeOf(folder); }
    catch (error) { throw new OutputError('output_dir_unwritable', 'The output folder is unavailable.', { cause: error }); }
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = randomBytes(4).toString('hex');
      const records = await this.#journal.records().catch(() => new Map<string, PartialRecord>());
      if (records.has(id)) continue;
      const record: PartialRecord = { id, path: path.join(folder, partialName(id)), expectedName: partialName(id), volume, identity: null, createdAt: Date.now() };
      try { await this.#journal.put(record); }
      catch (error) { throw new OutputError('output_dir_unwritable', 'The partial journal could not be written.', { cause: error }); }
      this.#live.add(id);
      let handle: FileHandle;
      try { handle = await this.#fs.open(record.path, 'wx'); }
      catch (error) {
        this.#live.delete(id);
        await this.#journal.drop(id);
        if (errorCode(error) === 'EEXIST') continue;
        throw new OutputError('output_dir_unwritable', 'The partial file could not be created.', { cause: error });
      }
      let identity: Identity;
      // Without an identity the empty file stays recorded; the next startup cleanup removes it.
      try { identity = await this.#identityOfHandle(handle); }
      catch (error) { throw new OutputError('output_dir_unwritable', 'The partial file has no identity.', { cause: error }); }
      finally { await handle.close().catch(() => undefined); }
      const partial: PartialFile = Object.freeze({ id, path: record.path, directory: folder, identity });
      try { await this.#journal.put({ ...record, identity }); }
      catch (error) {
        await this.discardPartial(partial);
        throw new OutputError('output_dir_unwritable', 'The partial journal could not be written.', { cause: error });
      }
      return partial;
    }
    throw new OutputError('output_dir_unwritable', 'No unused partial name was found.');
  }

  /** The partial name still holds the file this instance created. */
  verifyPartial(partial: PartialFile): Promise<boolean> {
    return this.#holds(partial.path, partial.identity);
  }

  /**
   * Deletes the partial when its name still holds the file created for it, and forgets the record.
   * Another file under that name is left alone. False when the delete failed: the record stays for
   * the startup cleanup.
   */
  async discardPartial(partial: PartialFile): Promise<boolean> {
    let current: Identity | undefined;
    try { current = await this.#identityOfPath(partial.path); }
    catch (error) { if (!isMissingPathError(error)) return false; }
    if (current && sameIdentity(current, partial.identity)) {
      try { await retryWhileBusy(() => this.#fs.unlink(partial.path), this.#sleep); }
      catch (error) { if (!isMissingPathError(error)) return false; }
    }
    this.#live.delete(partial.id);
    await this.#journal.drop(partial.id);
    return true;
  }

  // ── Publishing ──

  /**
   * Publishes a finished partial under the target's name in the partial's folder.
   *
   * - `number`: the first free name of `base.ext`, `base (1).ext`, … that no other item of the
   *   batch holds, without ever replacing a file: a hard link, else (any link error but `EEXIST`)
   *   an exclusive placeholder the partial is renamed over.
   * - `overwrite`: a regular file under the exact name is moved to the recycle bin first
   *   (`overwrite_trash_failed` when it cannot be, never deleted), unless it is an input
   *   (`output_is_input`); a folder or link there is never moved, the output is numbered instead.
   *   A name another item of the batch holds is numbered as well.
   *
   * On failure the partial is discarded. The partial's identity is checked before every step.
   */
  async publish(partial: PartialFile, request: OutputTarget): Promise<PublishResult> {
    let base: string;
    try { base = this.#targetPath(partial.directory, request); }
    catch (error) {
      await this.discardPartial(partial).catch(() => false);
      throw error;
    }
    const warnings = new Set<OutputWarning>();
    const placement: Placement = { linkUnsupported: false };
    const done = (target: string, replaced: boolean): PublishResult => {
      this.#claims.publish(request.owner, target);
      return { path: target, replaced, warnings: [...warnings] };
    };
    try {
      await this.#assertPartial(partial);
      if (!this.#claims.claim(request.owner, base)) warnings.add('output_name_collision');
      if (request.conflict === 'overwrite' && !this.#claims.heldByOther(request.owner, base)) {
        if (base.length > OUTPUT_POLICY.maxPathChars) throw new OutputError('output_path_too_long', 'The output path is too long.');
        const replaced = await this.#overwrite(partial, base, request.inputs, placement);
        if (replaced !== null) return done(base, replaced);
      }
      for (let index = 0; index < OUTPUT_POLICY.maxNumbered; index++) {
        const candidate = path.join(partial.directory, numberedName(request.baseName, request.extension, index));
        if (candidate.length > OUTPUT_POLICY.maxPathChars) throw new OutputError('output_path_too_long', 'The numbered output path is too long.');
        if (this.#claims.heldByOther(request.owner, candidate)) { warnings.add('output_name_collision'); continue; }
        if (await this.#place(partial, candidate, placement) === 'placed') return done(candidate, false);
      }
      throw new OutputError('output_dir_unwritable', 'Every numbered output name is taken.');
    } catch (error) {
      await this.discardPartial(partial).catch(() => false);
      throw error instanceof OutputError ? error : new OutputError('output_dir_unwritable', 'The output could not be published.', { cause: error });
    }
  }

  #targetPath(directory: string, target: Pick<OutputTarget, 'baseName' | 'extension'>) {
    if (!fullyQualifiedPath(directory)) throw new OutputError('output_dir_unwritable', 'The output folder is not a full path.');
    return path.join(path.normalize(directory), numberedName(target.baseName, target.extension, 0));
  }

  /** Replaced → true, nothing there → false, a non-file or a name that cannot be inspected there → null (number instead). */
  async #overwrite(partial: PartialFile, target: string, inputs: readonly string[], placement: Placement): Promise<boolean | null> {
    let replaced = false;
    for (let round = 0; round < OUTPUT_POLICY.overwriteRounds; round++) {
      let existing: BigIntStats | undefined;
      // A name that cannot be inspected (a file pending deletion answers EPERM) is never moved: the output is numbered instead.
      try { existing = await lstat(target, { bigint: true }); }
      catch (error) { if (!isMissingPathError(error)) return null; }
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) return null;
        if (await outputIsInput(target, inputs, this.#identityOptions())) throw new OutputError('output_is_input', 'The output would replace an input.');
        try { await retryWhileBusy(() => this.#trashItem(target), this.#sleep); }
        catch (error) { throw new OutputError('overwrite_trash_failed', 'The replaced file could not be moved to the recycle bin.', { cause: error }); }
        replaced = true;
      }
      // Never a plain rename onto the name: a file that appeared after the trash is not replaced unseen.
      if (await this.#place(partial, target, placement) === 'placed') return replaced;
    }
    throw new OutputError('overwrite_trash_failed', 'A file kept reappearing under the output name.');
  }

  /** Puts the partial under `candidate` without replacing anything there. */
  async #place(partial: PartialFile, candidate: string, placement: Placement): Promise<'placed' | 'exists'> {
    await this.#assertPartial(partial);
    if (placement.linkUnsupported) return this.#placeOverPlaceholder(partial, candidate);
    try { await this.#fs.link(partial.path, candidate); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') return 'exists';
      // exFAT answers EISDIR; FAT, shares and other file systems EPERM, ENOTSUP, EXDEV or codes of their own.
      placement.linkUnsupported = true;
      return this.#placeOverPlaceholder(partial, candidate);
    }
    if (!(await this.#holds(candidate, partial.identity))) {
      // The partial name was swapped between the check and the link: take back only the name just made.
      await retryWhileBusy(() => this.#fs.unlink(candidate), this.#sleep).catch(() => undefined);
      throw new OutputError('output_dir_unwritable', 'The partial file was replaced before it was published.');
    }
    // FK-PIT-0044: the partial name goes before anything reads the published file. If it cannot be
    // removed it stays a second name of the published file, and its record leads the startup cleanup to it.
    await this.discardPartial(partial);
    return 'placed';
  }

  /** Where the volume cannot link: an exclusive placeholder under `candidate`, then the partial renamed over it. */
  async #placeOverPlaceholder(partial: PartialFile, candidate: string): Promise<'placed' | 'exists'> {
    let handle: FileHandle;
    try { handle = await this.#fs.open(candidate, 'wx'); }
    catch (error) {
      // A file pending deletion still holds its name and refuses the create with EPERM: that name is taken too.
      if (errorCode(error) === 'EEXIST' || (BUSY.has(errorCode(error) ?? '') && await this.#nameHeld(candidate))) return 'exists';
      throw new OutputError('output_dir_unwritable', 'The output name could not be reserved.', { cause: error });
    }
    let placeholder: Identity;
    try { placeholder = await this.#identityOfHandle(handle); }
    catch (error) { throw new OutputError('output_dir_unwritable', 'The output placeholder has no identity.', { cause: error }); }
    finally { await handle.close().catch(() => undefined); }
    let size: bigint;
    try {
      await this.#assertPartial(partial);
      size = (await lstat(partial.path, { bigint: true })).size;
      // The rename replaces whatever the name holds: only the empty placeholder made above, never what another program wrote there since.
      if (!(await this.#isPlaceholder(candidate, placeholder))) return 'exists';
      await retryWhileBusy(() => this.#fs.rename(partial.path, candidate), this.#sleep);
    } catch (error) {
      await this.#removePlaceholder(candidate, placeholder);
      throw error instanceof OutputError ? error : new OutputError('output_dir_unwritable', 'The output could not be renamed into place.', { cause: error });
    }
    this.#live.delete(partial.id);
    await this.#journal.drop(partial.id);
    // A FAT volume may give the renamed file another FileId (or none), so there only its size can be
    // checked; so is a volume of unknown type (a share, a failed query), rather than fail a file in place.
    const fileSystem = usableObjectIdentity(partial.identity) ? await this.#fileSystemOf(partial.directory) : null;
    const intact = fileSystem === null || FAT_FAMILY.has(fileSystem) ? await this.#hasSize(candidate, size) : await this.#holds(candidate, partial.identity);
    if (!intact) throw new OutputError('output_dir_unwritable', 'The published file is not the converted one.');
    return 'placed';
  }

  /** The name still holds the placeholder: the same file, still empty. */
  async #isPlaceholder(candidate: string, placeholder: Identity): Promise<boolean> {
    try {
      const current = await lstat(candidate, { bigint: true });
      return current.isFile() && !current.isSymbolicLink() && current.size === 0n && sameIdentity(await this.#identityOfPath(candidate), placeholder);
    } catch { return false; }
  }

  /** Only a placeholder that is still empty and still the same file is removed; anything that cannot be proven to be it stays. */
  async #removePlaceholder(candidate: string, placeholder: Identity) {
    if (await this.#isPlaceholder(candidate, placeholder)) await retryWhileBusy(() => this.#fs.unlink(candidate), this.#sleep).catch(() => undefined);
  }

  /** Something holds the name: a file, or one pending deletion, whose lstat answers EPERM. */
  async #nameHeld(candidate: string): Promise<boolean> {
    try { await lstat(candidate); return true; } catch (error) { return BUSY.has(errorCode(error) ?? ''); }
  }

  async #assertPartial(partial: PartialFile) {
    if (!(await this.#holds(partial.path, partial.identity))) throw new OutputError('output_dir_unwritable', 'The partial file was replaced or removed.');
  }

  async #holds(target: string, identity: Identity): Promise<boolean> {
    try { return sameIdentity(await this.#identityOfPath(target), identity); } catch { return false; }
  }

  async #hasSize(target: string, size: bigint): Promise<boolean> {
    try {
      const current = await lstat(target, { bigint: true });
      return current.isFile() && current.size === size;
    } catch { return false; }
  }

  #identityOptions(): IdentityOptions {
    return { identityOfPath: this.#identityOfPath, platform: this.#platform };
  }

  /** Cached per drive and volume for the session; a query that fails counts as unknown. */
  async #fileSystemOf(directory: string): Promise<string | null> {
    let key: string;
    try { key = `${path.parse(path.resolve(directory)).root.toLowerCase()}|${await this.#volumeOf(directory)}`; }
    catch { return null; }
    let pending = this.#fileSystems.get(key);
    if (!pending) {
      pending = this.#volumeFileSystem(directory).catch(() => null);
      this.#fileSystems.set(key, pending);
    }
    return pending;
  }

  // ── Startup ──

  /**
   * Settles every record of `partials.json` left by an earlier run, then empties `work/`.
   *
   * - Volume not mounted (or another volume where it was), or the delete failed: kept for later.
   * - File gone, or its folder gone from a mounted volume: record removed.
   * - Name and identity match: file deleted, record removed.
   * - Another file under the name (identity differs; or non-empty where no identity was recorded):
   *   not ours, left alone, record removed.
   */
  async cleanupAtStartup(): Promise<StartupCleanupReport> {
    const report: StartupCleanupReport = { deleted: 0, removed: 0, kept: 0, workCleared: false };
    const records = await this.#journal.records().catch(() => new Map<string, PartialRecord>());
    for (const record of [...records.values()]) {
      if (this.#live.has(record.id)) continue;
      const outcome = await this.#settle(record);
      if (outcome === 'keep') { report.kept++; continue; }
      await this.#journal.drop(record.id);
      if (outcome === 'deleted') report.deleted++; else report.removed++;
    }
    try {
      await rm(this.workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await mkdir(this.workRoot, { recursive: true });
      report.workCleared = (await readdir(this.workRoot)).length === 0;
    } catch { report.workCleared = false; }
    return report;
  }

  async #settle(record: PartialRecord): Promise<'deleted' | 'absent' | 'keep'> {
    const directory = path.dirname(record.path);
    let volume: string;
    try { volume = await this.#volumeOf(directory); }
    catch (error) {
      if (!isMissingPathError(error)) return 'keep';
      // The folder is gone. So is the partial when the nearest folder still there is on the recorded
      // volume; otherwise that volume is not mounted (another one may have taken its drive letter).
      return await this.#nearestVolume(directory) === record.volume ? 'absent' : 'keep';
    }
    if (volume !== record.volume) return 'keep';
    let current: Identity;
    try { current = await this.#identityOfPath(record.path); }
    catch (error) { return isMissingPathError(error) ? 'absent' : 'keep'; }
    // ffmpeg only runs once the identity is recorded, so without one only an empty file can be ours.
    const ours = record.identity ? sameIdentity(current, record.identity) : await this.#hasSize(record.path, 0n);
    if (!ours) return 'absent';
    try { await retryWhileBusy(() => this.#fs.unlink(record.path), this.#sleep); return 'deleted'; }
    catch (error) { return isMissingPathError(error) ? 'absent' : 'keep'; }
  }

  /** The volume of the nearest existing folder above `directory`; undefined when even its root is gone. */
  async #nearestVolume(directory: string): Promise<string | undefined> {
    for (let folder = path.dirname(directory); ; folder = path.dirname(folder)) {
      try { return await this.#volumeOf(folder); }
      catch (error) { if (!isMissingPathError(error) || path.dirname(folder) === folder) return undefined; }
    }
  }
}
