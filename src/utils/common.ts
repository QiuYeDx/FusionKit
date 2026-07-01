export type ThemeValue = "light" | "dark" | "system";

export const getIsDark = (savedTheme: ThemeValue | null) => {
  return (
    savedTheme === "dark" ||
    ((!savedTheme || savedTheme === "system") &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
};

// 应用主题
export const applyTheme = (theme: ThemeValue) => {
  if (typeof document === "undefined") return;

  const htmlElement = document.documentElement;

  // 使用 class 而不是 data-theme，以支持 shadcn/ui
  if (getIsDark(theme)) {
    htmlElement.classList.add("dark");
  } else {
    htmlElement.classList.remove("dark");
  }
};
