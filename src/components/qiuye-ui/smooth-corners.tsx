"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import {
  smoothCorners,
  smoothCornersCSS,
} from "@qiuyedx/smooth-corners";
import { observe, unobserve } from "@qiuyedx/smooth-corners/observer";

import { cn } from "@/lib/utils";

type SmoothCornerVars = Record<"--sc-r" | "--sc-i" | "--sc-s", string>;
type SmoothCornerStyle = React.CSSProperties & Partial<SmoothCornerVars>;

const STYLE_ID = "qiuye-ui-smooth-corners-style";

/**
 * 可复用的基础 CSS。需要手动放入全局样式时可直接使用该字符串。
 */
export const smoothCornersBaseCSS = smoothCornersCSS;

function ensureSmoothCornersStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = smoothCornersCSS;
  document.head.append(style);
}

function useSmoothCornersStyles() {
  React.useInsertionEffect(() => {
    ensureSmoothCornersStyles();
  }, []);
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref && "current" in ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (value: T | null) => {
    for (const ref of refs) {
      assignRef(ref, value);
    }
  };
}

function normalizeNumber(value: number | undefined, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/** SmoothCorners 组件的属性 */
export interface SmoothCornersProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "style"> {
  /**
   * 原始圆角半径，单位 px。
   * @default 16
   */
  radius?: number;
  /**
   * 平滑强度，范围 0..1。0 表示标准圆弧，1 表示最大平滑。
   * @default 0.6
   */
  smoothing?: number;
  /**
   * 是否根据元素实际尺寸自动压缩 smoothing。
   * 开启后会用 ResizeObserver 读取元素尺寸，适合大圆角或尺寸动态变化的元素。
   * @default false
   */
  observeSize?: boolean;
  /**
   * 是否把效果应用到唯一子元素本身，而不是额外包一层 div。
   * 适合 Button、Card、图片、链接等已有语义元素。
   * @default false
   */
  asChild?: boolean;
  /**
   * 禁用平滑圆角效果。
   * @default false
   */
  disabled?: boolean;
  /**
   * 根元素样式。组件会合并 `--sc-r`、`--sc-i`、`--sc-s` 自定义属性。
   */
  style?: SmoothCornerStyle;
}

/**
 * SmoothCorners — Figma/iOS 风格平滑圆角包装组件
 *
 * 基于 CSS `corner-shape: superellipse(...)` 做渐进增强：
 * - 支持时使用补偿半径 + superellipse 获得连续圆角
 * - 不支持时回退到原始 `border-radius`
 *
 * @example
 * ```tsx
 * <SmoothCorners radius={28} smoothing={0.7} className="bg-primary p-6" />
 * ```
 *
 * @example
 * ```tsx
 * <SmoothCorners asChild radius={18} smoothing={0.75}>
 *   <Button>Continuous button</Button>
 * </SmoothCorners>
 * ```
 */
export const SmoothCorners = React.forwardRef<HTMLElement, SmoothCornersProps>(
  (
    {
      radius = 16,
      smoothing = 0.6,
      observeSize = false,
      asChild = false,
      disabled = false,
      className,
      style,
      ...props
    },
    forwardedRef
  ) => {
    useSmoothCornersStyles();

    const localRef = React.useRef<HTMLElement | null>(null);
    const normalizedRadius = normalizeNumber(radius, 16);
    const normalizedSmoothing = normalizeNumber(smoothing, 0.6);

    const vars = React.useMemo<SmoothCornerStyle>(() => {
      if (disabled) return {};
      return smoothCorners(
        normalizedRadius,
        normalizedSmoothing
      ) as SmoothCornerStyle;
    }, [disabled, normalizedRadius, normalizedSmoothing]);

    React.useEffect(() => {
      const el = localRef.current;
      if (!el || disabled || !observeSize) return;

      observe(el, {
        radius: normalizedRadius,
        smoothing: normalizedSmoothing,
      });

      return () => {
        unobserve(el);
      };
    }, [disabled, normalizedRadius, normalizedSmoothing, observeSize]);

    const Comp = asChild ? Slot : "div";
    const mergedRef = composeRefs<HTMLElement>(localRef, forwardedRef);

    return (
      <Comp
        ref={mergedRef}
        className={cn(!disabled && "smooth-corners", className)}
        style={{ ...style, ...vars }}
        {...props}
      />
    );
  }
);

SmoothCorners.displayName = "SmoothCorners";
