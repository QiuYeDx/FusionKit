import { changeEventSchema, LONG_TEXT_CHANNELS } from '../../src/long-text/channels';
import type { LongTextApi } from '../../src/long-text/contract';

type ChangeListener = (event: unknown, payload: unknown) => void;

/** The part of `ipcRenderer` the API uses. */
export interface LongTextIpcRenderer {
  invoke(channel: string, payload?: unknown): Promise<any>;
  on(channel: string, listener: ChangeListener): unknown;
  removeListener(channel: string, listener: ChangeListener): unknown;
}

/** `window.longText`: one method per request channel and the change event subscription; events that fail the schema are dropped. */
export function createLongTextApi(ipc: LongTextIpcRenderer): LongTextApi {
  const C = LONG_TEXT_CHANNELS;
  return Object.freeze({
    list: () => ipc.invoke(C.list, {}),
    pickFiles: request => ipc.invoke(C.pickFiles, request),
    importFiles: request => ipc.invoke(C.importFiles, request),
    importText: request => ipc.invoke(C.importText, request),
    read: request => ipc.invoke(C.read, request),
    readPage: request => ipc.invoke(C.readPage, request),
    query: request => ipc.invoke(C.query, request),
    locate: request => ipc.invoke(C.locate, request),
    estimate: request => ipc.invoke(C.estimate, request),
    updateSettings: request => ipc.invoke(C.updateSettings, request),
    confirmEncoding: request => ipc.invoke(C.confirmEncoding, request),
    previewEncoding: request => ipc.invoke(C.previewEncoding, request),
    resegment: request => ipc.invoke(C.resegment, request),
    start: request => ipc.invoke(C.start, request),
    retranslate: request => ipc.invoke(C.retranslate, request),
    pause: request => ipc.invoke(C.pause, request),
    edit: request => ipc.invoke(C.edit, request),
    setLocked: request => ipc.invoke(C.setLocked, request),
    undo: request => ipc.invoke(C.undo, request),
    dismissFlag: request => ipc.invoke(C.dismissFlag, request),
    clear: request => ipc.invoke(C.clear, request),
    readLedger: request => ipc.invoke(C.readLedger, request),
    updateLedger: request => ipc.invoke(C.updateLedger, request),
    chooseExportFolder: request => ipc.invoke(C.chooseExportFolder, request),
    export: request => ipc.invoke(C.export, request),
    copy: request => ipc.invoke(C.copy, request),
    reveal: request => ipc.invoke(C.reveal, request),
    rename: request => ipc.invoke(C.rename, request),
    remove: request => ipc.invoke(C.remove, request),
    onChanged: listener => {
      const handler: ChangeListener = (_event, payload) => {
        const parsed = changeEventSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipc.on(C.changed, handler);
      return () => {
        ipc.removeListener(C.changed, handler);
      };
    },
  } satisfies LongTextApi);
}
