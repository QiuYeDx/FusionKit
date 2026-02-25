import { create } from "zustand";

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
  initializeProxy: () => void;
}

const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  mode: ProxyMode.SYSTEM,
  host: "",
  port: "",
};

const STORAGE_KEY = "proxyConfig";

const useProxyStore = create<ProxyStore>((set, get) => {
  const _persist = () => {
    const { proxyConfig } = get();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(proxyConfig));
    _syncToMain(proxyConfig);
  };

  const _syncToMain = (config: ProxyConfig) => {
    try {
      (window as any).ipcRenderer?.send("set-proxy-config", config);
    } catch {
      // ignore if IPC not available
    }
  };

  const initializeProxy = () => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? "null"
      );
      const config = stored ?? DEFAULT_PROXY_CONFIG;
      set({ proxyConfig: config });
      _syncToMain(config);
    } catch {
      set({ proxyConfig: DEFAULT_PROXY_CONFIG });
    }
  };

  const setProxyMode = (mode: ProxyMode) => {
    set((state) => ({
      proxyConfig: { ...state.proxyConfig, mode },
    }));
    _persist();
  };

  const setProxyHost = (host: string) => {
    set((state) => ({
      proxyConfig: { ...state.proxyConfig, host },
    }));
    _persist();
  };

  const setProxyPort = (port: string) => {
    set((state) => ({
      proxyConfig: { ...state.proxyConfig, port },
    }));
    _persist();
  };

  return {
    proxyConfig: DEFAULT_PROXY_CONFIG,
    setProxyMode,
    setProxyHost,
    setProxyPort,
    initializeProxy,
  };
});

export default useProxyStore;
