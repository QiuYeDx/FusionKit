import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineReasonCode } from '../../../../src/media-converter/contract';
import { resolveDroppedInputPaths, type NativeInputSelection } from '../../subtitle-studio/drop-input-service';
import { localSubtitleFileIdentityFromBigIntStats, sameLocalSubtitleFilesystemObjectIdentity, snapshotLocalSubtitleFilesystemObjectIdentity,
  type LocalSubtitleFilesystemObjectIdentity } from '../../subtitle-studio/transcription/native/filesystem-object-identity';
import { usableObjectIdentity } from './probe';

/**
 * Inputs of the media converter (design §8). The main process keeps the only copy of every input
 * path; the renderer knows an item id, a display name and a folder name. Each input remembers the
 * state it had when it was added (volume and FileId, size, modification time), so a file that was
 * replaced or edited since is never converted under the old plan (`input_changed`).
 *
 * Dropped paths go through the shared Explorer drop resolver (FK-PIT-0099) with the converter's own
 * reason codes. The resolver refuses a whole batch when one %TEMP% proxy cannot be traced back to
 * its source; only those proxies stay refused, every file that was never in %TEMP% is kept.
 */

type Identity = LocalSubtitleFilesystemObjectIdentity;
export type InputRejectionCode = Extract<EngineReasonCode, 'folder_not_supported' | 'not_a_regular_file' | 'file_unavailable' | 'temporary_copy_unresolved'>;
export type InputCheckCode = Extract<EngineReasonCode, 'input_missing' | 'input_changed'>;
type StateFailure = Exclude<InputRejectionCode, 'temporary_copy_unresolved'>;

/**
 * What identifies an input: the object (null when the file system gives none), size and
 * modification time. ctime is left out: players and Explorer touch it without changing the file.
 */
export interface InputFileState {
  readonly objectIdentity: Identity | null;
  readonly size: number;
  readonly mtimeMs: number;
}

const errorCode = (error: unknown) => typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
  ? (error as { code: string }).code : undefined;
export const isMissingPathError = (error: unknown) => errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';

/**
 * A drive, UNC or `\\?\` path that names one file whatever the working directory: no relative
 * name, no Windows `\dir` without its drive, no NUL.
 */
export function fullyQualifiedPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) return false;
  // A folder may end in a separator, which `resolve` drops (a root keeps its own).
  const normalized = path.normalize(filePath);
  const trimmed = normalized.length > path.parse(normalized).root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
  return path.resolve(filePath) === trimmed;
}

/** The real path, else the resolved one; case-folded on Windows, where names differing in case are one file. */
export async function canonicalPath(filePath: string, platform: NodeJS.Platform | string = process.platform): Promise<string> {
  let resolved: string;
  try { resolved = await realpath(filePath); } catch { resolved = path.resolve(filePath); }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** `child` is `parent` or inside it; both canonical. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The state of a regular file, or why it cannot be an input. Links and junctions are refused, never followed. */
export async function readInputState(filePath: string): Promise<InputFileState | StateFailure> {
  if (!fullyQualifiedPath(filePath)) return 'file_unavailable';
  let stats: BigIntStats;
  try { stats = await lstat(filePath, { bigint: true }); } catch { return 'file_unavailable'; }
  if (stats.isDirectory()) return 'folder_not_supported';
  if (stats.isSymbolicLink() || !stats.isFile()) return 'not_a_regular_file';
  try {
    const identity = localSubtitleFileIdentityFromBigIntStats(stats);
    return { objectIdentity: identity.objectIdentity, size: identity.size, mtimeMs: identity.mtimeMs };
  } catch {
    const size = Number(stats.size);
    return Number.isSafeInteger(size) ? { objectIdentity: null, size, mtimeMs: Number(stats.mtimeNs) / 1e6 } : 'file_unavailable';
  }
}

export function sameInputState(a: InputFileState, b: InputFileState): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs &&
    (a.objectIdentity === null || b.objectIdentity === null ? a.objectIdentity === b.objectIdentity : sameLocalSubtitleFilesystemObjectIdentity(a.objectIdentity, b.objectIdentity));
}

// ── Registry ───────────────────────────────────────────────────────────────────────────────────

/** What the queue persists for an input (`state.json`) and hands back on restore. */
export interface InputEntry {
  readonly id: string;
  readonly path: string;
  readonly state: InputFileState;
}
export interface RegisteredInput extends InputEntry {
  /** The only parts of the path the renderer ever sees. */
  readonly displayName: string;
  readonly folderName: string;
}
export type InputAddResult = { ok: true; input: RegisteredInput; duplicate: boolean } | { ok: false; code: StateFailure };

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A state read back from `state.json` in the shape `readInputState` gives, else undefined. */
function persistedState(value: unknown): InputFileState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { objectIdentity, size, mtimeMs } = value as Record<string, unknown>;
  const identity = objectIdentity === null ? null : snapshotLocalSubtitleFilesystemObjectIdentity(objectIdentity);
  if (identity === undefined || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
    || typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined;
  return { objectIdentity: identity, size, mtimeMs };
}

/** The parent folder's own name: `D:` for a drive root, the share for a UNC root. */
function folderNameOf(filePath: string): string {
  const parsed = path.parse(filePath);
  return path.basename(parsed.dir) || parsed.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || parsed.root;
}

export interface InputRegistryOptions {
  platform?: NodeJS.Platform | string;
  /** Item ids; tests pin them. */
  createId?: () => string;
}

/**
 * Item id → authorized input. Adding the same file twice (by volume and FileId, else by the
 * case-folded path where the file system has no usable FileId) returns the existing item.
 */
export class InputRegistry {
  readonly #items = new Map<string, RegisteredInput>();
  readonly #platform: NodeJS.Platform | string;
  readonly #createId: () => string;

  constructor(options: InputRegistryOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#createId = options.createId ?? randomUUID;
  }

  /** `filePath` comes from the main-process picker or the drop wrapper below, never from the renderer. */
  async add(filePath: string): Promise<InputAddResult> {
    const state = await readInputState(filePath);
    if (typeof state === 'string') return { ok: false, code: state };
    const normalized = path.normalize(filePath);
    // Synchronous from here on, so two concurrent adds of one file cannot both create an item.
    const existing = this.#find(normalized, state);
    if (existing) return { ok: true, input: existing, duplicate: true };
    let id = this.#createId();
    while (this.#items.has(id)) id = this.#createId();
    const input = this.#entry({ id, path: normalized, state });
    this.#items.set(id, input);
    return { ok: true, input, duplicate: false };
  }

  /** Puts back an input the queue persisted, with the state it had when it was added; `verify` then tells whether it changed since. */
  restore(entry: InputEntry): RegisteredInput {
    const state = persistedState(entry.state);
    if (!ITEM_ID.test(entry.id) || !fullyQualifiedPath(entry.path) || !state) throw new TypeError('The persisted media input is invalid.');
    const input = this.#entry({ id: entry.id, path: path.normalize(entry.path), state });
    this.#items.set(input.id, input);
    return input;
  }

  get(itemId: string): RegisteredInput | undefined {
    return this.#items.get(itemId);
  }

  resolveItemPath(itemId: string): string | null {
    return this.#items.get(itemId)?.path ?? null;
  }

  describe(itemId: string): { displayName: string; folderName: string } | null {
    const input = this.#items.get(itemId);
    return input ? { displayName: input.displayName, folderName: input.folderName } : null;
  }

  /** Before an item runs (and after a restart): `input_missing` when the file is gone, `input_changed` when it is another file or was edited. */
  async verify(itemId: string): Promise<InputCheckCode | null> {
    const input = this.#items.get(itemId);
    if (!input) return 'input_missing';
    const current = await readInputState(input.path);
    if (current === 'file_unavailable') return 'input_missing';
    if (typeof current === 'string') return 'input_changed';
    return sameInputState(input.state, current) ? null : 'input_changed';
  }

  /** A retry accepts the file as it is now: its current state becomes the reference. */
  async refresh(itemId: string): Promise<InputCheckCode | null> {
    const input = this.#items.get(itemId);
    if (!input) return 'input_missing';
    const current = await readInputState(input.path);
    if (current === 'file_unavailable') return 'input_missing';
    if (typeof current === 'string') return 'input_changed';
    if (this.#items.get(itemId) === input) this.#items.set(itemId, { ...input, state: current });
    return null;
  }

  remove(itemId: string): boolean {
    return this.#items.delete(itemId);
  }

  /** Every input path, for the `output_is_input` checks. */
  paths(): string[] {
    return [...this.#items.values()].map(input => input.path);
  }

  entries(): InputEntry[] {
    return [...this.#items.values()].map(({ id, path: filePath, state }) => ({ id, path: filePath, state }));
  }

  #entry(entry: InputEntry): RegisteredInput {
    return Object.freeze({ id: entry.id, path: entry.path, state: Object.freeze({ ...entry.state }),
      displayName: path.basename(entry.path), folderName: folderNameOf(entry.path) });
  }

  #find(normalized: string, state: InputFileState): RegisteredInput | undefined {
    const key = this.#pathKey(normalized);
    for (const input of this.#items.values()) {
      const a = state.objectIdentity, b = input.state.objectIdentity;
      if (usableObjectIdentity(a) && usableObjectIdentity(b) ? sameLocalSubtitleFilesystemObjectIdentity(a, b) : this.#pathKey(input.path) === key) return input;
    }
    return undefined;
  }

  #pathKey(filePath: string) {
    return this.#platform === 'win32' ? path.win32.resolve(filePath).toLowerCase() : path.resolve(filePath);
  }
}

// ── Drop ───────────────────────────────────────────────────────────────────────────────────────

export type DroppedInput = { ok: true; path: string; fileName: string } | { ok: false; displayName: string; code: InputRejectionCode };

export interface DropResolveOptions {
  /** `resolveDroppedInputPaths`; tests substitute it. */
  resolve?: (paths: readonly string[]) => Promise<readonly NativeInputSelection[]>;
  /** `os.tmpdir()`, where Explorer materializes its Shell proxies. */
  tempDirectory?: string;
  platform?: NodeJS.Platform | string;
}

const displayNameOf = (filePath: string) => path.basename(String(filePath)).slice(0, 1000) || '—';

/**
 * Resolves the paths the preload took from dropped `File`s, one result per path in drop order.
 * Codes: a folder is `folder_not_supported`, a link or another non-regular file
 * `not_a_regular_file`, a missing file `file_unavailable`, an Explorer %TEMP% proxy whose source
 * cannot be proven `temporary_copy_unresolved`.
 */
export async function resolveDroppedMediaPaths(paths: readonly string[], options: DropResolveOptions = {}): Promise<DroppedInput[]> {
  const platform = options.platform ?? process.platform;
  let selections: readonly NativeInputSelection[] | undefined;
  try { selections = await (options.resolve ?? resolveDroppedInputPaths)(paths); } catch { selections = undefined; }
  if (!selections || selections.length !== paths.length) {
    selections = paths.map(filePath => ({ fileName: displayNameOf(filePath), error: 'access_denied' as const }));
  }
  const temp = await canonicalPath(options.tempDirectory ?? os.tmpdir(), platform);
  return Promise.all(selections.map((selection, index) => settleDrop(paths[index], selection, temp, platform)));
}

async function settleDrop(requested: string, selection: NativeInputSelection, temp: string, platform: NodeJS.Platform | string): Promise<DroppedInput> {
  if (selection.path !== undefined) return { ok: true, path: selection.path, fileName: selection.fileName };
  const displayName = selection.fileName || displayNameOf(requested);
  const reject = (code: InputRejectionCode): DroppedInput => ({ ok: false, displayName, code });
  switch (selection.error) {
    case 'document_unavailable': return reject('file_unavailable');
    // The resolver reports folders as invalid input too.
    case 'invalid_input': return reject(await readInputState(requested) === 'folder_not_supported' ? 'folder_not_supported' : 'not_a_regular_file');
    case 'access_denied': {
      if (!fullyQualifiedPath(requested)) return reject('file_unavailable');
      // A refused batch: only a path inside %TEMP% can be a Shell proxy without source authority.
      if (isInside(temp, await canonicalPath(requested, platform))) return reject('temporary_copy_unresolved');
      const state = await readInputState(requested);
      return typeof state === 'string' ? reject(state) : { ok: true, path: path.normalize(requested), fileName: path.basename(requested) };
    }
    default: return reject('file_unavailable');
  }
}
