import { create } from "zustand";

interface NotificationStore {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const STORAGE_KEY = "notification-enabled";

const getStoredEnabled = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

const useNotificationStore = create<NotificationStore>((set) => ({
  enabled: getStoredEnabled(),
  setEnabled: (enabled) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch {}
    set({ enabled });
  },
}));

export default useNotificationStore;
