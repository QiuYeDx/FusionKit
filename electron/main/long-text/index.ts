import {
  app, clipboard, dialog, ipcMain, shell,
  type BrowserWindow, type Clipboard, type Dialog, type IpcMain, type IpcMainInvokeEvent, type Shell,
} from 'electron';
import path from 'node:path';
import { sendModelRuntimeText } from '../ai/model-runtime-client';
import { isTrustedAppSender } from '../fs/trusted-sender';
import { longTextEventSender, registerLongTextIpc } from './ipc';
import type { ReadKnowledge } from './knowledge';
import { removeLegacyTextTranslationWorkspace } from './legacy-cleanup';
import { LongTextRepository } from './repository';
import type { SendText } from './runner';
import { LongTextService } from './service';

/**
 * Assembles the long text translator in the main process (design §6.1): the service over
 * `<userData>/long-text`, its IPC handlers and the quit hook. `ready` recovers the folder (interrupted
 * imports, deletions and runs) and then removes the old tool's workspace in the background.
 */

export interface RegisterLongTextOptions {
  getWindow: () => BrowserWindow | null;
  readKnowledge: ReadKnowledge;
  /** Default `<userData>/long-text`. */
  root?: string;
  /** Default `app.getPath('userData')`; the old tool's workspace is removed from it. */
  userData?: string;
  ipc?: Pick<IpcMain, 'handle' | 'removeHandler'>;
  send?: SendText;
  dialog?: Pick<Dialog, 'showOpenDialog'>;
  clipboard?: Pick<Clipboard, 'writeText'>;
  shell?: Pick<Shell, 'showItemInFolder'>;
  now?: () => number;
  /** Default: the main frame of the application window, loaded from the app's own page. */
  trust?: (event: IpcMainInvokeEvent) => boolean;
}

export function registerLongText(options: RegisterLongTextOptions): { dispose(): void; ready: Promise<void> } {
  const { getWindow } = options;
  const userData = options.userData ?? app.getPath('userData');
  const service = new LongTextService({
    repository: new LongTextRepository(options.root ?? path.join(userData, 'long-text'), { now: options.now }),
    readKnowledge: options.readKnowledge,
    send: options.send ?? sendModelRuntimeText,
    emit: longTextEventSender(getWindow),
    dialog: options.dialog ?? dialog,
    clipboard: options.clipboard ?? clipboard,
    shell: options.shell ?? shell,
    paths: app,
    getWindow,
    now: options.now,
  });
  const ready = service.ready();
  ready.then(
    () => removeLegacyTextTranslationWorkspace(userData).catch(error => console.warn('[long-text] Could not remove the old text translation workspace', error)),
    error => console.error('[long-text] Long text translator recovery failed', error),
  );
  const trust = options.trust ?? (event => isTrustedAppSender(event) && event.sender === getWindow()?.webContents);
  const unregister = registerLongTextIpc({ ipc: options.ipc ?? ipcMain, handlers: service, ready, trust });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    app.removeListener('before-quit', dispose);
    unregister();
    service.dispose();
  };
  app.on('before-quit', dispose);
  return { dispose, ready };
}
