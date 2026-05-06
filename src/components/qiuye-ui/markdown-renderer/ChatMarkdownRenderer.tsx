"use client";

import React from "react";
import { MarkdownRendererCore } from "./MarkdownRendererCore";
import { chatPreset } from "./presets/chat-preset";
import { builtinWidgetRegistry } from "./widgets/builtin-registry";
import type {
  MarkdownCodeBlockOptions,
  MarkdownWidgetRegistry,
  MarkdownWidgetContext,
} from "./markdown-types";
import type { Components } from "react-markdown";

/** ChatMarkdownRenderer 组件的属性 */
export interface ChatMarkdownRendererProps {
  /** Markdown 原文内容 */
  content: string;
  /** 根容器额外类名 */
  className?: string;
  /** 覆盖 react-markdown components */
  components?: Components;
  /** Widget 注册表，默认使用 builtin registry */
  widgetRegistry?: MarkdownWidgetRegistry;
  /** Widget 上下文 */
  widgetContext?: MarkdownWidgetContext;
  /** 代码块配置覆盖 */
  codeBlock?: MarkdownCodeBlockOptions;
  /** 是否启用原始 HTML（默认 false，untrusted） */
  enableRawHtml?: boolean;
}

/**
 * ChatMarkdownRenderer — 面向 AI 会话的 Markdown 渲染器
 *
 * 提供紧凑且更安全的会话渲染预设：
 * - 默认使用 untrusted 安全策略并禁用原始 HTML
 * - 代码块使用较小滚动高度，适合消息气泡或对话面板
 * - 内置 tool-call、artifact、reference-card 三类 Widget
 * - 链接和图片地址会经过安全清理与策略校验
 *
 * @example
 * ```tsx
 * <ChatMarkdownRenderer content={"我可以渲染 `inline code`。"} />
 * ```
 */
export function ChatMarkdownRenderer({
  content,
  className = "",
  components,
  widgetRegistry,
  widgetContext,
  codeBlock,
  enableRawHtml,
}: ChatMarkdownRendererProps) {
  const registry = widgetRegistry ?? builtinWidgetRegistry;

  return (
    <MarkdownRendererCore
      content={content}
      className={className}
      preset={chatPreset}
      codeBlock={codeBlock}
      components={components}
      widgetRegistry={registry}
      widgetContext={widgetContext}
      enableRawHtml={enableRawHtml}
    />
  );
}
