import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow, Dialog, FileFilter, IpcMain, IpcMainInvokeEvent, OpenDialogOptions, Shell } from 'electron';
import type { z } from 'zod';
import { MEDIA_CONVERTER_CHANNELS } from '../../../src/media-converter/channels';
import {
  itemFailureCodeSchema, mediaConverterRequestSchemas,
  type AddFilesResult, type ItemFailureCode, type MediaConverterError, type MediaConverterMethod, type MediaConverterRequest, type MediaConverterResult,
  type MediaConverterValues, type PickFileFilter, type QueueEvent,
} from '../../../src/media-converter/contract';
import { isTrustedAppSender } from '../fs/trusted-sender';
import type { MediaCapabilities } from './engine/capabilities';
import { resolveDroppedMediaPaths, type DropResolveOptions } from './engine/inputs';
import { MediaRuntimeError } from './engine/runtime';
import type { MediaQueue } from './queue/queue';
import { MediaQueueError } from './queue/types';
import type { MediaRevealOverride } from './test-hooks';

/**
 * The `media-converter:` IPC of the main process (module-engine design §8, R-ENGINE-07). Every
 * channel answers only the main frame of the application window, loaded from the app's own page
 * (the window's own webContents and main frame, and `isTrustedAppSender`); anything else, and any request that
 * fails its strict schema, is `invalid_request` and reaches no handler. Outside Windows every
 * channel stays registered and answers `platform_unsupported` without touching anything
 * (AC-ENGINE-01-3). Requests wait for the startup cleanup and the queue's restore.
 *
 * Paths stay in the main process: a drop's paths come from the preload, which read them from the
 * dropped `File`s, and go through the converter's drop wrapper (`resolveDroppedMediaPaths`); the
 * dialogs run here; "show in folder" takes an item id and opens only an output this tool published.
 * The renderer gets ids, display names, folder names, media summaries and redacted logs.
 */

export type MediaConverterHandlers = { [K in MediaConverterMethod]: (request: MediaConverterRequest<K>) => Promise<MediaConverterValues[K]> };
export type MediaConverterIpc = Pick<IpcMain, 'handle' | 'removeHandler'>;

export const MEDIA_CONVERTER_METHODS = Object.freeze(Object.keys(mediaConverterRequestSchemas) as MediaConverterMethod[]);

const defaultLog = (message: string, error?: unknown) => console.warn(`[media-converter] ${message}`, error ?? '');

/** A request refused with an item failure code: `invalid_request`, `file_unavailable`, `busy`, or a plan's answer. */
export class MediaConverterRequestError extends Error {
  constructor(readonly code: ItemFailureCode, message: string) {
    super(message);
    this.name = 'MediaConverterRequestError';
  }
}

/** The error a renderer sees: a code only. Anything unexpected is logged here and answered `unknown`. */
export function toMediaConverterError(error: unknown, log: (message: string, error?: unknown) => void = defaultLog): MediaConverterError {
  if (error instanceof MediaConverterRequestError || error instanceof MediaQueueError || error instanceof MediaRuntimeError) {
    const code = itemFailureCodeSchema.safeParse(error.code);
    if (code.success) return { code: code.data };
  }
  log('A media converter request failed.', error);
  return { code: 'unknown' };
}

const failure = (code: ItemFailureCode): { ok: false; error: MediaConverterError } => ({ ok: false, error: { code } });

/**
 * The main frame of the application window, showing the app's own page (AC-ENGINE-07-1). The
 * sending frame must be that main frame itself: a frame that navigated or went away before the
 * request arrived has no `senderFrame`, and `isTrustedAppSender` would then judge the window's URL.
 */
export function mainWindowTrust(getWindow: () => BrowserWindow | null): (event: IpcMainInvokeEvent) => boolean {
  return event => {
    try {
      const window = getWindow();
      return !!window && !window.isDestroyed() && event.sender === window.webContents && !!event.senderFrame
        && event.senderFrame === event.sender.mainFrame && isTrustedAppSender(event);
    } catch {
      return false;
    }
  };
}

export interface MediaConverterIpcOptions {
  ipc: MediaConverterIpc;
  /** Null outside Windows: every request then answers `platform_unsupported` and no handler exists to run. */
  handlers: MediaConverterHandlers | null;
  /** Every request waits for it (the startup cleanup and the restore); it never rejects. */
  ready?: Promise<unknown>;
  trust: (event: IpcMainInvokeEvent) => boolean;
  log?: (message: string, error?: unknown) => void;
}

export interface MediaConverterIpcRegistration {
  /** From now on every request answers `busy` (the shutdown began); the channels stay registered, so a late renderer call still gets an answer. */
  close(): void;
  /** Removes every handler. */
  dispose(): void;
}

/** Registers a handler for every request channel. */
export function registerMediaConverterIpc(options: MediaConverterIpcOptions): MediaConverterIpcRegistration {
  const { ipc, handlers, trust } = options;
  const ready = options.ready ?? Promise.resolve();
  const log = options.log ?? defaultLog;
  let open = true;
  const invoke = async <K extends MediaConverterMethod>(method: K, event: IpcMainInvokeEvent, input: unknown): Promise<MediaConverterResult<MediaConverterValues[K]>> => {
    if (!handlers) return failure('platform_unsupported');
    if (!open) return failure('busy');
    let trusted = false;
    try { trusted = trust(event); } catch { trusted = false; }
    if (!trusted) return failure('invalid_request');
    const schema: z.ZodType = mediaConverterRequestSchemas[method];
    const parsed = schema.safeParse(input);
    if (!parsed.success) return failure('invalid_request');
    try { await ready; } catch { return failure('busy'); }
    if (!open) return failure('busy');
    try {
      return { ok: true, value: await handlers[method](parsed.data as MediaConverterRequest<K>) };
    } catch (error) {
      return { ok: false, error: toMediaConverterError(error, log) };
    }
  };
  for (const method of MEDIA_CONVERTER_METHODS) {
    ipc.handle(MEDIA_CONVERTER_CHANNELS[method], (event, input: unknown) => invoke(method, event, input));
  }
  return {
    close: () => { open = false; },
    dispose: () => {
      open = false;
      for (const method of MEDIA_CONVERTER_METHODS) ipc.removeHandler(MEDIA_CONVERTER_CHANNELS[method]);
    },
  };
}

/** Sends the queue's change events to the application window while it is alive. */
export function mediaConverterEventSender(getWindow: () => BrowserWindow | null): (event: QueueEvent) => void {
  return event => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    if (contents && !contents.isDestroyed()) contents.send(MEDIA_CONVERTER_CHANNELS.changed, event);
  };
}

/**
 * "Show in folder": Explorer selects the file. With `FUSIONKIT_TEST_MEDIA_REVEAL=record` (a test
 * build only, design §9) the call is recorded instead: its file name goes to `record`, a log line by default.
 */
export function mediaConverterRevealer(override: MediaRevealOverride | null, shell: Pick<Shell, 'showItemInFolder'>,
  record: (fileName: string) => void = fileName => console.info(`[media-converter] reveal-output recorded: ${fileName}`)): (filePath: string) => void {
  if (override === 'record') return filePath => record(path.basename(filePath));
  return filePath => shell.showItemInFolder(filePath);
}

// ── Handlers ───────────────────────────────────────────────────────────────────────────────────

/** Extensions the dialog offers; ffprobe decides what a file really is, whatever its extension. */
export const PICK_FILE_EXTENSIONS = Object.freeze({
  video: Object.freeze(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'asf', 'flv', 'f4v', 'ts', 'mts', 'm2ts', 'm2t', 'mpg', 'mpeg', 'm2v', 'vob',
    '3gp', '3g2', 'mxf', 'rm', 'rmvb', 'ogv', 'h264', '264', 'hevc', '265']),
  audio: Object.freeze(['mp3', 'm4a', 'm4b', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'aifc', 'ape', 'amr', 'ac3', 'eac3', 'dts',
    'caf', 'wv', 'tta', 'mka', 'w64', 'ra']),
});

/** The dialog's filters for `pick-files`; "all" offers every file as well, the media types first. */
export function pickFileFilters(filter: PickFileFilter): FileFilter[] {
  if (filter === 'video') return [{ name: 'Video', extensions: [...PICK_FILE_EXTENSIONS.video] }];
  if (filter === 'audio') return [{ name: 'Audio', extensions: [...PICK_FILE_EXTENSIONS.audio] }];
  return [{ name: 'Audio / Video', extensions: [...PICK_FILE_EXTENSIONS.video, ...PICK_FILE_EXTENSIONS.audio] }, { name: 'All files', extensions: ['*'] }];
}

type HandlerQueue = Pick<MediaQueue, 'snapshot' | 'add' | 'rememberOutputDirectory' | 'previewPlan' | 'start' | 'cancel' | 'remove' | 'retry' | 'clear'
  | 'outputPath' | 'setOptions'>;

export interface MediaConverterHandlerDependencies {
  queue: HandlerQueue;
  capabilities: Pick<MediaCapabilities, 'ensure' | 'redetect' | 'resolvedEncoders' | 'defaults'>;
  dialog: Pick<Dialog, 'showOpenDialog'>;
  /** The dialogs' parent. */
  getWindow: () => BrowserWindow | null;
  /** `mediaConverterRevealer`. */
  reveal: (filePath: string) => void;
  /** The drop wrapper's resolver and %TEMP%; tests substitute them. */
  drop?: DropResolveOptions;
  log?: (message: string, error?: unknown) => void;
}

const nothingAdded = (): AddFilesResult => ({ added: [], duplicates: [], rejected: [], truncated: 0 });

/** What serves each channel: the queue, the capability table and the dialogs. */
export function createMediaConverterHandlers(dependencies: MediaConverterHandlerDependencies): MediaConverterHandlers {
  const { queue, capabilities, dialog, getWindow, reveal } = dependencies;
  const log = dependencies.log ?? defaultLog;
  // The first visit to the tool page or the first added file starts the encoder detection, never the app start (AC-ENGINE-01-1).
  const detect = () => { capabilities.ensure().catch(error => log('The encoder detection could not start.', error)); };
  const showOpenDialog = (options: OpenDialogOptions) => {
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
  };

  return {
    getSnapshot: async () => {
      detect();
      // Only here: a notice (`state_reset`) goes out with the first snapshot that takes it.
      return { ...queue.snapshot(), resolvedEncoders: capabilities.resolvedEncoders(), defaults: capabilities.defaults() };
    },
    addDroppedFiles: async ({ paths }) => {
      detect();
      const dropped = await resolveDroppedMediaPaths(paths, dependencies.drop);
      const rejected: AddFilesResult['rejected'] = [];
      const accepted: string[] = [];
      for (const entry of dropped) {
        if (entry.ok) accepted.push(entry.path);
        else rejected.push({ displayName: entry.displayName, code: entry.code });
      }
      const result = accepted.length ? await queue.add(accepted) : nothingAdded();
      return { ...result, rejected: [...rejected, ...result.rejected] };
    },
    pickFiles: async ({ filter }) => {
      const selection = await showOpenDialog({ properties: ['openFile', 'multiSelections'], filters: pickFileFilters(filter) });
      if (selection.canceled || !selection.filePaths.length) return nothingAdded();
      detect();
      return queue.add(selection.filePaths);
    },
    pickOutputDirectory: async () => {
      const selection = await showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      const directory = selection.canceled ? undefined : selection.filePaths[0];
      return { directory: directory ? await queue.rememberOutputDirectory(directory) : null };
    },
    previewPlan: async ({ itemId, settings }) => {
      const preview = await queue.previewPlan(itemId, settings);
      if (!preview.ok) throw new MediaConverterRequestError(preview.code, 'No plan can be made for the item.');
      if (preview.status === 'ready') return { status: 'ready', plan: preview.plan };
      if (preview.status === 'skipped') return { status: 'skipped', reason: preview.reason, plan: preview.plan };
      // No encoder of the chosen codec works for this picture: the codecs that would, for "use X instead".
      return { status: 'error', reason: preview.reason, alternatives: [...preview.alternatives] };
    },
    start: request => queue.start(request),
    cancel: request => queue.cancel(request),
    remove: request => queue.remove(request),
    retry: request => queue.retry(request),
    clear: request => queue.clear(request),
    revealOutput: async ({ itemId, outputIndex }) => {
      const filePath = queue.outputPath(itemId, outputIndex ?? 0);
      if (!filePath) throw new MediaConverterRequestError('invalid_request', 'Only an output this tool published can be shown.');
      const stats = await lstat(filePath).catch(() => null);
      if (!stats?.isFile()) throw new MediaConverterRequestError('file_unavailable', 'The output is no longer there.');
      reveal(filePath);
      return {};
    },
    setOptions: patch => queue.setOptions(patch),
    redetectCapabilities: async () => {
      const answer = capabilities.redetect();
      if (!answer.ok) throw new MediaConverterRequestError(answer.code, 'The encoders cannot be detected again while a hardware encode runs.');
      return {};
    },
  };
}
