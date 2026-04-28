import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export enum ProxyMode {
  NONE = "none",
  SYSTEM = "system",
  CUSTOM = "custom",
}

interface ProxyConfig {
  mode: ProxyMode;
  host: string;
  port: string;
}

interface ProxyStore {
  proxyConfig: ProxyConfig;
  setProxyMode: (mode: ProxyMode) => void;
  setProxyHost: (host: string) => void;
  setProxyPort: (port: string) => void;
}

const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: ProxyMode.SYSTEM,
  host: "",
  port: "",
};

const LEGACY_KEY = "proxyConfig";

function syncToMain(config: ProxyConfig): void {
  try {
    (window as any).ipcRenderer?.send("set-proxy-config", config);
  } catch {
    // ignore if IPC not available
  }
}

const useProxyStore = create<ProxyStore>()(
  persist(
    (set) => ({
      proxyConfig: DEFAULT_PROXY_CONFIG,

      setProxyMode: (mode) =>
        set((state) => ({
          proxyConfig: { ...state.proxyConfig, mode },
        })),

      setProxyHost: (host) =>
        set((state) => ({
          proxyConfig: { ...state.proxyConfig, host },
        })),

      setProxyPort: (port) =>
        set((state) => ({
          proxyConfig: { ...state.proxyConfig, port },
        })),
    }),
    {
      name: "fusionkit-proxy",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ proxyConfig: state.proxyConfig }),
      onRehydrateStorage: () => {
        // 一次性迁移：旧 key → 新 key
        if (
          localStorage.getItem(LEGACY_KEY) !== null &&
          localStorage.getItem("fusionkit-proxy") === null
        ) {
          try {
            const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)!);
            localStorage.setItem(
              "fusionkit-proxy",
              JSON.stringify({ state: { proxyConfig: legacy }, version: 0 })
            );
          } catch { /* silent */ }
          localStorage.removeItem(LEGACY_KEY);
        }

        // rehydrate 完成后同步到主进程
        return (state) => {
          if (state) {
            syncToMain(state.proxyConfig);
          }
        };
      },
    }
  )
);

// 订阅变化，自动同步到主进程
useProxyStore.subscribe((state, prevState) => {
  if (state.proxyConfig !== prevState.proxyConfig) {
    syncToMain(state.proxyConfig);
  }
});

export default useProxyStore;
