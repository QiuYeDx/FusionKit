// 应用主题
export const applyTheme = (theme: "light" | "dark" | "system") => {
  const htmlElement = document.documentElement;

  if (theme === "system") {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
      .matches
      ? "dark"
      : "light";
    // 使用 class 而不是 data-theme，以支持 shadcn/ui
    if (systemTheme === "dark") {
      htmlElement.classList.add("dark");
    } else {
      htmlElement.classList.remove("dark");
    }
  } else {
    // 使用 class 而不是 data-theme，以支持 shadcn/ui
    if (theme === "dark") {
      htmlElement.classList.add("dark");
    } else {
      htmlElement.classList.remove("dark");
    }
  }
};

export const getIsDark = (savedTheme: "light" | "dark" | "system" | null) => {
  return (
    savedTheme === "dark" ||
    ((!savedTheme || savedTheme === "system") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
};
