/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  // expose in the `electron/preload/index.ts`
  ipcRenderer: import('../electron/preload/legacy-ipc-bridge').SafeLegacyIpcBridge
  audioApi: import('@/type/audioIpc').AudioRendererApi
  localSubtitleApi: import('@/type/localSubtitleIpc').LocalSubtitleRendererApi
  // expose webUtils for file path access (Electron 24+)
  electronUtils: {
    getPathForFile(file: File): string
  }
}
