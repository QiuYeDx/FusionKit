"use client";

import React, { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Check, Copy } from "lucide-react";
import { DualStateToggle } from "@/components/qiuye-ui/dual-state-toggle";
import type { CodeBlockColorThemeName } from "./code-block-themes";

// ============================================
// Panel 主题配色
// ============================================

/**
 * 每套主题对应的面板外壳背景色
 *
 * 面板背景比代码区域背景略深，营造容器层次感。
 */
const PANEL_BG: Record<
  CodeBlockColorThemeName,
  { dark: string; light: string }
> = {
  qiuvision: { dark: "#111113", light: "#E5E5E3" },
  github: { dark: "#010409", light: "#EEF1F5" },
  one: { dark: "#21252B", light: "#E6E7E8" },
  dracula: { dark: "#21222C", light: "#EAEAE5" },
  nord: { dark: "#252B35", light: "#DEE2EA" },
  vitesse: { dark: "#0A0A0A", light: "#EBEBEB" },
  monokai: { dark: "#1E1F1A", light: "#EBEBEA" },
};

/** 面板亮暗模式下的文本 / 图标通用配色 */
const PANEL_TEXT = {
  dark: {
    border: "rgba(255,255,255,0.08)",
    filename: "rgba(255,255,255,0.4)",
    btn: "rgba(255,255,255,0.4)",
    btnHover: "rgba(255,255,255,0.7)",
    btnHoverBg: "rgba(255,255,255,0.1)",
    check: "#34d399",
  },
  light: {
    border: "rgba(0,0,0,0.08)",
    filename: "rgba(0,0,0,0.45)",
    btn: "rgba(0,0,0,0.35)",
    btnHover: "rgba(0,0,0,0.65)",
    btnHoverBg: "rgba(0,0,0,0.06)",
    check: "#059669",
  },
} as const;

// ============================================
// 语言显示名称映射
// ============================================

/** 常见编程语言的显示名称映射 */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
  python: "Python",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  json: "JSON",
  yaml: "YAML",
  xml: "XML",
  markdown: "Markdown",
  bash: "Bash",
  shell: "Shell",
  sh: "Shell",
  zsh: "Zsh",
  sql: "SQL",
  graphql: "GraphQL",
  rust: "Rust",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  ruby: "Ruby",
  php: "PHP",
  csharp: "C#",
  cpp: "C++",
  c: "C",
  dart: "Dart",
  r: "R",
  lua: "Lua",
  perl: "Perl",
  scala: "Scala",
  diff: "Diff",
  dockerfile: "Dockerfile",
  docker: "Docker",
  toml: "TOML",
  ini: "INI",
  vue: "Vue",
  svelte: "Svelte",
};

/**
 * 获取编程语言的格式化显示名称
 *
 * 优先使用内置映射表；未命中时回退到首字母大写。
 * 对于 "plaintext" 返回 null（不适合作为标签显示）。
 */
function getLanguageDisplayName(language: string): string | null {
  const lower = language.toLowerCase();
  if (lower === "plaintext" || lower === "text" || lower === "plain") {
    return null;
  }
  return (
    LANGUAGE_DISPLAY_NAMES[lower] ??
    language.charAt(0).toUpperCase() + language.slice(1)
  );
}

// ============================================
// CodeBlockPanel 组件
// ============================================

export interface CodeBlockPanelProps {
  /** 文件名标签（显示在面板顶部左侧） */
  filename?: string;
  /**
   * 编程语言标识（当未设置 filename 时，作为 fallback 标签显示语言类型）
   *
   * 传入后若 filename 为空且 showLanguageLabel 为 true，
   * 会在面板顶部左侧显示格式化后的语言名称（如 "TypeScript"、"Python"）。
   */
  language?: string;
  /**
   * 是否在未设置 filename 时自动显示语言类型标签（默认 true）
   *
   * 设为 false 后即使传入了 language，也不会作为 fallback 标签显示。
   */
  showLanguageLabel?: boolean;
  /**
   * 代码文本内容（用于复制按钮功能）
   *
   * 传入后复制按钮自动可用；不传则不显示复制按钮。
   */
  code?: string;
  /** 是否显示复制按钮（需要同时传入 code，默认 true） */
  showCopyButton?: boolean;
  /** 是否为深色模式（控制面板配色的浅色/深色变体选择，默认 true） */
  isDark?: boolean;
  /**
   * 内置配色主题名称（默认 "github"）
   *
   * 与 isDark 配合使用，自动选择对应的浅色/深色面板配色。
   * 可选值: "qiuvision" | "github" | "one" | "dracula" | "nord" | "vitesse" | "monokai"
   */
  colorTheme?: CodeBlockColorThemeName;
  /** 子元素（通常为 CodeBlock 组件） */
  children: React.ReactNode;
  /** 额外的 CSS 类名 */
  className?: string;
}

/**
 * 代码块外层容器面板
 *
 * 仿照 Tailwind CSS 官网的代码块风格，提供面板外壳、
 * 文件名标签、复制按钮等功能。搭配 CodeBlock 组件使用。
 *
 * 特性：
 * - **7 套内置配色主题**（与 CodeBlock 主题一一对应），各有浅色/深色变体
 * - 可选文件名标签（顶部左侧）
 * - **语言类型 fallback 标签**：未设置 filename 时，自动显示语言名称（如 "TypeScript"），视觉更平衡
 * - 可选复制按钮（顶部右侧），带复制成功动画反馈
 * - 自动重置内部 CodeBlock 的 margin / border / shadow
 *
 * @example
 * ```tsx
 * // 显示文件名标签
 * <CodeBlockPanel filename="app.tsx" code={code} colorTheme="github" isDark>
 *   <CodeBlock language="tsx" colorTheme="github" isDark>
 *     {code}
 *   </CodeBlock>
 * </CodeBlockPanel>
 *
 * // 不设置 filename，自动显示语言类型 "TypeScript" 作为 fallback 标签
 * <CodeBlockPanel language="typescript" code={code} colorTheme="github" isDark>
 *   <CodeBlock language="typescript" colorTheme="github" isDark>
 *     {code}
 *   </CodeBlock>
 * </CodeBlockPanel>
 *
 * // 关闭语言类型 fallback 标签
 * <CodeBlockPanel language="typescript" showLanguageLabel={false} code={code}>
 *   <CodeBlock language="typescript">{code}</CodeBlock>
 * </CodeBlockPanel>
 * ```
 */
export function CodeBlockPanel({
  filename,
  language,
  showLanguageLabel = true,
  code,
  showCopyButton = true,
  isDark = true,
  colorTheme = "github",
  children,
  className,
}: CodeBlockPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyToggle = useCallback(
    async (newActive: boolean) => {
      if (!newActive || !code) return;
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // 静默失败（如不支持 Clipboard API 时）
      }
    },
    [code],
  );

  const hasCopyButton = showCopyButton && !!code;

  // 当没有 filename 时，语言类型作为 fallback 标签
  const languageLabel =
    !filename && showLanguageLabel && language
      ? getLanguageDisplayName(language)
      : null;
  const displayLabel = filename ?? languageLabel;
  const showTrafficLights = !displayLabel;
  const hasHeader = !!displayLabel || hasCopyButton || showTrafficLights;

  // 解析面板配色
  const mode = isDark ? "dark" : "light";
  const panelBg = PANEL_BG[colorTheme]?.[mode] ?? PANEL_BG.github[mode];
  const text = PANEL_TEXT[mode];

  return (
    <div
      className={cn("group/code-panel rounded-xl", className)}
      style={
        {
          backgroundColor: panelBg,
          boxShadow: `inset 0 0 0 1px ${text.border}`,
          "--cbp-filename": text.filename,
          "--cbp-btn": text.btn,
          "--cbp-btn-hover": text.btnHover,
          "--cbp-btn-hover-bg": text.btnHoverBg,
          "--cbp-check": text.check,
        } as React.CSSProperties
      }
    >
      {/* ---- 面板内容区域 ---- */}
      <div className="rounded-xl p-1 text-sm">
        {/* ---- 头部：文件名 + 复制按钮 ---- */}
        {hasHeader && (
          <div className="flex items-center justify-between px-3 pt-0.5 pb-1">
            {displayLabel ? (
              <span className="cbp-filename text-xs/5 font-medium select-none">
                {displayLabel}
              </span>
            ) : (
              <div
                className="flex items-center gap-2 py-0.5 select-none"
                aria-hidden="true"
              >
                <span className="size-[10px] rounded-full bg-[#FF5F56]" />
                <span className="size-[10px] rounded-full bg-[#FFBD2E]" />
                <span className="size-[10px] rounded-full bg-[#27C93F]" />
              </div>
            )}
            {hasCopyButton && (
              <DualStateToggle
                active={copied}
                onToggle={handleCopyToggle}
                activeIcon={<Check className="cbp-check" strokeWidth={2} />}
                inactiveIcon={<Copy strokeWidth={1.5} />}
                effect="scale"
                variant="ghost"
                size="icon"
                className="cbp-copy-btn size-7!"
                title="复制到剪贴板"
                activeLabel="已复制"
                inactiveLabel="复制到剪贴板"
                transitionDuration={0.2}
              />
            )}
          </div>
        )}
        {/* ---- 代码内容容器 ---- */}
        <div className="code-block-panel-content overflow-hidden rounded-lg">
          {children}
        </div>
      </div>

      {/* Panel 配色样式（通过 CSS 变量驱动，自动去重） */}
      <style jsx global>{`
        .cbp-filename {
          color: var(--cbp-filename);
        }
        .cbp-copy-btn {
          color: var(--cbp-btn) !important;
          transition:
            color 0.15s ease,
            background-color 0.15s ease;
        }
        .cbp-copy-btn:hover {
          color: var(--cbp-btn-hover) !important;
          background-color: var(--cbp-btn-hover-bg) !important;
        }
        .cbp-check {
          color: var(--cbp-check);
        }
      `}</style>
    </div>
  );
}
