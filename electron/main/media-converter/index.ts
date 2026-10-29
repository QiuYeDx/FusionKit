import {
  app, dialog, ipcMain, powerSaveBlocker, shell,
  type BrowserWindow, type Dialog, type IpcMainInvokeEvent, type Shell,
} from 'electron';
import path from 'node:path';
import type { ApplicationShutdownReason } from '../app-shutdown';
import type { LocalSubtitleResourceEnvironment } from '../subtitle-studio/transcription/native/resource-path';
import { MediaCapabilities } from './engine/capabilities';
import { MediaConversionExecutor } from './engine/executor';
import { InputRegistry, type DropResolveOptions } from './engine/inputs';
import { MediaOutputs } from './engine/output';
import { MediaProber } from './engine/probe';
import { MediaRuntime } from './engine/runtime';
import {
  createMediaConverterHandlers, mainWindowTrust, mediaConverterEventSender, mediaConverterRevealer, registerMediaConverterIpc,
  type MediaConverterIpc,
} from './ipc';
import { MediaQueue } from './queue/queue';
import type { QueuePowerBlocker } from './queue/types';
import { resolveMediaTestHooks, type MediaTestHooks } from './test-hooks';

/**
 * Assembles the media converter in the main process (module-engine design §6, §8): the verified
 * bundled runtime, the prober, inputs, outputs, the capability table, the executor and the queue
 * over `<userData>/media-converter`, with the `media-converter:` IPC. Registration reads nothing
 * heavy: it empties the work folder and settles the partials left by an earlier run, then restores
 * the queue; requests wait for both. The runtime is verified and the encoders detected only when
 * the tool page first asks for a snapshot or the first file is added. Outside Windows (I1–I3) every
 * channel answers `platform_unsupported` and nothing else is built (AC-ENGINE-01-3).
 *
 * `shutdown` joins the shared application shutdown (AC-ENGINE-05-4): requests answer `busy`, the
 * queue stops scheduling, cancels its runs and waits for ffmpeg to close and the partials to be
 * removed (4 s at most), a detection in progress is stopped, then probes are ended.
 */

export const MEDIA_CONVERTER_POLICY = Object.freeze({
  /** A detection that does not stop within this is left behind by the shutdown. */
  detectionStopWaitMs: 4_000,
});

export interface RegisterMediaConverterOptions {
  getWindow: () => BrowserWindow | null;
  /** Where the verified transcription runtime is (development or packaged), as Subtitle Studio builds it. */
  environment: LocalSubtitleResourceEnvironment;
  /** `app.getPath('userData')`; the converter keeps its state in `<userData>/media-converter`. */
  userDataPath: string;
  platform: NodeJS.Platform | string;
  ipc?: MediaConverterIpc;
  dialog?: Pick<Dialog, 'showOpenDialog'>;
  shell?: Pick<Shell, 'showItemInFolder' | 'trashItem'>;
  powerSaveBlocker?: QueuePowerBlocker;
  /** `app.getGPUInfo('basic')`: the graphics cards and drivers that key `capabilities.json`. */
  gpuInfo?: () => Promise<unknown>;
  /** Default: `resolveMediaTestHooks(process.env, {packaged: app.isPackaged})`, nothing outside a test build. */
  testHooks?: MediaTestHooks;
  /** Default: the main frame of the application window, loaded from the app's own page. */
  trust?: (event: IpcMainInvokeEvent) => boolean;
  /** The drop wrapper's resolver and %TEMP%; tests substitute them. */
  drop?: DropResolveOptions;
  log?: (message: string, error?: unknown) => void;
}

export interface MediaConverterRegistration {
  /** The startup cleanup and the queue's restore; it never rejects. */
  readonly ready: Promise<void>;
  /** One promise for every caller; it never rejects. */
  shutdown(reason: ApplicationShutdownReason): Promise<void>;
}

const defaultLog = (message: string, error?: unknown) => console.warn(`[media-converter] ${message}`, error ?? '');

/** Resolves when `promise` settles or `milliseconds` pass, whichever is first. */
function settleWithin(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    promise.then(() => undefined, () => undefined).finally(() => { clearTimeout(timer); resolve(); });
  });
}

export function registerMediaConverter(options: RegisterMediaConverterOptions): MediaConverterRegistration {
  const { getWindow, platform } = options;
  const ipc = options.ipc ?? ipcMain;
  const trust = options.trust ?? mainWindowTrust(getWindow);
  const log = options.log ?? defaultLog;

  if (platform !== 'win32') {
    const registration = registerMediaConverterIpc({ ipc, handlers: null, trust, log });
    const stopped = Promise.resolve();
    return { ready: Promise.resolve(), shutdown: () => { registration.close(); return stopped; } };
  }

  const root = path.join(options.userDataPath, 'media-converter');
  const hooks = options.testHooks ?? resolveMediaTestHooks(process.env, { packaged: app.isPackaged });
  const electronShell = options.shell ?? shell;
  const runtime = new MediaRuntime({ environment: options.environment, workingDirectory: path.join(root, 'work'), platform });
  const prober = new MediaProber({ runtime });
  const inputs = new InputRegistry({ platform });
  const outputs = new MediaOutputs({ root, trashItem: target => electronShell.trashItem(target), platform });
  let queue: MediaQueue | undefined;
  const capabilities = new MediaCapabilities({
    runtime, root, override: hooks.caps, log,
    gpuInfo: options.gpuInfo ?? (() => app.getGPUInfo('basic')),
    // "Detect again" waits while a hardware encode runs (AC-ENGINE-03-2).
    isHardwareEncodeRunning: () => queue?.isHardwareEncodeRunning() ?? false,
  });
  const executor = new MediaConversionExecutor({ runtime, inputs, outputs, prober, capabilities, failure: hooks.fail, platform, log });
  queue = new MediaQueue({
    root, inputs, prober, capabilities, executor, platform, log,
    wouldReplace: (directory, baseName, extension) => outputs.wouldReplace(directory, baseName, extension),
    powerSaveBlocker: options.powerSaveBlocker ?? powerSaveBlocker,
    emit: mediaConverterEventSender(getWindow),
  });
  const mediaQueue = queue;

  // Before any request: no detection may start in `work/` while the cleanup empties it, and the
  // first snapshot (and any command) must include what state.json kept.
  const ready = Promise.all([
    outputs.cleanupAtStartup().catch(error => log('The partials of an earlier run could not be cleaned up.', error)),
    mediaQueue.restore(),
  ]).then(() => undefined, error => log('The media converter could not get ready.', error));

  const handlers = createMediaConverterHandlers({
    queue: mediaQueue, capabilities, dialog: options.dialog ?? dialog, getWindow, log,
    reveal: mediaConverterRevealer(hooks.reveal, electronShell),
    drop: options.drop,
  });
  const registration = registerMediaConverterIpc({ ipc, handlers, ready, trust, log });

  let stopping: Promise<void> | undefined;
  const shutdown = (reason: ApplicationShutdownReason) => stopping ??= (async () => {
    registration.close();
    try {
      await Promise.all([
        mediaQueue.shutdown(reason),
        settleWithin(capabilities.dispose(), MEDIA_CONVERTER_POLICY.detectionStopWaitMs),
      ]);
    } catch (error) {
      log('The media converter did not shut down cleanly.', error);
    } finally {
      prober.dispose();
    }
  })();
  return { ready, shutdown };
}
