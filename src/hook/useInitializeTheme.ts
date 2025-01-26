import { useEffect } from "react";

const useInitializeTheme = () => {
  useEffect(() => {
    // 从 localStorage 获取保存的主题
    const savedTheme = localStorage.getItem("theme") as
      | "light"
      | "dark"
      | "system"
      | null;
    const htmlElement = document.documentElement;

    if (savedTheme) {
      // 如果 localStorage 中有主题记录，则设置 HTML 的 data-theme
      if (savedTheme === "system") {
        // 跟随系统主题
        const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
          .matches
          ? "dark"
          : "light";
        htmlElement.setAttribute("data-theme", systemTheme);
      } else {
        // 使用保存的主题
        htmlElement.setAttribute("data-theme", savedTheme);
      }
    } else {
      // 如果没有主题记录，则使用默认主题（system）
      localStorage.setItem("theme", "system");
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      htmlElement.setAttribute("data-theme", systemTheme);
    }
  }, []);
};

export default useInitializeTheme;