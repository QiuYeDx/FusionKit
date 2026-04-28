import { applyTheme, getIsDark } from "@/utils/common";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

type ThemeValue = "light" | "dark" | "system";

interface ThemeStore {
  theme: ThemeValue;
  isDark: boolean;
  setTheme: (newTheme: ThemeValue) => void;
}

const LEGACY_KEY = "theme";

const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      theme: "system",
      isDark: false,
      setTheme: (newTheme) => {
        applyTheme(newTheme);
        const _isDark = getIsDark(newTheme);
        set({ theme: newTheme, isDark: _isDark });
      },
    }),
    {
      name: "fusionkit-theme",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => {
        // 一次性迁移：旧 key → 新 key
        if (
          localStorage.getItem(LEGACY_KEY) !== null &&
          localStorage.getItem("fusionkit-theme") === null
        ) {
          const savedTheme = localStorage.getItem(LEGACY_KEY) as ThemeValue | null;
          const theme = savedTheme || "system";
          localStorage.setItem(
            "fusionkit-theme",
            JSON.stringify({ state: { theme }, version: 0 })
          );
          localStorage.removeItem(LEGACY_KEY);
        }

        // rehydrate 完成后的回调
        return (state) => {
          if (state) {
            applyTheme(state.theme);
            const _isDark = getIsDark(state.theme);
            useThemeStore.setState({ isDark: _isDark });
          }
        };
      },
    }
  )
);

// 监听系统主题变化
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
mediaQuery.addEventListener("change", (e: MediaQueryListEvent) => {
  const { theme } = useThemeStore.getState();
  if (theme === "system") {
    const _isDark = e.matches;
    applyTheme(_isDark ? "dark" : "light");
    useThemeStore.setState({ isDark: _isDark });
  }
});

export default useThemeStore;
