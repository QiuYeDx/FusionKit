import type { BrowserWindow, Clipboard, Dialog, OpenDialogOptions, Shell } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { LONG_TEXT_LIMITS, type LongTextRequest, type LongTextValues } from '../../../src/long-text/contract';
import { exportName, numberedName, type ExportName } from '../../../src/long-text/export-name';
import { SEGMENT_FLAG, type TranslationRecord } from '../../../src/long-text/model';
import { rebuild, translationOf, type ExportMode } from '../../../src/long-text/rebuild';
import type { LoadedDocument } from './document-state';
import { LongTextOperationError } from './repository';

/**
 * Export, copy and reveal (design §6.12 “写出”). Files are assembled by `rebuild`, written as UTF-8
 * without a BOM and published next to the source or into the folder chosen in the native dialog,
 * never over an existing file: a temporary file is hard-linked to the first free name, or, where the
 * file system has no hard links, the name is created exclusively. File names come from
 * `src/long-text/export-name.ts`, which the export dialog previews with.
 */

export type ExportDestination = LongTextRequest<'export'>['destination'];
export type RevealTarget = LongTextRequest<'reveal'>['target'];
/** What the exporter reads and records; `LoadedDocument` provides it. */
export type ExportDocument = Pick<LoadedDocument, 'source' | 'table' | 'manifest' | 'translationAt' | 'updateManifest'>;

export interface ExporterOptions {
  /** `app`: the system Documents folder is the export folder until one is chosen. */
  paths: { getPath(name: 'documents'): string };
  dialog: Pick<Dialog, 'showOpenDialog'>;
  clipboard: Pick<Clipboard, 'writeText'>;
  shell: Pick<Shell, 'showItemInFolder'>;
  /** The window the folder dialog belongs to. */
  getWindow?: () => BrowserWindow | null;
  /** Decides whether paths compare without case (win32 and darwin). */
  platform?: NodeJS.Platform;
  now?: () => number;
}

const MAX_NUMBER = 99;
/**
 * `link` failures that mean the file system cannot hard-link here, so the name is created directly.
 * On Windows, FAT32 and exFAT fail CreateHardLinkW with ERROR_INVALID_FUNCTION, which libuv reports as
 * EISDIR. Some SMB servers fail it with ERROR_INVALID_PARAMETER, reported as EINVAL.
 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EISDIR', 'EINVAL']);
const DESTINATION_ERRORS = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'ENAMETOOLONG']);
const STORAGE_ERRORS = new Set(['ENOSPC', 'EDQUOT']);

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code ?? '';
const isDirectory = (target: string) => fs.stat(target).then(stat => stat.isDirectory(), () => false);
const isFile = (target: string) => fs.stat(target).then(stat => stat.isFile(), () => false);

/** Whether two paths name the same file; win32 and darwin file systems ignore case. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = (target: string) => {
    const resolved = path.resolve(target).normalize('NFC');
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  return key(a) === key(b);
}

/** A file system failure as the error code the renderer shows. */
function exportFailure(error: unknown): LongTextOperationError {
  if (error instanceof LongTextOperationError) return error;
  const code = errorCode(error);
  if (STORAGE_ERRORS.has(code)) return new LongTextOperationError('storage_failed', { cause: error });
  if (DESTINATION_ERRORS.has(code)) return new LongTextOperationError('destination_unavailable', { cause: error });
  return new LongTextOperationError('export_failed', { cause: error });
}

/** The export text, without a leading BOM, and how many translatable segments it translates. */
function assemble(document: ExportDocument, mode: ExportMode): { text: string; translated: number; untranslated: number } {
  const { table, manifest } = document;
  const translations = new Array<TranslationRecord | undefined>(table.count);
  let translated = 0;
  let untranslated = 0;
  for (let index = 0; index < table.count; index++) {
    const record = document.translationAt(index);
    translations[index] = record;
    if (!(table.flags[index] & SEGMENT_FLAG.translatable)) continue;
    // What `rebuild` writes in place of the source.
    if (translationOf(record) !== null) translated++;
    else untranslated++;
  }
  const text = rebuild(document.source, table, translations, { mode, format: manifest.format, lineEnding: manifest.lineEnding });
  return { text: text.startsWith('\uFEFF') ? text.slice(1) : text, translated, untranslated };
}

/** Creates `file` only when no file has that name: false when one does. */
async function createExclusive(file: string, bytes: Uint8Array): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'wx');
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    // `wx` created the file, so a partial one is ours to remove.
    await handle.close().catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}

/**
 * Writes `.lt-<uuid>.tmp` in `folder`, fsyncs it and hard-links it to the first candidate name that is
 * free and not `skip`ped; `link` never replaces a file. Where hard links are unsupported, the same
 * candidates are created exclusively instead. The temporary file is always removed.
 */
async function publish(folder: string, name: ExportName, bytes: Uint8Array, skip: (file: string) => boolean): Promise<{ path: string; name: string }> {
  const temporary = path.join(folder, `.lt-${randomUUID()}.tmp`);
  let created = false;
  try {
    // The default mode (0o666 & ~umask), as `createExclusive` and an ordinary save: the link shares it.
    const handle = await fs.open(temporary, 'wx');
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    let linking = true;
    for (let number = 1; number <= MAX_NUMBER; number++) {
      const fileName = numberedName(name, number);
      const file = path.join(folder, fileName);
      if (skip(file)) continue;
      if (linking) {
        try {
          await fs.link(temporary, file);
          return { path: file, name: fileName };
        } catch (error) {
          if (errorCode(error) === 'EEXIST') continue;
          if (!LINK_UNSUPPORTED.has(errorCode(error))) throw error;
          linking = false;
        }
      }
      if (await createExclusive(file, bytes)) return { path: file, name: fileName };
    }
    throw new LongTextOperationError('name_exhausted');
  } catch (error) {
    throw exportFailure(error);
  } finally {
    if (created) await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class LongTextExporter {
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: ExporterOptions) {
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
  }

  /** The native folder dialog; the chosen folder becomes the document's export folder. Null when cancelled. */
  async chooseFolder(document: ExportDocument): Promise<LongTextValues['chooseExportFolder']> {
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const defaultPath = document.manifest.exportFolder ?? this.documentsFolder();
    if (defaultPath) options.defaultPath = defaultPath;
    const window = this.options.getWindow?.();
    const { dialog } = this.options;
    const selection = window && !window.isDestroyed() ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folder = selection.canceled ? undefined : selection.filePaths[0];
    if (!folder) return null;
    await document.updateManifest(manifest => {
      manifest.exportFolder = folder;
    }, { immediate: true });
    return { path: folder };
  }

  /**
   * Publishes the export under a new name and records it in `manifest.exports`. Untranslated segments
   * keep their source; `translated` and `untranslated` count translatable segments.
   */
  async export(document: ExportDocument, mode: ExportMode, destination: ExportDestination): Promise<LongTextValues['export']> {
    const folder = await this.folder(document, destination);
    const { manifest } = document;
    const { text, translated, untranslated } = assemble(document, mode);
    const sourcePath = manifest.source.kind === 'file' ? manifest.source.path : null;
    const name = exportName(
      { fileName: sourcePath && path.basename(sourcePath), name: manifest.name, format: manifest.format },
      manifest.settings.targetLanguage, mode,
    );
    const published = await publish(folder, name, Buffer.from(text, 'utf8'), file => sourcePath !== null && samePath(file, sourcePath, this.platform));
    await this.record(document, { ...published, mode, at: this.now() });
    return { ...published, translated, untranslated };
  }

  /** Writes the same text an export would to the clipboard, up to 20,000,000 characters. */
  copy(document: ExportDocument, mode: ExportMode): LongTextValues['copy'] {
    const { text } = assemble(document, mode);
    if (text.length > LONG_TEXT_LIMITS.copyChars) throw new LongTextOperationError('limit_exceeded');
    this.options.clipboard.writeText(text);
    return { characters: text.length };
  }

  /** Shows the source file or the latest export in the file manager; never a path from the renderer. */
  async reveal(document: ExportDocument, target: RevealTarget): Promise<LongTextValues['reveal']> {
    const { source, exports } = document.manifest;
    let file: string;
    if (target === 'source') {
      if (source.kind !== 'file') throw new LongTextOperationError('invalid_request');
      if (!(await isFile(source.path))) throw new LongTextOperationError('source_missing');
      file = source.path;
    } else if (target === 'export') {
      const latest = exports[0];
      if (!latest || !(await isFile(latest.path))) throw new LongTextOperationError('not_found');
      file = latest.path;
    } else {
      throw new LongTextOperationError('invalid_request');
    }
    this.options.shell.showItemInFolder(file);
    return {};
  }

  /** The source file's folder, or the chosen export folder (the Documents folder until one is chosen); it must exist. */
  private async folder(document: ExportDocument, destination: ExportDestination): Promise<string> {
    const { source, exportFolder } = document.manifest;
    let folder: string | null;
    if (destination === 'source') {
      if (source.kind !== 'file') throw new LongTextOperationError('invalid_request');
      folder = path.dirname(source.path);
    } else {
      folder = exportFolder ?? this.documentsFolder();
    }
    if (!folder || !path.isAbsolute(folder) || !(await isDirectory(folder))) throw new LongTextOperationError('destination_unavailable');
    return folder;
  }

  private documentsFolder(): string | null {
    try {
      return this.options.paths.getPath('documents');
    } catch {
      return null;
    }
  }

  /** The file is published by now, so a failure to record it is only logged. */
  private async record(document: ExportDocument, entry: { path: string; name: string; mode: ExportMode; at: number }): Promise<void> {
    try {
      await document.updateManifest(manifest => {
        manifest.exports.unshift(entry);
      }, { immediate: true, keepOnFailure: true });
    } catch (error) {
      console.warn('[long-text] Could not record the export', error);
    }
  }
}
