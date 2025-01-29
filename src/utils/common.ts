// 应用主题
export const applyTheme = (theme: "light" | "dark" | "system") => {
  const htmlElement = document.documentElement;

  if (theme === "system") {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
      .matches
      ? "dark"
      : "light";
    htmlElement.setAttribute("data-theme", systemTheme);
  } else {
    htmlElement.setAttribute("data-theme", theme);
  }
};

export const getIsDark = (savedTheme: "light" | "dark" | "system" | null) => {
  return (
    savedTheme === "dark" ||
    (savedTheme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
  );
};
