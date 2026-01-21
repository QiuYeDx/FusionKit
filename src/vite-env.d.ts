/// <reference types="vite/client" />

interface Window {
  // expose in the `electron/preload/index.ts`
  ipcRenderer: import('electron').IpcRenderer
  // expose webUtils for file path access (Electron 24+)
  electronUtils: {
    getPathForFile(file: File): string
  }
}
