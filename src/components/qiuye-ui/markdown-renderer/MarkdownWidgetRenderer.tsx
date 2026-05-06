"use client";

import React from "react";
import type {
  MarkdownWidgetRegistry,
  MarkdownWidgetContext,
} from "./markdown-types";
import type { MarkdownWidgetInvocation } from "@/lib/markdown/parse-widget-fence";
import { WidgetErrorBoundary } from "./widgets/WidgetErrorBoundary";
import { UnknownWidget } from "./widgets/UnknownWidget";

interface MarkdownWidgetRendererProps {
  invocation: MarkdownWidgetInvocation;
  registry: MarkdownWidgetRegistry;
  context: MarkdownWidgetContext;
}

export function MarkdownWidgetRenderer({
  invocation,
  registry,
  context,
}: MarkdownWidgetRendererProps) {
  const { id, type, raw, propsRaw } = invocation;

  const definition = registry[type];
  if (!definition) {
    return <UnknownWidget type={type} id={id} raw={raw} />;
  }

  if (propsRaw === null) {
    return (
      <UnknownWidget
        type={type}
        id={id}
        raw={raw}
        reason="JSON 解析失败"
      />
    );
  }

  const parseResult = definition.parseProps(propsRaw);
  if (!parseResult.ok) {
    const FallbackComponent = definition.fallback;
    if (FallbackComponent) {
      return (
        <FallbackComponent
          id={id}
          type={type}
          raw={raw}
          reason={parseResult.reason}
          context={context}
        />
      );
    }
    return (
      <UnknownWidget
        type={type}
        id={id}
        raw={raw}
        reason={parseResult.reason}
      />
    );
  }

  const WidgetComponent = definition.component;

  return (
    <WidgetErrorBoundary widgetId={id} widgetType={type}>
      <div className="qv-widget my-3">
        <WidgetComponent
          id={id}
          type={type}
          props={parseResult.props}
          raw={raw}
          context={context}
        />
      </div>
    </WidgetErrorBoundary>
  );
}
