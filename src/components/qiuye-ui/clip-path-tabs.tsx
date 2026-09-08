"use client";

import * as React from "react";

import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/** ClipPathTabs 单个标签项的配置 */
export interface ClipPathTabsItem {
  /** 标签项的唯一值 */
  value: string;
  /** 标签项显示内容 */
  label: React.ReactNode;
  /** 标签前方的可选图标 */
  icon?: React.ReactNode;
  /**
   * 是否禁用该标签项
   * @default false
   */
  disabled?: boolean;
  /** label 不是纯文本时使用的无障碍标签 */
  ariaLabel?: string;
}

/** ClipPathTabs 的尺寸 */
export type ClipPathTabsSize = "sm" | "md" | "lg";

/** ClipPathTabs 选中区域的形状 */
export type ClipPathTabsShape = "pill" | "rounded";

/** ClipPathTabs 选中区域的过渡模式 */
export type ClipPathTabsTransitionMode = "continuous" | "segmented";

/** ClipPathTabs 组件的属性 */
export interface ClipPathTabsProps extends Omit<
  React.ComponentPropsWithoutRef<typeof Tabs>,
  "value" | "defaultValue" | "onValueChange" | "orientation"
> {
  /** 标签项配置数组，value 应保持唯一 */
  items: ClipPathTabsItem[];
  /** 当前选中的标签值（受控模式） */
  value?: string;
  /** 非受控模式的默认标签值，未传时选中第一个可用项 */
  defaultValue?: string;
  /** 标签值变化回调 */
  onValueChange?: (value: string) => void;
  /**
   * 选中区域形状
   * - `"pill"`：纯圆胶囊
   * - `"rounded"`：圆角矩形
   * @default "pill"
   */
  shape?: ClipPathTabsShape;
  /**
   * 自定义圆角，会覆盖 shape 的默认圆角
   * - 传入 `number` 时单位为 px
   * - 传入 `string` 时作为 CSS 值
   */
  cornerRadius?: number | string;
  /**
   * 是否为圆角矩形启用 Figma/iOS 风格平滑圆角
   * - 仅在 `shape="rounded"` 时生效
   * - `continuous` 与 `segmented` 两种过渡模式均支持
   * @default false
   */
  smoothCorners?: boolean;
  /**
   * 平滑圆角强度，范围 0..1。仅在 `smoothCorners` 为 true 时生效
   * @default 0.7
   */
  smoothCornerSmoothing?: number;
  /**
   * 标签尺寸
   * - `"sm"`：32px
   * - `"md"`：34px
   * - `"lg"`：44px
   * @default "md"
   */
  size?: ClipPathTabsSize;
  /**
   * 是否让所有标签等宽并撑满父容器
   * @default false
   */
  fullWidth?: boolean;
  /**
   * 是否禁用整个标签组
   * @default false
   */
  disabled?: boolean;
  /**
   * 普通状态背景色，可传 CSS 色值或变量
   * @default "transparent"
   */
  inactiveBackground?: string;
  /**
   * 普通状态文本颜色，可传 CSS 色值或变量
   * @default "var(--muted-foreground)"
   */
  inactiveForeground?: string;
  /**
   * 选中状态背景色，可传 CSS 色值或变量
   * @default "var(--primary)"
   */
  activeBackground?: string;
  /**
   * 选中状态文本颜色，可传 CSS 色值或变量
   * @default "var(--primary-foreground)"
   */
  activeForeground?: string;
  /**
   * 选中背景的过渡模式
   * - `"continuous"`：过渡中保持为一块连续背景，不显示标签间隙
   * - `"segmented"`：过渡中保留各标签之间的间隙
   * @default "continuous"
   */
  transitionMode?: ClipPathTabsTransitionMode;
  /**
   * clip-path 过渡时长，单位为毫秒
   * @default 250
   */
  transitionDuration?: number;
  /**
   * clip-path 过渡缓动函数
   * @default "ease"
   */
  transitionEasing?: string;
  /** 标签列表的无障碍名称 */
  ariaLabel?: string;
  /** 标签列表的额外 className */
  listClassName?: string;
  /** 每个真实标签按钮的额外 className */
  triggerClassName?: string;
  /** 选中态视觉标签的额外 className */
  activeItemClassName?: string;
  /** 标签面板内容 */
  children?: React.ReactNode;
}

const sizeStyles: Record<ClipPathTabsSize, { item: string; content: string }> =
  {
    sm: {
      item: "h-8 px-3 text-xs",
      content: "gap-1.5 [&_svg]:size-3.5",
    },
    md: {
      item: "h-[34px] px-2.5 text-sm sm:px-4",
      content: "gap-1.5 sm:gap-2 [&_svg]:size-4",
    },
    lg: {
      item: "h-11 px-3 text-sm sm:px-5",
      content: "gap-1.5 sm:gap-2 [&_svg]:size-4.5",
    },
  };

function getFirstEnabledValue(items: ClipPathTabsItem[]) {
  return items.find((item) => !item.disabled)?.value ?? "";
}

function toCssLength(value: number | string) {
  return typeof value === "number" ? `${value}px` : value;
}

function toFixedPixel(value: number) {
  return `${Math.max(0, Number(value.toFixed(3)))}px`;
}

function toPixelNumber(value: number | string) {
  if (typeof value === "number") return value;

  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/**
 * ClipPathTabs — 通过 clip-path 平滑切换选中态的标签按钮组
 *
 * 适合少量同级内容视图之间的切换：
 * - 叠放普通态与选中态两个视觉层，仅动画上层的 inset 裁剪区域
 * - 默认使用连续背景跨越标签间隙，也可保留分段式过渡效果
 * - 同步过渡背景与文字颜色，不依赖分离的颜色补间
 * - 支持胶囊与圆角矩形、三档尺寸、等宽布局和自定义颜色
 * - 基于 Radix Tabs，支持受控/非受控状态、键盘导航和标签面板
 * - 尺寸变化时自动校准裁剪区域，并尊重 prefers-reduced-motion
 *
 * 组件不会添加 hover 效果。
 *
 * @example
 * ```tsx
 * const [value, setValue] = useState("overview");
 *
 * <ClipPathTabs
 *   ariaLabel="项目视图"
 *   value={value}
 *   onValueChange={setValue}
 *   items={[
 *     { value: "overview", label: "概览" },
 *     { value: "activity", label: "动态" },
 *   ]}
 * >
 *   <ClipPathTabsContent value="overview">概览内容</ClipPathTabsContent>
 *   <ClipPathTabsContent value="activity">动态内容</ClipPathTabsContent>
 * </ClipPathTabs>
 * ```
 */
export const ClipPathTabs = React.forwardRef<
  React.ElementRef<typeof Tabs>,
  ClipPathTabsProps
>(function ClipPathTabs(
  {
    items,
    value: controlledValue,
    defaultValue,
    onValueChange,
    shape = "pill",
    cornerRadius,
    smoothCorners = false,
    smoothCornerSmoothing = 0.7,
    size = "md",
    fullWidth = false,
    disabled = false,
    inactiveBackground = "transparent",
    inactiveForeground = "var(--muted-foreground)",
    activeBackground = "var(--primary)",
    activeForeground = "var(--primary-foreground)",
    transitionMode = "continuous",
    transitionDuration = 250,
    transitionEasing = "ease",
    ariaLabel = "标签页",
    listClassName,
    triggerClassName,
    activeItemClassName,
    children,
    className,
    style,
    ...props
  },
  ref,
) {
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = React.useState(
    () => defaultValue ?? getFirstEnabledValue(items),
  );
  const requestedValue = isControlled ? controlledValue : internalValue;
  const resolvedValue = items.some(
    (item) => item.value === requestedValue && !item.disabled,
  )
    ? requestedValue
    : getFirstEnabledValue(items);

  const stageRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const activeIndicatorRef = React.useRef<HTMLSpanElement>(null);
  const activeLayerRef = React.useRef<HTMLDivElement>(null);
  const triggerRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const hasMeasuredRef = React.useRef(false);
  const resizeFrameRef = React.useRef<number | null>(null);
  const updateClipPathRef = React.useRef<(animate: boolean) => void>(() => {});

  const styles = sizeStyles[size];
  const resolvedCornerRadius =
    cornerRadius ?? (shape === "pill" ? "9999px" : "8px");
  const radius = toCssLength(resolvedCornerRadius);
  const smoothCornerRadius = toPixelNumber(resolvedCornerRadius);
  const shouldSmoothCorners =
    smoothCorners && shape === "rounded" && smoothCornerRadius !== null;
  const shouldUseSmoothContinuousIndicator =
    shouldSmoothCorners && transitionMode === "continuous";
  const clipRadius = shouldSmoothCorners ? "0px" : radius;
  const columns = `repeat(${Math.max(items.length, 1)}, minmax(0, 1fr))`;
  const itemValuesKey = items.map((item) => item.value).join("\u0000");

  const handleValueChange = React.useCallback(
    (nextValue: string) => {
      if (disabled) return;

      if (!isControlled) {
        setInternalValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [disabled, isControlled, onValueChange],
  );

  const updateClipPath = React.useCallback(
    (animate: boolean) => {
      const stage = stageRef.current;
      const list = listRef.current;
      const activeIndicator = shouldUseSmoothContinuousIndicator
        ? activeIndicatorRef.current
        : null;
      const activeLayer = activeLayerRef.current;
      const activeTrigger = triggerRefs.current.get(resolvedValue);
      if (!stage || !list || !activeLayer) return;

      const supportsClipPath =
        typeof CSS !== "undefined" &&
        CSS.supports("clip-path", "inset(0px 0px 0px 0px round 9999px)");

      stage.dataset.clipSupported = String(supportsClipPath);

      if (!supportsClipPath) {
        if (activeIndicator) activeIndicator.style.visibility = "hidden";
        activeLayer.style.visibility = "hidden";
        triggerRefs.current.forEach((trigger, itemValue) => {
          const active = itemValue === resolvedValue;
          trigger.style.backgroundColor = active
            ? "var(--clip-path-tabs-active-background)"
            : "var(--clip-path-tabs-inactive-background)";
          trigger.style.color = active
            ? "var(--clip-path-tabs-active-foreground)"
            : "var(--clip-path-tabs-inactive-foreground)";
        });
        return;
      }

      triggerRefs.current.forEach((trigger) => {
        trigger.style.backgroundColor =
          "var(--clip-path-tabs-inactive-background)";
        trigger.style.color = "var(--clip-path-tabs-inactive-foreground)";
      });

      if (!activeTrigger) {
        if (activeIndicator) activeIndicator.style.visibility = "hidden";
        activeLayer.style.visibility = "hidden";
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      const triggerRect = activeTrigger.getBoundingClientRect();
      const top = triggerRect.top - stageRect.top;
      const right = stageRect.right - triggerRect.right;
      const bottom = stageRect.bottom - triggerRect.bottom;
      const left = triggerRect.left - stageRect.left;
      const duration =
        animate && hasMeasuredRef.current
          ? `${Math.max(0, transitionDuration)}ms`
          : "0ms";

      activeLayer.style.transitionDuration = duration;
      activeLayer.style.transitionTimingFunction = transitionEasing;
      activeLayer.style.clipPath = `inset(${toFixedPixel(top)} ${toFixedPixel(right)} ${toFixedPixel(bottom)} ${toFixedPixel(left)} round ${clipRadius})`;
      activeLayer.style.visibility = "visible";

      if (activeIndicator) {
        activeIndicator.style.transitionDuration = duration;
        activeIndicator.style.transitionTimingFunction = transitionEasing;
        activeIndicator.style.width = toFixedPixel(triggerRect.width);
        activeIndicator.style.height = toFixedPixel(triggerRect.height);
        activeIndicator.style.transform = `translate3d(${toFixedPixel(left)}, ${toFixedPixel(top)}, 0)`;
        activeIndicator.style.visibility = "visible";
      }

      hasMeasuredRef.current = true;
    },
    [
      clipRadius,
      resolvedValue,
      shouldUseSmoothContinuousIndicator,
      transitionDuration,
      transitionEasing,
    ],
  );

  React.useLayoutEffect(() => {
    hasMeasuredRef.current = false;
  }, [shouldUseSmoothContinuousIndicator]);

  React.useLayoutEffect(() => {
    updateClipPathRef.current = updateClipPath;
    updateClipPath(true);
  }, [updateClipPath]);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const scheduleUpdate = () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        updateClipPathRef.current(false);
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);

    resizeObserver?.observe(list);
    triggerRefs.current.forEach((trigger) => resizeObserver?.observe(trigger));
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [itemValuesKey]);

  const renderItemContent = (item: ClipPathTabsItem) => (
    <span
      className={cn("flex min-w-0 items-center justify-center", styles.content)}
    >
      {item.icon && (
        <span className="flex shrink-0 items-center justify-center">
          {item.icon}
        </span>
      )}
      <span className="truncate">{item.label}</span>
    </span>
  );

  return (
    <Tabs
      {...props}
      ref={ref}
      orientation="horizontal"
      value={resolvedValue}
      onValueChange={handleValueChange}
      aria-disabled={disabled || undefined}
      data-slot="clip-path-tabs"
      data-shape={shape}
      data-size={size}
      data-transition-mode={transitionMode}
      className={cn(fullWidth ? "w-full" : "w-fit max-w-full", className)}
      style={
        {
          ...style,
          "--clip-path-tabs-inactive-background": inactiveBackground,
          "--clip-path-tabs-inactive-foreground": inactiveForeground,
          "--clip-path-tabs-active-background": activeBackground,
          "--clip-path-tabs-active-foreground": activeForeground,
          "--clip-path-tabs-radius": radius,
        } as React.CSSProperties
      }
    >
      <div
        ref={stageRef}
        data-slot="clip-path-tabs-stage"
        data-clip-supported="unknown"
        className={cn(
          "relative isolate max-w-full",
          fullWidth ? "w-full" : "w-fit",
        )}
      >
        <TabsList
          ref={listRef}
          aria-label={ariaLabel}
          className={cn(
            "relative grid h-auto max-w-full gap-1 rounded-none bg-transparent p-0 text-current",
            fullWidth ? "w-full" : "w-fit",
            listClassName,
          )}
          style={{ gridTemplateColumns: columns }}
        >
          {items.map((item) => (
            <SmoothCorners
              key={item.value}
              asChild
              radius={smoothCornerRadius ?? 8}
              smoothing={smoothCornerSmoothing}
              disabled={!shouldSmoothCorners}
            >
              <TabsTrigger
                ref={(node) => {
                  if (node) triggerRefs.current.set(item.value, node);
                  else triggerRefs.current.delete(item.value);
                }}
                value={item.value}
                disabled={disabled || item.disabled}
                aria-label={item.ariaLabel}
                data-slot="clip-path-tabs-trigger"
                className={cn(
                  "relative min-w-0 flex-none cursor-pointer border-transparent bg-transparent font-medium shadow-none outline-offset-2 transition-none",
                  "text-[var(--clip-path-tabs-inactive-foreground)] data-[state=active]:bg-transparent data-[state=active]:text-[var(--clip-path-tabs-inactive-foreground)] data-[state=active]:shadow-none",
                  "dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent",
                  "focus-visible:outline-2 focus-visible:outline-ring focus-visible:ring-0",
                  shape === "pill" ? "rounded-full" : "rounded-lg",
                  styles.item,
                  fullWidth && "w-full",
                  triggerClassName,
                )}
                style={{
                  borderRadius: shouldSmoothCorners
                    ? undefined
                    : "var(--clip-path-tabs-radius)",
                  backgroundColor: "var(--clip-path-tabs-inactive-background)",
                  color: "var(--clip-path-tabs-inactive-foreground)",
                }}
              >
                {renderItemContent(item)}
              </TabsTrigger>
            </SmoothCorners>
          ))}
        </TabsList>

        {shouldUseSmoothContinuousIndicator ? (
          <SmoothCorners
            asChild
            radius={smoothCornerRadius}
            smoothing={smoothCornerSmoothing}
          >
            <span
              ref={activeIndicatorRef}
              aria-hidden="true"
              data-slot="clip-path-tabs-active-indicator"
              className="pointer-events-none absolute left-0 top-0 z-[5] bg-[var(--clip-path-tabs-active-background)] transition-[transform,width,height] motion-reduce:transition-none"
              style={{ visibility: "hidden" }}
            />
          </SmoothCorners>
        ) : null}

        <div
          ref={activeLayerRef}
          aria-hidden="true"
          data-slot="clip-path-tabs-active-layer"
          data-transition-mode={transitionMode}
          className="pointer-events-none absolute inset-0 z-10 grid gap-1 overflow-hidden transition-[clip-path] motion-reduce:transition-none"
          style={{
            gridTemplateColumns: columns,
            backgroundColor:
              transitionMode === "continuous" &&
              !shouldUseSmoothContinuousIndicator
                ? "var(--clip-path-tabs-active-background)"
                : "transparent",
            visibility: "hidden",
          }}
        >
          {items.map((item) => (
            <SmoothCorners
              key={item.value}
              asChild
              radius={smoothCornerRadius ?? 8}
              smoothing={smoothCornerSmoothing}
              disabled={!shouldSmoothCorners}
            >
              <span
                data-slot="clip-path-tabs-active-item"
                className={cn(
                  "flex min-w-0 items-center justify-center overflow-hidden border border-transparent font-medium",
                  shape === "pill" ? "rounded-full" : "rounded-lg",
                  styles.item,
                  fullWidth && "w-full",
                  activeItemClassName,
                )}
                style={{
                  borderRadius: shouldSmoothCorners
                    ? undefined
                    : "var(--clip-path-tabs-radius)",
                  backgroundColor:
                    transitionMode === "segmented"
                      ? "var(--clip-path-tabs-active-background)"
                      : "transparent",
                  color: "var(--clip-path-tabs-active-foreground)",
                }}
              >
                {renderItemContent(item)}
              </span>
            </SmoothCorners>
          ))}
        </div>
      </div>

      {children}
    </Tabs>
  );
});

ClipPathTabs.displayName = "ClipPathTabs";

/**
 * ClipPathTabsContent — ClipPathTabs 对应的标签面板
 *
 * @example
 * ```tsx
 * <ClipPathTabsContent value="overview">概览内容</ClipPathTabsContent>
 * ```
 */
export const ClipPathTabsContent = TabsContent;
