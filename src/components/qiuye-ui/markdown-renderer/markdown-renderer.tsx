"use client";

import React from "react";
import {
  BlogMarkdownRenderer,
  type BlogMarkdownRendererProps,
} from "./BlogMarkdownRenderer";

/**
 * MarkdownRenderer — 通用 Markdown 渲染器
 *
 * 基于博客场景预设的默认出口：
 * - 支持 GFM、原始 HTML、标题锚点和表格
 * - 内置 CodeBlock、ImageViewer、Mermaid 图表渲染
 * - 可通过 components / widgetRegistry 扩展渲染能力
 *
 * @example
 * ```tsx
 * <MarkdownRenderer content={"# 标题\n\n这是一段 **Markdown**。"} />
 * ```
 */
export function MarkdownRenderer(props: BlogMarkdownRendererProps) {
  return <BlogMarkdownRenderer {...props} />;
}

export default MarkdownRenderer;

export { BlogMarkdownRenderer } from "./BlogMarkdownRenderer";
export { ChatMarkdownRenderer } from "./ChatMarkdownRenderer";
export type { BlogMarkdownRendererProps } from "./BlogMarkdownRenderer";
export type { ChatMarkdownRendererProps } from "./ChatMarkdownRenderer";
export type {
  MarkdownCodeBlockOptions,
  MarkdownDensity,
  MarkdownPresetComponentContext,
  MarkdownPresetConfig,
  MarkdownRenderMode,
  MarkdownRendererCoreProps,
  MarkdownSecurityProfile,
  MarkdownWidgetAction,
  MarkdownWidgetComponentProps,
  MarkdownWidgetContext,
  MarkdownWidgetDefinition,
  MarkdownWidgetFallbackProps,
  MarkdownWidgetPermission,
  MarkdownWidgetRegistry,
} from "./markdown-types";
