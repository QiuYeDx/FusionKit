"use client";

import React from "react";
import { MarkdownRendererCore } from "./MarkdownRendererCore";
import { blogPreset } from "./presets/blog-preset";
import type {
  MarkdownCodeBlockOptions,
  MarkdownWidgetRegistry,
  MarkdownWidgetContext,
} from "./markdown-types";
import type { Components } from "react-markdown";
import type {
  CodeBlockDisplayMode,
  CodeBlockColorThemeName,
  CodeBlockThemeConfig,
} from "@/components/qiuye-ui/code-block";
import type { PrismTheme } from "prism-react-renderer";

/** BlogMarkdownRenderer 组件的属性 */
export interface BlogMarkdownRendererProps {
  /** Markdown 原文内容 */
  content: string;
  /** 根容器额外类名 */
  className?: string;
  /** 代码块显示模式，透传给 CodeBlock */
  codeBlockDisplayMode?: CodeBlockDisplayMode;
  /** 折叠模式下的最大显示行数 */
  codeBlockMaxLines?: number;
  /** 滚动模式下的最大高度 */
  codeBlockMaxHeight?: string | number;
  /** 代码块横向滚动时是否固定行号列 */
  stickyLineNumbers?: boolean;
  /** 代码块内置配色主题名称 */
  codeBlockColorTheme?: CodeBlockColorThemeName;
  /** 自定义代码块主题配置 */
  codeBlockCustomTheme?: CodeBlockThemeConfig | PrismTheme;
  /** 覆盖 react-markdown components */
  components?: Components;
  /** Widget 注册表（博客场景一般不用） */
  widgetRegistry?: MarkdownWidgetRegistry;
  /** Widget 上下文 */
  widgetContext?: MarkdownWidgetContext;
}

/**
 * BlogMarkdownRenderer — 面向长文内容的 Markdown 渲染器
 *
 * 提供博客 / 文档场景的 Markdown 排版：
 * - 默认启用 GFM、原始 HTML、标题锚点与文章密度排版
 * - 使用 QiuYe UI CodeBlock 渲染代码块，支持标题和行高亮 meta
 * - 使用 ImageViewer 渲染图片，MermaidBlock 渲染 Mermaid 图表
 * - 可选接入 Widget 注册表扩展自定义内容块
 *
 * @example
 * ```tsx
 * <BlogMarkdownRenderer content={"# 标题\n\n正文内容"} />
 * ```
 */
export function BlogMarkdownRenderer({
  content,
  className = "",
  codeBlockDisplayMode,
  codeBlockMaxLines,
  codeBlockMaxHeight,
  stickyLineNumbers,
  codeBlockColorTheme,
  codeBlockCustomTheme,
  components,
  widgetRegistry,
  widgetContext,
}: BlogMarkdownRendererProps) {
  const codeBlock: MarkdownCodeBlockOptions = {
    displayMode: codeBlockDisplayMode,
    maxLines: codeBlockMaxLines,
    maxHeight: codeBlockMaxHeight,
    stickyLineNumbers: stickyLineNumbers,
    colorTheme: codeBlockColorTheme,
    customTheme: codeBlockCustomTheme,
  };

  return (
    <MarkdownRendererCore
      content={content}
      className={`markdown-renderer ${className}`}
      preset={blogPreset}
      codeBlock={codeBlock}
      components={components}
      widgetRegistry={widgetRegistry}
      widgetContext={widgetContext}
    />
  );
}
