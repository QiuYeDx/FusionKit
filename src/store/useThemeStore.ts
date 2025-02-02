import { applyTheme, getIsDark } from "@/utils/common";
import { create } from "zustand";

interface ThemeStore {
  theme: "light" | "dark" | "system";
  isDark: boolean;
  setTheme: (newTheme: "light" | "dark" | "system") => void;
  initializeTheme: () => void;
}

const useThemeStore = create<ThemeStore>((set, get) => {
  // 初始化主题
  const initializeTheme = () => {
    const savedTheme = localStorage.getItem("theme") as
      | "light"
      | "dark"
      | "system"
      | null;
    const initialTheme = savedTheme || "system";
    applyTheme(initialTheme);
    const _isDark = getIsDark(savedTheme);
    set({ theme: initialTheme, isDark: _isDark });
  };

  // 设置主题
  const setTheme = (newTheme: "light" | "dark" | "system") => {
    applyTheme(newTheme);
    const _isDark = getIsDark(newTheme);
    set({ theme: newTheme, isDark: _isDark });

    localStorage.setItem("theme", newTheme);
  };

  // 初始化主题
  // initializeTheme(); // 应该在外部调用, 在最先引入这个 store 的组件的地方调用

  // 监听系统主题变化
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemThemeChange = (e: MediaQueryListEvent) => {
    if (get().theme === "system") {
      const _isDark = e.matches;
      applyTheme(_isDark ? "dark" : "light");
      set({ isDark: _isDark });
    }
  };

  mediaQuery.addEventListener("change", handleSystemThemeChange);

  return {
    theme: "system", // 初始值，会在 initializeTheme 中被覆盖
    isDark: false, // 初始值，会在 initializeTheme 中被覆盖
    setTheme,
    initializeTheme,
  };
});

export default useThemeStore;
