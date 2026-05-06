"use client";

import React, { Component } from "react";
import type { ReactNode } from "react";

interface WidgetErrorBoundaryProps {
  widgetId: string;
  widgetType: string;
  children: ReactNode;
  fallback?: ReactNode;
}

interface WidgetErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class WidgetErrorBoundary extends Component<
  WidgetErrorBoundaryProps,
  WidgetErrorBoundaryState
> {
  constructor(props: WidgetErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): WidgetErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    if (process.env.NODE_ENV === "development") {
      console.error(
        `[Widget Error] ${this.props.widgetType}#${this.props.widgetId}:`,
        error,
        errorInfo,
      );
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="my-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <p className="text-sm font-medium text-destructive">
            Widget 渲染失败
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {this.props.widgetType}
            {process.env.NODE_ENV === "development" &&
              this.state.error &&
              ` — ${this.state.error.message}`}
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
