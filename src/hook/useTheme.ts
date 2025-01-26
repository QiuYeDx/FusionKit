import { useEffect, useState } from "react";

const useTheme = () => {
  // 当前主题状态
  const [theme, setThemeState] = useState<"light" | "dark" | "system">("system");

  // 初始化主题
  useEffect(() => {
    // 从 localStorage 获取保存的主题
    const savedTheme = localStorage.getItem("theme") as "light" | "dark" | "system" | null;
    const initialTheme = savedTheme || "system";
    setThemeState(initialTheme); // 更新状态
    applyTheme(initialTheme); // 应用主题
  }, []);

  // 监听系统主题变化
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = (e: MediaQueryListEvent) => {
      if (theme === "system") {
        // 如果当前主题是 "system"，则根据系统主题更新 HTML 的 data-theme
        applyTheme(e.matches ? "dark" : "light");
      }
    };

    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [theme]);

  // 应用主题
  const applyTheme = (theme: "light" | "dark" | "system") => {
    const htmlElement = document.documentElement;

    if (theme === "system") {
      // 使用系统主题
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
      htmlElement.setAttribute("data-theme", systemTheme);
    } else {
      // 使用手动设置的主题
      htmlElement.setAttribute("data-theme", theme);
    }
  };

  // 设置主题
  const setTheme = (newTheme: "light" | "dark" | "system") => {
    setThemeState(newTheme); // 更新状态
    applyTheme(newTheme); // 应用主题
    localStorage.setItem("theme", newTheme); // 保存到 localStorage
  };

  // 返回当前主题和设置主题的函数
  return { theme, setTheme };
};

export default useTheme;