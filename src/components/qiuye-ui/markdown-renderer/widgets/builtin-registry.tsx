import type { MarkdownWidgetRegistry } from "../markdown-types";
import { toolCallWidget } from "./ToolCallWidget";
import { artifactWidget } from "./ArtifactWidget";
import { referenceCardWidget } from "./ReferenceCardWidget";

/**
 * 内置 widget 注册表。
 * 包含安全、低耦合的基础 widget，可直接用于 Agent 会话。
 */
export const builtinWidgetRegistry: MarkdownWidgetRegistry = {
  [toolCallWidget.type]: toolCallWidget,
  [artifactWidget.type]: artifactWidget,
  [referenceCardWidget.type]: referenceCardWidget,
};
