import { BrowserWindow, ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { WEB_LOOKUP_CHANNELS } from '../../../src/web-lookup/contract';
import { WebLookupService } from './service';

/** Only the application's own windows, from their main frame, may look things up. */
function trusted(event: IpcMainInvokeEvent): boolean {
  return !!BrowserWindow.fromWebContents(event.sender) && event.senderFrame === event.sender.mainFrame;
}

export function setupWebLookupIPC(service = new WebLookupService(), ipc: Pick<IpcMain, 'handle'> = ipcMain) {
  ipc.handle(WEB_LOOKUP_CHANNELS.search, (event, request: unknown) => trusted(event) ? service.search(request) : { ok: false, error: 'web_lookup_blocked' });
  ipc.handle(WEB_LOOKUP_CHANNELS.read, (event, request: unknown) => trusted(event) ? service.read(request) : { ok: false, error: 'web_lookup_blocked' });
}
