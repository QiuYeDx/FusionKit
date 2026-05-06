import type { PrismTheme } from "prism-react-renderer";

// ============================================
// 类型定义
// ============================================

/** 内置配色主题名称 */
export type CodeBlockColorThemeName =
  | "qiuvision"
  | "github"
  | "one"
  | "dracula"
  | "nord"
  | "vitesse"
  | "monokai";

/** 所有内置配色主题名称（可用于遍历 / 展示列表） */
export const CODE_BLOCK_COLOR_THEME_NAMES: readonly CodeBlockColorThemeName[] = [
  "qiuvision",
  "github",
  "one",
  "dracula",
  "nord",
  "vitesse",
  "monokai",
] as const;

/**
 * UI 配色变量（对应 CSS 自定义属性 --cb-xxx）
 *
 * 这些变量控制代码块的所有 UI 元素配色：
 * 边框、行号、滚动条、按钮、遮罩层、聚光灯等。
 * 语法高亮色由 PrismTheme 单独控制。
 */
export interface CodeBlockThemeVars {
  /** 代码背景色（hex，如 "#1A1A1A"） */
  bg: string;
  /** 背景色 RGB 分量（如 "26, 26, 26"，用于 rgba() 透明度混合） */
  bgRgb: string;
  /** 边框色 */
  border: string;
  /** 行悬停背景色（半透明） */
  hover: string;
  /** 行号悬停背景色（不透明，用于 sticky 行号覆盖） */
  hoverSolid: string;
  /** 行号文本色 */
  lnColor: string;
  /** 行号分隔线色 */
  lnBorder: string;
  /** 滚动条滑块色 */
  sbThumb: string;
  /** 滚动条滑块悬停色 */
  sbThumbHover: string;
  /** 滚动条轨道色 */
  sbTrack: string;
  /** 按钮文本色 */
  btnText: string;
  /** 按钮边框色 */
  btnBorder: string;
  /** 按钮悬停文本色 */
  btnHoverText: string;
  /** 按钮悬停边框色 */
  btnHoverBorder: string;
  /** 聚光灯遮罩色（含 alpha，如 "rgba(0,0,0,0.65)"） */
  spotlight: string;
  /** 阴影色（用于按钮等小元素 box-shadow） */
  shadow: string;
  /** 阴影色 - 加强（用于容器和悬停 box-shadow） */
  shadowLg: string;
}

/**
 * 完整代码块主题配置
 *
 * 包含语法高亮（PrismTheme）+ UI 配色变量。
 * 可通过 `createCodeBlockThemeVars` 或 `createSyntaxTheme` 快速创建。
 */
export interface CodeBlockThemeConfig {
  /** 语法高亮主题（传递给 prism-react-renderer） */
  syntax: PrismTheme;
  /** UI 配色变量（映射到 CSS 自定义属性） */
  vars: CodeBlockThemeVars;
}

/**
 * 语法高亮色板（简化参数，用于快速创建 PrismTheme）
 *
 * 通过 `createSyntaxTheme(palette)` 生成完整 PrismTheme。
 */
export interface SyntaxPalette {
  /** 代码背景色 */
  bg: string;
  /** 代码前景色（默认文本色） */
  fg: string;
  /** 注释色 */
  comment: string;
  /** 字符串色 */
  string: string;
  /** 运算符 / 标点色 */
  operator: string;
  /** 数值、布尔值、变量、属性等 */
  number: string;
  /** 关键字、标签、选择器 */
  keyword: string;
  /** 函数名 */
  function: string;
  /** 类名、内建类型、常量 */
  class: string;
  /** 属性名、@ 规则（默认取 string 色） */
  attr?: string;
}

// ============================================
// 内部工具函数
// ============================================

/** Hex 颜色 → RGB 分量 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Hex + alpha → RGBA 字符串 */
function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 将 fg 以 alpha 叠加到 bg 上，返回不透明 hex */
function blendColors(bgHex: string, fgHex: string, alpha: number): string {
  const [br, bg, bb] = hexToRgb(bgHex);
  const [fr, fg, fb] = hexToRgb(fgHex);
  const r = Math.round(fr * alpha + br * (1 - alpha));
  const g = Math.round(fg * alpha + bg * (1 - alpha));
  const b = Math.round(fb * alpha + bb * (1 - alpha));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ============================================
// 公开工具函数
// ============================================

/**
 * 从 4 个关键色 + 明暗标志创建完整 UI 配色变量
 *
 * @example
 * ```ts
 * const vars = createCodeBlockThemeVars({
 *   bg: "#1A1A1A",
 *   fg: "#ECECEC",
 *   accent: "#D6C8A6",   // 强调色（影响滚动条、悬停边框等）
 *   muted: "#9FA3A8",    // 次级色（影响行号、按钮文字等）
 *   isDark: true,
 * });
 * ```
 */
export function createCodeBlockThemeVars(opts: {
  /** 背景色 (hex) */
  bg: string;
  /** 前景色 (hex) */
  fg: string;
  /** 强调色 (hex)，影响滚动条滑块、悬停边框、行悬停背景等 */
  accent: string;
  /** 次级色 (hex)，影响行号文字、按钮文字等 */
  muted: string;
  /** 是否深色模式（影响各透明度系数） */
  isDark: boolean;
}): CodeBlockThemeVars {
  const { bg, fg, accent, muted, isDark } = opts;
  const [bgR, bgG, bgB] = hexToRgb(bg);
  return {
    bg,
    bgRgb: `${bgR}, ${bgG}, ${bgB}`,
    border: isDark ? hexToRgba(accent, 0.2) : hexToRgba(fg, 0.1),
    hover: hexToRgba(accent, isDark ? 0.08 : 0.06),
    hoverSolid: blendColors(bg, accent, isDark ? 0.08 : 0.06),
    lnColor: hexToRgba(muted, isDark ? 0.5 : 0.65),
    lnBorder: hexToRgba(fg, isDark ? 0.1 : 0.15),
    sbThumb: hexToRgba(accent, isDark ? 0.3 : 0.4),
    sbThumbHover: hexToRgba(accent, isDark ? 0.5 : 0.6),
    sbTrack: hexToRgba(isDark ? "#FFFFFF" : fg, 0.05),
    btnText: hexToRgba(isDark ? muted : fg, isDark ? 0.7 : 0.55),
    btnBorder: hexToRgba(isDark ? accent : fg, isDark ? 0.15 : 0.12),
    btnHoverText: hexToRgba(fg, 0.85),
    btnHoverBorder: hexToRgba(accent, isDark ? 0.35 : 0.3),
    spotlight: hexToRgba("#000000", isDark ? 0.65 : 0.25),
    shadow: hexToRgba("#000000", isDark ? 0.15 : 0.06),
    shadowLg: hexToRgba("#000000", isDark ? 0.25 : 0.12),
  };
}

/**
 * 从色板快速创建 PrismTheme
 *
 * @example
 * ```ts
 * const theme = createSyntaxTheme({
 *   bg: "#282c34", fg: "#abb2bf",
 *   comment: "#5c6370", string: "#98c379",
 *   operator: "#abb2bf", number: "#d19a66",
 *   keyword: "#c678dd", function: "#61afef",
 *   class: "#e5c07b",
 * });
 * ```
 */
export function createSyntaxTheme(palette: SyntaxPalette): PrismTheme {
  return {
    plain: {
      color: palette.fg,
      backgroundColor: palette.bg,
    },
    styles: [
      {
        types: ["comment", "prolog", "doctype", "cdata"],
        style: { color: palette.comment, fontStyle: "italic" as const },
      },
      { types: ["namespace"], style: { opacity: 0.7 } },
      {
        types: ["string", "attr-value"],
        style: { color: palette.string },
      },
      {
        types: ["punctuation", "operator"],
        style: { color: palette.operator },
      },
      {
        types: [
          "entity",
          "url",
          "symbol",
          "number",
          "boolean",
          "variable",
          "property",
          "regex",
          "inserted",
          "function-variable",
        ],
        style: { color: palette.number },
      },
      {
        types: ["atrule", "attr-name"],
        style: { color: palette.attr || palette.string },
      },
      {
        types: ["keyword", "tag", "selector"],
        style: { color: palette.keyword },
      },
      {
        types: ["function", "deleted"],
        style: { color: palette.function },
      },
      {
        types: ["builtin", "char", "constant", "class-name"],
        style: { color: palette.class },
      },
    ],
  };
}

/**
 * 从 PrismTheme 自动推导完整主题配置
 *
 * 自动检测背景明暗，从语法样式中提取强调色和次级色。
 * 适用于只有 PrismTheme 时快速生成完整配置。
 *
 * @param prismTheme - 已有的 PrismTheme 对象
 * @param isDark - 明暗模式（不传时自动检测）
 */
export function deriveThemeFromPrism(
  prismTheme: PrismTheme,
  isDark?: boolean,
): CodeBlockThemeConfig {
  const bg = prismTheme.plain.backgroundColor || "#1A1A1A";
  const fg = prismTheme.plain.color || "#ECECEC";

  // 自动检测背景明暗
  const [r, g, b] = hexToRgb(bg);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const detectedIsDark = isDark ?? luminance < 0.5;

  // 从语法样式中提取关键色
  let accent = detectedIsDark ? "#7CA7FF" : "#4785CC";
  let muted = detectedIsDark ? "#9FA3A8" : "#8B8B8B";

  for (const s of prismTheme.styles) {
    if (s.types.includes("keyword") && s.style.color) {
      accent = s.style.color;
    }
    if (s.types.includes("comment") && s.style.color) {
      muted = s.style.color;
    }
  }

  return {
    syntax: prismTheme,
    vars: createCodeBlockThemeVars({
      bg,
      fg,
      accent,
      muted,
      isDark: detectedIsDark,
    }),
  };
}

// ============================================
// 内置主题定义
// ============================================

// ---- QiuVision（品牌默认主题） ----

const qiuvisionDark: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#1A1A1A",
    fg: "#ECECEC",
    comment: "#9FA3A8",
    string: "#D6C8A6",
    operator: "#ECECEC",
    number: "#7CA7FF",
    keyword: "#FF92DF",
    function: "#FFB86C",
    class: "#FFB86C",
    attr: "#D6C8A6",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#1A1A1A",
    fg: "#ECECEC",
    accent: "#D6C8A6",
    muted: "#9FA3A8",
    isDark: true,
  }),
};

const qiuvisionLight: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#FAFAFA",
    fg: "#1F1F1F",
    comment: "#8B8B8B",
    string: "#A07A44",
    operator: "#393939",
    number: "#4785CC",
    keyword: "#C44BB0",
    function: "#D97519",
    class: "#D97519",
    attr: "#A07A44",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#FAFAFA",
    fg: "#1F1F1F",
    accent: "#A07A44",
    muted: "#8B8B8B",
    isDark: false,
  }),
};

// ---- GitHub ----

const githubDark: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#0d1117",
    fg: "#e6edf3",
    comment: "#8b949e",
    string: "#a5d6ff",
    operator: "#e6edf3",
    number: "#79c0ff",
    keyword: "#ff7b72",
    function: "#d2a8ff",
    class: "#ffa657",
    attr: "#79c0ff",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#0d1117",
    fg: "#e6edf3",
    accent: "#58a6ff",
    muted: "#8b949e",
    isDark: true,
  }),
};

const githubLight: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#ffffff",
    fg: "#24292f",
    comment: "#6e7781",
    string: "#0a3069",
    operator: "#24292f",
    number: "#0550ae",
    keyword: "#cf222e",
    function: "#8250df",
    class: "#953800",
    attr: "#0550ae",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#ffffff",
    fg: "#24292f",
    accent: "#0969da",
    muted: "#6e7781",
    isDark: false,
  }),
};

// ---- One (Atom One Dark / Light) ----

const oneDark: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#282c34",
    fg: "#abb2bf",
    comment: "#5c6370",
    string: "#98c379",
    operator: "#abb2bf",
    number: "#d19a66",
    keyword: "#c678dd",
    function: "#61afef",
    class: "#e5c07b",
    attr: "#d19a66",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#282c34",
    fg: "#abb2bf",
    accent: "#61afef",
    muted: "#5c6370",
    isDark: true,
  }),
};

const oneLight: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#fafafa",
    fg: "#383a42",
    comment: "#a0a1a7",
    string: "#50a14f",
    operator: "#383a42",
    number: "#986801",
    keyword: "#a626a4",
    function: "#4078f2",
    class: "#c18401",
    attr: "#986801",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#fafafa",
    fg: "#383a42",
    accent: "#4078f2",
    muted: "#a0a1a7",
    isDark: false,
  }),
};

// ---- Dracula ----

const draculaDark: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#282a36",
    fg: "#f8f8f2",
    comment: "#6272a4",
    string: "#f1fa8c",
    operator: "#f8f8f2",
    number: "#bd93f9",
    keyword: "#ff79c6",
    function: "#50fa7b",
    class: "#8be9fd",
    attr: "#50fa7b",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#282a36",
    fg: "#f8f8f2",
    accent: "#bd93f9",
    muted: "#6272a4",
    isDark: true,
  }),
};

const draculaLight: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#f8f8f2",
    fg: "#282a36",
    comment: "#9ea2b0",
    string: "#6d6b0b",
    operator: "#282a36",
    number: "#7c5cbf",
    keyword: "#c4358c",
    function: "#2b9e4d",
    class: "#1b8bc1",
    attr: "#2b9e4d",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#f8f8f2",
    fg: "#282a36",
    accent: "#7c5cbf",
    muted: "#9ea2b0",
    isDark: false,
  }),
};

// ---- Nord ----

const nordDark: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#2e3440",
    fg: "#d8dee9",
    comment: "#4c566a",
    string: "#a3be8c",
    operator: "#81a1c1",
    number: "#b48ead",
    keyword: "#81a1c1",
    function: "#88c0d0",
    class: "#8fbcbb",
    attr: "#d08770",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#2e3440",
    fg: "#d8dee9",
    accent: "#88c0d0",
    muted: "#4c566a",
    isDark: true,
  }),
};

const nordLight: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#eceff4",
    fg: "#2e3440",
    comment: "#9da5b4",
    string: "#a3be8c",
    operator: "#5e81ac",
    number: "#b48ead",
    keyword: "#5e81ac",
    function: "#4096ac",
    class: "#3b8686",
    attr: "#d08770",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#eceff4",
    fg: "#2e3440",
    accent: "#5e81ac",
    muted: "#9da5b4",
    isDark: false,
  }),
};

// ---- Vitesse ----

const vitesseDark: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#121212",
    fg: "#dbd7ca",
    comment: "#758575",
    string: "#c98a7d",
    operator: "#858585",
    number: "#4c9a91",
    keyword: "#4d9375",
    function: "#80a665",
    class: "#6893bf",
    attr: "#bd976a",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#121212",
    fg: "#dbd7ca",
    accent: "#4d9375",
    muted: "#758575",
    isDark: true,
  }),
};

const vitesseLight: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#ffffff",
    fg: "#393a34",
    comment: "#a0ada0",
    string: "#b56959",
    operator: "#999999",
    number: "#2f798a",
    keyword: "#1e754f",
    function: "#59873a",
    class: "#2e5dab",
    attr: "#b07d48",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#ffffff",
    fg: "#393a34",
    accent: "#1e754f",
    muted: "#a0ada0",
    isDark: false,
  }),
};

// ---- Monokai ----

const monokaiDark: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#272822",
    fg: "#f8f8f2",
    comment: "#75715e",
    string: "#e6db74",
    operator: "#f8f8f2",
    number: "#ae81ff",
    keyword: "#f92672",
    function: "#a6e22e",
    class: "#66d9ef",
    attr: "#a6e22e",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#272822",
    fg: "#f8f8f2",
    accent: "#f92672",
    muted: "#75715e",
    isDark: true,
  }),
};

const monokaiLight: CodeBlockThemeConfig = {
  syntax: createSyntaxTheme({
    bg: "#fafaf8",
    fg: "#49483e",
    comment: "#b3b1a4",
    string: "#9e8e2c",
    operator: "#49483e",
    number: "#8b68d0",
    keyword: "#c0195e",
    function: "#7ea21a",
    class: "#4798b3",
    attr: "#7ea21a",
  }),
  vars: createCodeBlockThemeVars({
    bg: "#fafaf8",
    fg: "#49483e",
    accent: "#c0195e",
    muted: "#b3b1a4",
    isDark: false,
  }),
};

// ============================================
// 主题注册表
// ============================================

/** 所有内置主题（每个包含 light/dark 变体） */
export const codeBlockThemes: Record<
  CodeBlockColorThemeName,
  { light: CodeBlockThemeConfig; dark: CodeBlockThemeConfig }
> = {
  qiuvision: { light: qiuvisionLight, dark: qiuvisionDark },
  github: { light: githubLight, dark: githubDark },
  one: { light: oneLight, dark: oneDark },
  dracula: { light: draculaLight, dark: draculaDark },
  nord: { light: nordLight, dark: nordDark },
  vitesse: { light: vitesseLight, dark: vitesseDark },
  monokai: { light: monokaiLight, dark: monokaiDark },
};

// ============================================
// 主题解析
// ============================================

/** 判断对象是否为 PrismTheme */
function isPrismTheme(obj: unknown): obj is PrismTheme {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "plain" in obj &&
    "styles" in obj
  );
}

/** 判断对象是否为 CodeBlockThemeConfig */
function isThemeConfig(obj: unknown): obj is CodeBlockThemeConfig {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "syntax" in obj &&
    "vars" in obj
  );
}

/**
 * 解析代码块主题
 *
 * 优先级：customTheme > colorTheme > 默认（github）
 *
 * @param colorTheme - 内置主题名称
 * @param customTheme - 自定义主题（CodeBlockThemeConfig 或 PrismTheme）
 * @param isDark - 是否深色模式（用于选择内置主题的深色/浅色变体）
 */
export function resolveCodeBlockTheme(
  colorTheme?: CodeBlockColorThemeName,
  customTheme?: CodeBlockThemeConfig | PrismTheme,
  isDark: boolean = true,
): CodeBlockThemeConfig {
  // 自定义主题优先
  if (customTheme) {
    if (isThemeConfig(customTheme)) {
      return customTheme;
    }
    if (isPrismTheme(customTheme)) {
      // 从 PrismTheme 自动推导 UI 配色（明暗自动检测）
      return deriveThemeFromPrism(customTheme);
    }
  }

  // 使用内置主题
  const themeName = colorTheme || "github";
  const themePair = codeBlockThemes[themeName] || codeBlockThemes.github;
  return isDark ? themePair.dark : themePair.light;
}

/**
 * 将 CodeBlockThemeVars 转为 CSS 自定义属性对象
 *
 * 返回的对象可直接作为 React 元素的 style 属性（需 as React.CSSProperties）
 */
export function themeVarsToCSSProperties(
  vars: CodeBlockThemeVars,
): Record<string, string> {
  return {
    "--cb-bg": vars.bg,
    "--cb-bg-rgb": vars.bgRgb,
    "--cb-border": vars.border,
    "--cb-hover": vars.hover,
    "--cb-hover-solid": vars.hoverSolid,
    "--cb-ln-color": vars.lnColor,
    "--cb-ln-border": vars.lnBorder,
    "--cb-sb-thumb": vars.sbThumb,
    "--cb-sb-thumb-hover": vars.sbThumbHover,
    "--cb-sb-track": vars.sbTrack,
    "--cb-btn-text": vars.btnText,
    "--cb-btn-border": vars.btnBorder,
    "--cb-btn-hover-text": vars.btnHoverText,
    "--cb-btn-hover-border": vars.btnHoverBorder,
    "--cb-spotlight": vars.spotlight,
    "--cb-shadow": vars.shadow,
    "--cb-shadow-lg": vars.shadowLg,
  };
}
