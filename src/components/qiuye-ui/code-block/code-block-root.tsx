"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Highlight, type PrismTheme } from "prism-react-renderer";
import { ChevronDown, ChevronUp } from "lucide-react";
import { AnimatePresence } from "motion/react";

import {
  resolveCodeBlockTheme,
  themeVarsToCSSProperties,
  type CodeBlockColorThemeName,
  type CodeBlockThemeConfig,
} from "./code-block-themes";

// ============================================
// 公开导出（类型 + 工具）—— 从 code-block-themes 转导
// ============================================

export type {
  CodeBlockColorThemeName,
  CodeBlockThemeConfig,
  CodeBlockThemeVars,
  SyntaxPalette,
} from "./code-block-themes";

export {
  codeBlockThemes,
  CODE_BLOCK_COLOR_THEME_NAMES,
  createCodeBlockThemeVars,
  createSyntaxTheme,
  deriveThemeFromPrism,
  resolveCodeBlockTheme,
  themeVarsToCSSProperties,
} from "./code-block-themes";

// ============================================
// Diff 模式工具
// ============================================

/** Diff 行的基色 (RGB) — 参考 GitHub diff 配色 */
const DIFF_LINE_COLORS = {
  add: [46, 160, 67] as const,
  remove: [248, 81, 73] as const,
  info: [56, 139, 253] as const,
};

/** 根据行首字符判断 diff 行类型 */
function getDiffLineType(line: string): "add" | "remove" | "info" | null {
  if (line.startsWith("@@")) return "info";
  if (line.startsWith("+++") || line.startsWith("---")) return "info";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return null;
}

/** 将前景色以 alpha 叠加到背景色上，返回不透明 hex（用于 sticky 行号的 diff 背景色） */
function blendOnBg(
  bgHex: string,
  rgb: readonly [number, number, number],
  alpha: number,
): string {
  const h = bgHex.replace("#", "");
  const br = parseInt(h.slice(0, 2), 16);
  const bg = parseInt(h.slice(2, 4), 16);
  const bb = parseInt(h.slice(4, 6), 16);
  const r = Math.round(rgb[0] * alpha + br * (1 - alpha));
  const g = Math.round(rgb[1] * alpha + bg * (1 - alpha));
  const b = Math.round(rgb[2] * alpha + bb * (1 - alpha));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ============================================
// 行高亮工具
// ============================================

/** 解析行高亮标记：支持行号数组或逗号分隔的范围字符串（行号从 1 开始） */
function parseHighlightLines(input: number[] | string): Set<number> {
  if (Array.isArray(input)) return new Set(input);
  const set = new Set<number>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const dashIdx = trimmed.indexOf("-");
    if (dashIdx > 0) {
      const start = Number(trimmed.slice(0, dashIdx));
      const end = Number(trimmed.slice(dashIdx + 1));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) set.add(i);
      }
    } else {
      const n = Number(trimmed);
      if (!isNaN(n)) set.add(n);
    }
  }
  return set;
}

// ============================================
// CodeBlock 组件
// ============================================

/**
 * 代码块显示模式
 * - "collapse": 展开/折叠模式，超出行数后显示渐变遮罩和展开按钮
 * - "scroll": 滚动模式，设置最大高度，超出部分纵向滚动
 * - "auto-height": 自适应高度模式，高度自动适配父容器，超出部分纵向滚动
 */
export type CodeBlockDisplayMode = "collapse" | "scroll" | "auto-height";

export interface CodeBlockProps {
  /** 代码内容 */
  children: string;
  /** 编程语言（用于语法高亮） */
  language?: string;
  /** 是否为深色模式（控制内置主题的浅色/深色变体选择，默认 true） */
  isDark?: boolean;
  /**
   * 内置配色主题名称（默认 "github"）
   *
   * 与 isDark 配合使用，自动选择对应的浅色/深色变体。
   * 可选值: "qiuvision" | "github" | "one" | "dracula" | "nord" | "vitesse" | "monokai"
   */
  colorTheme?: CodeBlockColorThemeName;
  /**
   * 自定义主题配置（优先级高于 colorTheme 和 isDark）
   *
   * - 传入 CodeBlockThemeConfig：完整配置（语法高亮 + UI 配色）
   * - 传入 PrismTheme：仅语法高亮，UI 配色自动从背景色推导
   */
  customTheme?: CodeBlockThemeConfig | PrismTheme;
  /**
   * 显示模式（溢出处理策略）
   * - "collapse": 展开/折叠模式，超出行数后显示渐变遮罩和展开按钮
   * - "scroll": 滚动模式，设置最大高度，超出部分纵向滚动
   * - "auto-height": 自适应高度模式，高度自动适配父容器，超出部分纵向滚动
   *
   * 不设置时代码块无高度限制，完整显示所有代码
   */
  displayMode?: CodeBlockDisplayMode;
  /** 折叠的行数阈值（displayMode="collapse" 时生效，默认 15 行） */
  maxLines?: number;
  /**
   * 最大高度（displayMode="scroll" 时生效）
   *
   * 支持 CSS 单位字符串（如 "400px"、"50vh"、"20rem"）或数字（单位为 px）
   *
   * 默认 "400px"
   */
  maxHeight?: string | number;
  /**
   * 控制左侧行号的显示策略
   *
   * - `true`（默认）：始终显示行号
   * - `false`：始终隐藏行号
   * - `number`（如 `5`）：代码行数 >= 该值时才显示行号，否则隐藏
   */
  showLineNumbers?: boolean | number;
  /** 是否在横向滚动时固定左侧行号列（sticky 效果），默认 true */
  stickyLineNumbers?: boolean;
  /** 是否在折叠后跳转时显示聚光灯阴影效果（displayMode="collapse" 时生效），默认 true */
  spotlightOnCollapse?: boolean;
  /** 是否隐藏容器周围的 box-shadow 阴影（默认 true） */
  noShadow?: boolean;
  /**
   * 是否启用 Diff 高亮模式
   *
   * 启用后自动识别代码行首的 `+` / `-` / `@@` 标记，
   * 以绿色（新增）、红色（删除）、蓝色（信息）背景高亮显示，
   * 并在行左侧显示彩色指示条。
   * 搭配 `language="diff"` 使用效果最佳。
   */
  diff?: boolean;
  /**
   * 需要高亮标记的行号（行号从 1 开始）
   *
   * 高亮行以淡蓝色背景显示（与 Diff 模式的 info 行类似），
   * 代码内容本身不附加任何特殊标记。
   *
   * - `number[]`：行号数组，如 `[1, 3, 5]`
   * - `string`：逗号分隔的行号或范围，如 `"1,3,5-10,15"`
   */
  highlightLines?: number[] | string;
  /** 额外的 CSS 类名 */
  className?: string;
}

/**
 * 通用代码块显示组件
 *
 * 特性:
 * - 基于 prism-react-renderer 的语法高亮
 * - **可定制配色主题**：7 套内置主题（各有浅/深色变体）+ 自定义主题支持
 * - 行号显示 + 横向滚动时行号 sticky 固定
 * - 三种显示模式（通过 displayMode 切换）：
 *   - "collapse"：超出行数自动折叠，渐变遮罩 + 展开/收起按钮 + 聚光灯动画
 *   - "scroll"：设置最大高度，超出部分纵向滚动，带滚动阴影指示器
 *   - "auto-height"：自适应父容器高度，超出部分纵向滚动（适用于 flex/grid 布局）
 * - **Diff 高亮模式**：自动识别 +/- 行首标记，绿色/红色背景 + 左侧彩色指示条
 * - **行高亮标记**：通过 highlightLines 指定行号，淡蓝色背景标记关键代码行
 * - 自带完整样式，可独立于 MarkdownRenderer 使用
 *
 * @example
 * ```tsx
 * // 使用内置主题
 * <CodeBlock language="typescript" colorTheme="github" isDark={isDark}>
 *   {code}
 * </CodeBlock>
 *
 * // 行高亮标记
 * <CodeBlock language="typescript" highlightLines={[3, 5, "8-12"]}>
 *   {code}
 * </CodeBlock>
 *
 * // Diff 高亮模式
 * <CodeBlock language="diff" isDark={isDark} diff>
 *   {diffCode}
 * </CodeBlock>
 * ```
 */
export function CodeBlock({
  children,
  language = "plaintext",
  isDark = true,
  colorTheme,
  customTheme,
  displayMode,
  maxLines = 15,
  maxHeight = "400px",
  showLineNumbers = true,
  stickyLineNumbers = true,
  spotlightOnCollapse = true,
  noShadow = true,
  diff = false,
  highlightLines,
  className = "",
}: CodeBlockProps) {
  const code = children.trim();

  // ---- 主题解析 + CSS 变量 ----
  const resolvedTheme = useMemo(
    () => resolveCodeBlockTheme(colorTheme, customTheme, isDark),
    [colorTheme, customTheme, isDark],
  );

  // ---- 行高亮解析 ----
  const highlightLineSet = useMemo(
    () => (highlightLines != null ? parseHighlightLines(highlightLines) : null),
    [highlightLines],
  );
  const hasHighlights = highlightLineSet != null && highlightLineSet.size > 0;

  const cssVars = useMemo(() => {
    const base = themeVarsToCSSProperties(resolvedTheme.vars);
    if (!diff && !hasHighlights) return base;

    const bg = resolvedTheme.vars.bg;
    const d = isDark;
    const { add, remove, info } = DIFF_LINE_COLORS;
    const rgbaStr = (c: readonly number[], a: number) =>
      `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

    return {
      ...base,
      ...(diff && {
        "--cb-diff-add-bg": rgbaStr(add, d ? 0.15 : 0.1),
        "--cb-diff-add-bg-solid": blendOnBg(bg, add, d ? 0.15 : 0.1),
        "--cb-diff-add-indicator": rgbaStr(add, d ? 0.6 : 0.5),
        "--cb-diff-remove-bg": rgbaStr(remove, d ? 0.15 : 0.1),
        "--cb-diff-remove-bg-solid": blendOnBg(bg, remove, d ? 0.15 : 0.1),
        "--cb-diff-remove-indicator": rgbaStr(remove, d ? 0.6 : 0.5),
        "--cb-diff-info-bg": rgbaStr(info, d ? 0.1 : 0.08),
        "--cb-diff-info-bg-solid": blendOnBg(bg, info, d ? 0.1 : 0.08),
        "--cb-diff-info-indicator": rgbaStr(info, d ? 0.4 : 0.35),
      }),
      ...(hasHighlights && {
        "--cb-hl-bg": rgbaStr(info, d ? 0.1 : 0.08),
        "--cb-hl-bg-solid": blendOnBg(bg, info, d ? 0.1 : 0.08),
        "--cb-hl-indicator": rgbaStr(info, d ? 0.5 : 0.45),
      }),
    };
  }, [resolvedTheme.vars, diff, isDark, hasHighlights]);

  // ---- 模式判定 ----
  const effectiveMode: CodeBlockDisplayMode | null = displayMode ?? null;

  const rawLines = useMemo(() => code.split("\n"), [code]);
  const lineCount = rawLines.length;

  // ---- 行号显示策略 ----
  const lineNumbersVisible =
    showLineNumbers === true
      ? true
      : showLineNumbers === false
        ? false
        : lineCount >= showLineNumbers;

  // ---- Collapse 模式状态 ----
  const [isExpanded, setIsExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const COLLAPSE_BUFFER = 3;
  const shouldCollapse =
    effectiveMode === "collapse" && lineCount > maxLines + COLLAPSE_BUFFER;

  // ---- Scroll / Auto-height 模式状态 ----
  const isScrollable =
    effectiveMode === "scroll" || effectiveMode === "auto-height";
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const [scrollShadow, setScrollShadow] = useState({
    top: false,
    bottom: false,
  });

  // 解析 maxHeight（支持 number 和 string）
  const resolvedMaxHeight =
    typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight;

  // 组件卸载时确保清理 spotlight 状态，防止导航离开后 bottomFade 遮罩未恢复
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  // Scroll shadow 检测（scroll / auto-height 模式）
  useEffect(() => {
    if (!isScrollable) return;
    const el = scrollContentRef.current;
    if (!el) return;

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setScrollShadow({
        top: scrollTop > 2,
        bottom: scrollTop + clientHeight < scrollHeight - 2,
      });
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [isScrollable]);

  // 收起代码块时的处理：滚动到代码块位置 + 聚光灯强调动画（可配置）
  const handleCollapse = useCallback(() => {
    setIsExpanded(false);
    requestAnimationFrame(() => {
      if (wrapperRef.current) {
        // 导航栏高度补偿 + 灵动岛高度 + 额外空间
        const offset = 142;
        const elementPosition = wrapperRef.current.getBoundingClientRect().top;
        const currentScroll = window.scrollY || window.pageYOffset;
        const targetPosition = elementPosition + currentScroll - offset;

        window.scrollTo({
          top: targetPosition,
        });

        // 聚光灯效果：暗化代码块之外的页面内容，强调当前代码块位置
        if (spotlightOnCollapse) {
          const el = wrapperRef.current;
          // 暂时隐藏视口底部的渐变遮罩，避免其覆盖在聚光灯阴影上方
          const bottomFade = document.querySelector(
            "[data-bottom-fade]",
          ) as HTMLElement | null;
          requestAnimationFrame(() => {
            el.classList.add("spotlight-highlight");
            if (bottomFade) {
              bottomFade.style.transition = "opacity 0.25s ease-out";
              bottomFade.style.opacity = "0";
            }
            const onEnd = () => {
              el.classList.remove("spotlight-highlight");
              el.removeEventListener("animationend", onEnd);
              cleanupRef.current = null;
              // 恢复底部渐变遮罩
              if (bottomFade) {
                bottomFade.style.transition = "opacity 0.8s ease-out";
                bottomFade.style.opacity = "";
              }
            };
            el.addEventListener("animationend", onEnd);
            // 注册 cleanup 供组件卸载时调用，确保即使动画未结束也能恢复状态
            cleanupRef.current = () => {
              el.classList.remove("spotlight-highlight");
              el.removeEventListener("animationend", onEnd);
              if (bottomFade) {
                bottomFade.style.transition = "";
                bottomFade.style.opacity = "";
              }
            };
          });
        }
      }
    });
  }, [spotlightOnCollapse]);

  // 语法高亮渲染
  const highlightedCode = (
    <Highlight theme={resolvedTheme.syntax} code={code} language={language}>
      {({
        className: hlClassName,
        style,
        tokens,
        getLineProps,
        getTokenProps,
      }) => (
        <pre className={hlClassName} style={style}>
          <code>
            {tokens.map((line, i) => (
              <div
                key={i}
                {...getLineProps({ line })}
                data-diff={
                  diff
                    ? getDiffLineType(rawLines[i] ?? "") || undefined
                    : undefined
                }
                data-highlight={highlightLineSet?.has(i + 1) || undefined}
              >
                <span className="line-number">{i + 1}</span>
                <span className="line-content">
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </span>
              </div>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  );

  const modeClass =
    effectiveMode === "auto-height"
      ? " auto-height-mode"
      : effectiveMode === "scroll"
        ? " scroll-mode"
        : "";
  const wrapperClass = `qiuye-code-block${diff ? " diff-mode" : ""}${lineNumbersVisible ? "" : " hide-line-numbers"}${stickyLineNumbers && lineNumbersVisible ? " sticky-line-numbers" : ""}${noShadow ? " no-shadow" : ""}${modeClass}${className ? ` ${className}` : ""}`;

  // ---- 普通模式（无显示模式，或 collapse 模式但行数不够触发折叠） ----
  if (!effectiveMode || (effectiveMode === "collapse" && !shouldCollapse)) {
    return (
      <div className={wrapperClass} style={cssVars as React.CSSProperties}>
        {highlightedCode}
        <CodeBlockStyles />
      </div>
    );
  }

  // ---- Collapse 展开/折叠模式 ----
  if (effectiveMode === "collapse" && shouldCollapse) {
    // 折叠高度计算：pre padding-top(0.5rem) + maxLines × 行高(0.875rem × 1.6 = 1.4rem)
    const collapsedMaxHeight = `${0.5 + maxLines * 1.4}rem`;

    return (
      <div className={wrapperClass} style={cssVars as React.CSSProperties}>
        <div
          ref={wrapperRef}
          className={`collapsible-code-block ${isExpanded ? "is-expanded" : "is-collapsed"}`}
        >
          <div
            className="collapsible-code-content"
            style={
              !isExpanded
                ? { maxHeight: collapsedMaxHeight, overflow: "hidden" }
                : undefined
            }
          >
            {highlightedCode}
          </div>

          {/* 折叠状态：渐变遮罩 + 展开按钮 */}
          <AnimatePresence>
            {!isExpanded && (
              <div key="collapsed" className="collapsible-code-overlay">
                <button
                  className="collapsible-code-btn"
                  onClick={() => setIsExpanded(true)}
                >
                  <ChevronDown className="h-3.5 w-3.5 -ml-1" />
                  展开全部 {lineCount} 行
                </button>
              </div>
            )}
          </AnimatePresence>

          {/* 展开状态：悬浮在底部的圆形收起按钮 */}
          <AnimatePresence>
            {isExpanded && (
              <button
                key="collapse-btn"
                className="collapsible-code-collapse-btn"
                onClick={handleCollapse}
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            )}
          </AnimatePresence>
        </div>
        <CodeBlockStyles />
      </div>
    );
  }

  // ---- Scroll / Auto-height 滚动模式 ----
  if (isScrollable) {
    return (
      <div className={wrapperClass} style={cssVars as React.CSSProperties}>
        <div className="scrollable-code-block">
          <div
            ref={scrollContentRef}
            className="scrollable-code-content"
            style={
              effectiveMode === "scroll"
                ? { maxHeight: resolvedMaxHeight }
                : undefined
            }
          >
            {highlightedCode}
          </div>
          {/* 滚动阴影指示器 - 提示上方/下方还有更多内容 */}
          <div
            className={`scroll-shadow scroll-shadow-top${scrollShadow.top ? " visible" : ""}`}
          />
          <div
            className={`scroll-shadow scroll-shadow-bottom${scrollShadow.bottom ? " visible" : ""}`}
          />
        </div>
        <CodeBlockStyles />
      </div>
    );
  }

  // Fallback
  return (
    <div className={wrapperClass} style={cssVars as React.CSSProperties}>
      {highlightedCode}
      <CodeBlockStyles />
    </div>
  );
}

// ============================================
// 样式组件（styled-jsx global，自动去重）
// 所有配色通过 CSS 自定义属性（--cb-xxx）驱动，
// 无需 .dark 前缀重复，同一份 CSS 适配任意主题。
// ============================================

function CodeBlockStyles() {
  return (
    <style jsx global>{`
      /* ============================================
         代码块基础样式
         ============================================ */

      .qiuye-code-block pre {
        margin: 2rem 0;
        padding: 0.5rem 0.5rem 0.5rem 0;
        border-radius: 8px;
        overflow-x: auto;
        font-size: 0.875rem;
        line-height: 1.6;
        box-shadow: 0 4px 12px var(--cb-shadow-lg);
        border: 1px solid var(--cb-border);
        scrollbar-width: thin;
        scrollbar-color: var(--cb-sb-thumb) var(--cb-sb-track);
        overscroll-behavior-x: none;
      }

      .qiuye-code-block pre code {
        font-family:
          "Fira Code", "Monaco", "Menlo", "Ubuntu Mono", "Consolas",
          "source-code-pro", monospace;
        font-size: 0.875rem;
        line-height: 1.6;
        display: block;
        width: fit-content;
        min-width: 100%;
      }

      /* 代码行容器 */
      .qiuye-code-block pre code > div {
        display: flex;
        align-items: flex-start;
        min-height: 1.6em;
        padding: 0 0.25rem;
        /* margin: 0 -0.5rem; */
        border-radius: 0;
      }
      
      .qiuye-code-block.hide-line-numbers pre code > div {
        display: flex;
        align-items: flex-start;
        min-height: 1.6em;
        padding: 0 0.75rem;
        /* margin: 0 -0.5rem; */
        border-radius: 0;
      }

      /* 代码行悬停效果 */
      .qiuye-code-block pre code > div:hover {
        background-color: var(--cb-hover);
      }

      /* ============================================
         行号样式
         ============================================ */

      .qiuye-code-block .line-number {
        display: inline-block;
        width: 3rem;
        min-width: 3rem;
        padding-right: 0.25rem;
        margin-right: 0.5rem;
        text-align: center;
        color: var(--cb-ln-color);
        user-select: none;
        border-right: 1px solid var(--cb-ln-border);
        flex-shrink: 0;
      }

      /* 行内容 */
      .qiuye-code-block .line-content {
        flex: 1;
        white-space: pre;
      }

      /* ============================================
         响应式优化
         ============================================ */

      @media (max-width: 640px) {
        .qiuye-code-block pre {
          margin: 1.5rem 0;
          border-radius: 6px;
          font-size: 0.8rem;
          padding: 0.5rem 0.5rem 0.5rem 0;
        }

        .qiuye-code-block .line-number {
          width: 2.5rem;
          min-width: 2.5rem;
          padding-right: 0.75rem;
          margin-right: 0.75rem;
          font-size: 0.8rem;
        }

        .qiuye-code-block pre code {
          font-size: 0.8rem;
        }
      }

      /* ============================================
         滚动条美化 - Webkit
         ============================================ */

      .qiuye-code-block pre::-webkit-scrollbar {
        height: 10px;
      }

      .qiuye-code-block pre::-webkit-scrollbar-track {
        background: var(--cb-sb-track);
        border-radius: 5px;
      }

      .qiuye-code-block pre::-webkit-scrollbar-thumb {
        background: var(--cb-sb-thumb);
        border-radius: 5px;
        transition: background 0.2s ease;
      }

      .qiuye-code-block pre::-webkit-scrollbar-thumb:hover {
        background: var(--cb-sb-thumb-hover);
      }

      /* ============================================
         可折叠代码块样式
         ============================================ */

      /* 容器 - 接管 pre 的外层样式 */
      .qiuye-code-block .collapsible-code-block {
        position: relative;
        margin: 2rem 0;
        border-radius: 8px;
        box-shadow: 0 4px 12px var(--cb-shadow-lg);
        overflow: hidden;
        border: 1px solid var(--cb-border);
      }

      /* 展开时允许收起按钮突出边框 */
      .qiuye-code-block .collapsible-code-block.is-expanded {
        overflow: visible;
      }

      /* 内容区域接管圆角裁剪（展开时 block overflow: visible，由 content 裁剪背景） */
      .qiuye-code-block .collapsible-code-block .collapsible-code-content {
        overflow: hidden;
        border-radius: inherit;
      }

      /* 内部 pre 取消自身外层样式（由 wrapper 统一处理） */
      .qiuye-code-block .collapsible-code-block .collapsible-code-content pre {
        margin: 0;
        border: none;
        border-radius: 0;
        box-shadow: none;
      }

      /* 渐变遮罩层 */
      .qiuye-code-block .collapsible-code-overlay {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 80px;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding-bottom: 12px;
        pointer-events: none;
        z-index: 1;
        background: linear-gradient(
          to bottom,
          rgba(var(--cb-bg-rgb), 0) 0%,
          rgba(var(--cb-bg-rgb), 0.7) 40%,
          rgba(var(--cb-bg-rgb), 0.95) 80%,
          rgba(var(--cb-bg-rgb), 1) 100%
        );
      }

      /* 展开按钮 */
      .qiuye-code-block .collapsible-code-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 16px;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
        pointer-events: all;
        transition: all 0.2s ease;
        font-family:
          "Inter",
          -apple-system,
          sans-serif;
        background: rgba(var(--cb-bg-rgb), 0.9);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid var(--cb-btn-border);
        color: var(--cb-btn-text);
        box-shadow: 0 2px 8px var(--cb-shadow);
      }

      .qiuye-code-block .collapsible-code-btn:hover {
        color: var(--cb-btn-hover-text);
        border-color: var(--cb-btn-hover-border);
        box-shadow: 0 2px 12px var(--cb-shadow-lg);
      }

      /* 悬浮收起按钮 - 圆形，位于右下角 */
      .qiuye-code-block .collapsible-code-collapse-btn {
        position: absolute;
        bottom: 0;
        right: 0;
        transform: translate(-12px, -12px);
        z-index: 2;
        width: 32px;
        height: 32px;
        opacity: 0.85;
        padding: 0;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s ease;
        background: rgba(var(--cb-bg-rgb), 0.95);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid var(--cb-btn-border);
        color: var(--cb-btn-text);
        box-shadow: 0 2px 8px var(--cb-shadow);
      }

      .qiuye-code-block .collapsible-code-collapse-btn:hover {
        color: var(--cb-btn-hover-text);
        border-color: var(--cb-btn-hover-border);
        box-shadow: 0 2px 12px var(--cb-shadow-lg);
        opacity: 1;
      }

      /* 收起后聚光灯强调动画 —— 通过超大 box-shadow 暗化代码块之外的区域 */
      @keyframes code-block-spotlight {
        0% {
          box-shadow:
            0 4px 12px var(--cb-shadow-lg),
            0 0 0 9999px transparent;
        }
        15%,
        50% {
          box-shadow:
            0 4px 12px var(--cb-shadow-lg),
            0 0 0 9999px var(--cb-spotlight);
        }
        100% {
          box-shadow:
            0 4px 12px var(--cb-shadow-lg),
            0 0 0 9999px transparent;
        }
      }
      .qiuye-code-block .collapsible-code-block.spotlight-highlight {
        z-index: 30;
        animation: code-block-spotlight 1.4s ease-in-out;
      }

      /* 可折叠代码块 - 移动端响应式 */
      @media (max-width: 640px) {
        .qiuye-code-block .collapsible-code-block {
          margin: 1.5rem 0;
          border-radius: 6px;
        }
      }

      /* ============================================
         滚动模式 (scroll + auto-height) 代码块样式
         ============================================ */

      /* 容器 - 接管 pre 的外层样式（与 collapsible-code-block 类似） */
      .qiuye-code-block .scrollable-code-block {
        position: relative;
        margin: 2rem 0;
        border-radius: 8px;
        box-shadow: 0 4px 12px var(--cb-shadow-lg);
        overflow: hidden;
        border: 1px solid var(--cb-border);
        background: var(--cb-bg);
      }

      /* 内部可滚动区域 - 纵向 + 横向均可滚动 */
      .qiuye-code-block .scrollable-code-block .scrollable-code-content {
        overflow: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--cb-sb-thumb) var(--cb-sb-track);
        overscroll-behavior-x: none;
      }

      /* 内部 pre 取消自身外层样式（由 wrapper 统一处理），并取消 overflow 交给父容器 */
      .qiuye-code-block .scrollable-code-block pre {
        margin: 0;
        border: none;
        border-radius: 0;
        box-shadow: none;
        overflow: visible;
      }

      /* Webkit 滚动条美化 - 可滚动代码内容区 */
      .qiuye-code-block .scrollable-code-content::-webkit-scrollbar {
        width: 10px;
        height: 10px;
      }

      .qiuye-code-block .scrollable-code-content::-webkit-scrollbar-track {
        background: var(--cb-sb-track);
      }

      .qiuye-code-block .scrollable-code-content::-webkit-scrollbar-thumb {
        background: var(--cb-sb-thumb);
        border-radius: 5px;
        transition: background 0.2s ease;
      }

      .qiuye-code-block
        .scrollable-code-content::-webkit-scrollbar-thumb:hover {
        background: var(--cb-sb-thumb-hover);
      }

      .qiuye-code-block .scrollable-code-content::-webkit-scrollbar-corner {
        background: var(--cb-sb-track);
      }

      /* ---- 滚动阴影指示器 ---- */
      .qiuye-code-block .scroll-shadow {
        position: absolute;
        left: 0;
        right: 0;
        height: 24px;
        pointer-events: none;
        z-index: 2;
        opacity: 0;
        transition: opacity 0.25s ease;
      }

      .qiuye-code-block .scroll-shadow.visible {
        opacity: 1;
      }

      .qiuye-code-block .scroll-shadow-top {
        top: 0;
        background: linear-gradient(
          to bottom,
          rgba(var(--cb-bg-rgb), 0.75) 0%,
          transparent 100%
        );
        border-radius: 8px 8px 0 0;
      }

      .qiuye-code-block .scroll-shadow-bottom {
        bottom: 0;
        background: linear-gradient(
          to top,
          rgba(var(--cb-bg-rgb), 0.75) 0%,
          transparent 100%
        );
        border-radius: 0 0 8px 8px;
      }

      /* ---- Auto-height 模式 - 自适应父容器高度 ---- */
      .qiuye-code-block.auto-height-mode {
        height: 100%;
        display: flex;
        flex-direction: column;
      }

      .qiuye-code-block.auto-height-mode .scrollable-code-block {
        flex: 1;
        min-height: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
      }

      .qiuye-code-block.auto-height-mode .scrollable-code-content {
        flex: 1;
        min-height: 0;
      }

      /* 滚动模式 - 移动端响应式 */
      @media (max-width: 640px) {
        .qiuye-code-block .scrollable-code-block {
          margin: 1.5rem 0;
          border-radius: 6px;
        }

        .qiuye-code-block .scroll-shadow-top {
          border-radius: 6px 6px 0 0;
        }

        .qiuye-code-block .scroll-shadow-bottom {
          border-radius: 0 0 6px 6px;
        }
      }

      /* ============================================
         Sticky 行号 - 横向滚动时固定左侧行号列
         ============================================ */

      .qiuye-code-block.sticky-line-numbers .line-number {
        position: sticky;
        left: 0;
        z-index: 1;
        background-color: var(--cb-bg);
      }

      .qiuye-code-block.sticky-line-numbers pre code > div:hover .line-number {
        background-color: var(--cb-hover-solid);
      }

      /* ============================================
         隐藏行号模式 - 不显示左侧行号列
         ============================================ */

      .qiuye-code-block.hide-line-numbers .line-number {
        display: none;
      }

      .qiuye-code-block.hide-line-numbers pre {
        padding-left: 0;
      }

      .qiuye-code-block.hide-line-numbers .collapsible-code-block pre,
      .qiuye-code-block.hide-line-numbers .scrollable-code-block pre {
        padding-left: 0;
      }

      /* ============================================
         No shadow 模式 - 隐藏容器阴影
         ============================================ */

      .qiuye-code-block.no-shadow pre,
      .qiuye-code-block.no-shadow .collapsible-code-block,
      .qiuye-code-block.no-shadow .scrollable-code-block {
        box-shadow: none;
      }

      /* ============================================
         Diff 高亮模式 —— 以行首 +/- 标记区分新增/删除行
         ============================================ */

      /* 新增行 - 绿色背景 + 左侧指示条 */
      .qiuye-code-block.diff-mode pre code > div[data-diff="add"] {
        background-color: var(--cb-diff-add-bg);
        box-shadow: inset 3px 0 0 0 var(--cb-diff-add-indicator);
      }

      /* 删除行 - 红色背景 + 左侧指示条 */
      .qiuye-code-block.diff-mode pre code > div[data-diff="remove"] {
        background-color: var(--cb-diff-remove-bg);
        box-shadow: inset 3px 0 0 0 var(--cb-diff-remove-indicator);
      }

      /* 信息行（@@ / +++ / ---） - 蓝色背景 + 左侧指示条 */
      .qiuye-code-block.diff-mode pre code > div[data-diff="info"] {
        background-color: var(--cb-diff-info-bg);
        box-shadow: inset 3px 0 0 0 var(--cb-diff-info-indicator);
      }

      /* Diff 行取消圆角（让连续同类行视觉合并） */
      .qiuye-code-block.diff-mode pre code > div[data-diff] {
        border-radius: 0;
      }

      /* Sticky 行号 —— diff 行使用对应的不透明混合色 */
      .qiuye-code-block.diff-mode.sticky-line-numbers
        pre
        code
        > div[data-diff="add"]
        .line-number {
        background-color: var(--cb-diff-add-bg-solid);
      }

      .qiuye-code-block.diff-mode.sticky-line-numbers
        pre
        code
        > div[data-diff="remove"]
        .line-number {
        background-color: var(--cb-diff-remove-bg-solid);
      }

      .qiuye-code-block.diff-mode.sticky-line-numbers
        pre
        code
        > div[data-diff="info"]
        .line-number {
        background-color: var(--cb-diff-info-bg-solid);
      }

      /* ============================================
         行高亮 —— 淡蓝色背景标记指定行（非 Diff 模式）
         ============================================ */

      .qiuye-code-block pre code > div[data-highlight] {
        background-color: var(--cb-hl-bg);
        border-radius: 0;
        box-shadow: inset 3px 0 0 0 var(--cb-hl-indicator);
      }

      .qiuye-code-block pre code > div[data-highlight]:hover {
        background-color: var(--cb-hl-bg);
      }

      /* Sticky 行号 —— 高亮行使用对应的不透明混合色 */
      .qiuye-code-block.sticky-line-numbers
        pre
        code
        > div[data-highlight]
        .line-number {
        background-color: var(--cb-hl-bg-solid);
      }

      /* ============================================
         CodeBlockPanel 嵌入模式
         在 CodeBlockPanel 内部时，重置 CodeBlock 的
         外层装饰样式（margin / border / radius / shadow），
         由 Panel 统一控制外观。
         ============================================ */

      .code-block-panel-content .qiuye-code-block pre,
      .code-block-panel-content .qiuye-code-block .collapsible-code-block,
      .code-block-panel-content .qiuye-code-block .scrollable-code-block {
        margin: 0;
        border: none;
        border-radius: 0;
        box-shadow: none;
      }
    `}</style>
  );
}
