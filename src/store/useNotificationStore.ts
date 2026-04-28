import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface NotificationStore {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

const LEGACY_KEY = "notification-enabled";

const useNotificationStore = create<NotificationStore>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "fusionkit-notification",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ enabled: state.enabled }),
      onRehydrateStorage: () => {
        // 一次性迁移：旧 key → 新 key
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy !== null) {
          localStorage.setItem(
            "fusionkit-notification",
            JSON.stringify({ state: { enabled: legacy === "true" }, version: 0 })
          );
          localStorage.removeItem(LEGACY_KEY);
        }
      },
    }
  )
);

export default useNotificationStore;
