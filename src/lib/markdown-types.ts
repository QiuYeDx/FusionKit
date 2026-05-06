import type { Components } from "react-markdown";
import type { ComponentType } from "react";
import type {
  CodeBlockDisplayMode,
  CodeBlockColorThemeName,
  CodeBlockThemeConfig,
} from "@/components/qiuye-ui/code-block";
import type { PrismTheme } from "prism-react-renderer";

// ============================================
// 渲染模式与密度
// ============================================

export type MarkdownRenderMode = "blog" | "chat" | "preview";
export type MarkdownSecurityProfile = "trusted" | "untrusted";
export type MarkdownDensity = "article" | "comfortable" | "compact";

// ============================================
// Core Props
// ============================================

/** MarkdownRendererCore 的通用属性 */
export interface MarkdownRendererCoreProps {
  /** Markdown 原文内容 */
  content: string;
  /** 根容器额外类名 */
  className?: string;
  /** 渲染模式，用于生成模式类名 */
  mode?: MarkdownRenderMode;
  /** 安全策略，影响链接、图片和原始 HTML 处理 */
  securityProfile?: MarkdownSecurityProfile;
  /** 排版密度 */
  density?: MarkdownDensity;
  /** 覆盖或扩展 react-markdown 的 components 映射 */
  components?: Components;
  /** Widget 注册表 */
  widgetRegistry?: MarkdownWidgetRegistry;
  /** Widget 运行上下文 */
  widgetContext?: MarkdownWidgetContext;
  /** 代码块配置覆盖 */
  codeBlock?: MarkdownCodeBlockOptions;
  /** 是否为标题生成 id */
  enableHeadingIds?: boolean;
  /** 是否启用原始 HTML */
  enableRawHtml?: boolean;
}

/** Markdown 代码块渲染配置 */
export interface MarkdownCodeBlockOptions {
  /** 代码块显示模式 */
  displayMode?: CodeBlockDisplayMode;
  /** 折叠模式下的最大显示行数 */
  maxLines?: number;
  /** 滚动模式下的最大高度 */
  maxHeight?: string | number;
  /** 横向滚动时是否固定行号列 */
  stickyLineNumbers?: boolean;
  /** 代码块内置配色主题名称 */
  colorTheme?: CodeBlockColorThemeName;
  /** 自定义代码块主题配置 */
  customTheme?: CodeBlockThemeConfig | PrismTheme;
}

// ============================================
// Widget 类型系统
// ============================================

/** Markdown Widget 运行上下文 */
export interface MarkdownWidgetContext {
  /** 消息 id */
  messageId?: string;
  /** 会话 id */
  conversationId?: string;
  /** 当前消息角色 */
  role?: "user" | "assistant" | "system" | "tool";
  /** 当前 Widget 排版密度 */
  density?: MarkdownDensity;
  /** 内容是否仍处于流式输出中 */
  isStreaming?: boolean;
  /** Widget 触发操作时的统一回调 */
  onWidgetAction?: (action: MarkdownWidgetAction) => void | Promise<void>;
}

/** Markdown Widget 操作事件 */
export interface MarkdownWidgetAction {
  /** 触发操作的 widget id */
  widgetId: string;
  /** widget 类型 */
  type: string;
  /** 操作名称 */
  action: string;
  /** 操作载荷 */
  payload?: unknown;
}

/** Markdown Widget 定义 */
export interface MarkdownWidgetDefinition<TProps = unknown> {
  /** widget 类型标识 */
  type: string;
  /** 调试和展示用名称 */
  displayName: string;
  /** widget 协议版本 */
  version?: number;
  /** 实际渲染的 React 组件 */
  component: ComponentType<MarkdownWidgetComponentProps<TProps>>;
  /** 将 fenced code block 的原始 JSON 转换为组件 props */
  parseProps: (
    raw: unknown,
  ) => { ok: true; props: TProps } | { ok: false; reason: string };
  /** 该 widget 需要的能力声明 */
  permissions?: MarkdownWidgetPermission[];
  /** 解析失败时的自定义降级组件 */
  fallback?: ComponentType<MarkdownWidgetFallbackProps>;
}

/** Markdown Widget 组件收到的属性 */
export interface MarkdownWidgetComponentProps<TProps> {
  /** widget 实例 id */
  id: string;
  /** widget 类型 */
  type: string;
  /** 解析后的业务属性 */
  props: TProps;
  /** fenced code block 原始内容 */
  raw: string;
  /** Widget 运行上下文 */
  context: MarkdownWidgetContext;
}

/** Markdown Widget 降级组件收到的属性 */
export interface MarkdownWidgetFallbackProps {
  /** widget 实例 id */
  id: string;
  /** widget 类型 */
  type: string;
  /** fenced code block 原始内容 */
  raw: string;
  /** 降级原因 */
  reason: string;
  /** Widget 运行上下文 */
  context: MarkdownWidgetContext;
}

export type MarkdownWidgetRegistry = Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MarkdownWidgetDefinition<any>
>;
export type MarkdownWidgetPermission =
  | "client-action"
  | "network-read"
  | "external-link";

// ============================================
// Preset 配置
// ============================================

/** Markdown 渲染预设配置 */
export interface MarkdownPresetConfig {
  /** 渲染模式 */
  mode: MarkdownRenderMode;
  /** 排版密度 */
  density: MarkdownDensity;
  /** 安全策略 */
  securityProfile: MarkdownSecurityProfile;
  /** 是否启用原始 HTML */
  enableRawHtml: boolean;
  /** 是否为标题生成 id */
  enableHeadingIds: boolean;
  /** 代码块默认配置 */
  codeBlock: MarkdownCodeBlockOptions;
  /** 该 preset 下的组件映射工厂，由 preset 返回 */
  createComponents?: (ctx: MarkdownPresetComponentContext) => Components;
}

/** Markdown 预设组件映射工厂的上下文 */
export interface MarkdownPresetComponentContext {
  /** 当前主题是否为暗色的 ref，避免 components 闭包滞后 */
  isDarkRef: React.RefObject<boolean>;
  /** 生成标题 id 的工具函数 */
  getHeadingId: (
    rawText: string,
    node?: { position?: { start?: { offset?: number } } },
  ) => string | undefined;
  /** 合并后的代码块配置 */
  codeBlock: MarkdownCodeBlockOptions;
  /** Widget 注册表 */
  widgetRegistry?: MarkdownWidgetRegistry;
  /** Widget 运行上下文 */
  widgetContext?: MarkdownWidgetContext;
  /** 安全策略 */
  securityProfile: MarkdownSecurityProfile;
}
