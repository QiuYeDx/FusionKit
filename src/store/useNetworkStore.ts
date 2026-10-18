import { create } from "zustand";
import {
  DEFAULT_NETWORK_SETTINGS,
  PROXY_MODES,
  type DownloadSourceMode,
  type NetworkProxyMode,
  type NetworkProxySettings,
  type NetworkSettings,
} from "@/network/contract";

/**
 * Network settings as the settings page shows them. The main process owns and saves them (they
 * must apply before the window exists); this store mirrors them and sends every change back.
 */
interface NetworkStore {
  settings: NetworkSettings;
  loaded: boolean;
  /** The main process could not take the last change. */
  saveFailed: boolean;
  init: () => Promise<void>;
  setProxyMode: (mode: NetworkProxyMode) => void;
  setProxyHost: (host: string) => void;
  setProxyPort: (port: string) => void;
  setDownloadSource: (source: DownloadSourceMode) => void;
  /** Sends a change still waiting for the typing pause, and waits until main has every change. */
  flush: () => Promise<void>;
}

// Where earlier versions kept the proxy setting in the renderer.
const LEGACY_STORAGE_KEYS = ["fusionkit-proxy", "proxyConfig"] as const;
/** Typing an address sends it once the user pauses. */
const TYPING_PUSH_DELAY_MS = 400;

let initialization: Promise<void> | undefined;
let pushTimer: ReturnType<typeof setTimeout> | undefined;
/** Changes go to main one after another, so a slow answer never lands after a newer change. */
let pushes: Promise<void> = Promise.resolve();

const useNetworkStore = create<NetworkStore>()((set, get) => {
  const send = async () => {
    const api = window.network;
    if (!api) return;
    const { settings } = get();
    try {
      await api.setSettings({ proxy: { ...settings.proxy }, downloadSource: settings.downloadSource });
      set({ saveFailed: false });
    } catch {
      set({ saveFailed: true });
    }
  };
  const push = () => {
    pushTimer = undefined;
    pushes = pushes.then(send);
    return pushes;
  };
  const schedule = (delayMs: number) => {
    if (pushTimer !== undefined) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void push(), delayMs);
  };
  const updateProxy = (patch: Partial<NetworkProxySettings>, delayMs: number) => {
    set((state) => ({ settings: { ...state.settings, proxy: { ...state.settings.proxy, ...patch } } }));
    schedule(delayMs);
  };

  return {
    settings: DEFAULT_NETWORK_SETTINGS,
    loaded: false,
    saveFailed: false,

    init: () => {
      initialization ??= (async () => {
        const api = window.network;
        if (!api) {
          set({ loaded: true });
          return;
        }
        try {
          let snapshot = await api.getSettings();
          if (!snapshot.stored) {
            // First launch of this version: keep a proxy chosen in an earlier one.
            const legacy = readLegacyProxy();
            if (legacy) snapshot = await api.setSettings({ proxy: legacy });
          }
          clearLegacyProxy();
          set({ settings: { proxy: snapshot.proxy, downloadSource: snapshot.downloadSource }, loaded: true });
        } catch {
          set({ loaded: true });
        }
      })();
      return initialization;
    },

    setProxyMode: (mode) => updateProxy({ mode }, 0),
    setProxyHost: (host) => updateProxy({ host: host.slice(0, 255) }, TYPING_PUSH_DELAY_MS),
    setProxyPort: (port) => updateProxy({ port: port.replace(/\D/g, "").slice(0, 5) }, TYPING_PUSH_DELAY_MS),
    setDownloadSource: (downloadSource) => {
      set((state) => ({ settings: { ...state.settings, downloadSource } }));
      schedule(0);
    },
    flush: () => {
      if (pushTimer === undefined) return pushes;
      clearTimeout(pushTimer);
      return push();
    },
  };
});

function readLegacyProxy(): NetworkProxySettings | undefined {
  try {
    const persisted = localStorage.getItem(LEGACY_STORAGE_KEYS[0]);
    const candidate = persisted
      ? (JSON.parse(persisted) as { state?: { proxyConfig?: unknown } })?.state?.proxyConfig
      : JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEYS[1]) ?? "null");
    if (!candidate || typeof candidate !== "object") return undefined;
    const { mode, host, port } = candidate as Record<string, unknown>;
    if (!PROXY_MODES.includes(mode as NetworkProxyMode)) return undefined;
    return {
      mode: mode as NetworkProxyMode,
      host: typeof host === "string" ? host.trim().slice(0, 255) : "",
      port: typeof port === "string" ? port.replace(/\D/g, "").slice(0, 5) : "",
    };
  } catch {
    return undefined;
  }
}

function clearLegacyProxy(): void {
  try {
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; the main process already has the settings.
  }
}

export default useNetworkStore;
