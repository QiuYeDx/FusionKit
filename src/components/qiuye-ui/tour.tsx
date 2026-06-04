"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Tour 弹层相对目标元素的展示方向 */
export type TourPlacement = "top" | "right" | "bottom" | "left";

/** Tour 弹层在交叉轴上的对齐方式 */
export type TourAlign = "start" | "center" | "end";

/** 单个 Tour 引导步骤的配置 */
export interface TourStep {
  /** 步骤唯一标识，不传时使用步骤下标生成稳定 fallback */
  id?: string;
  /**
   * 被引导的目标元素
   * - 传入 `string` 时使用 `document.querySelector` 查询，如 `"#sidebar"`
   * - 传入 `HTMLElement` 时直接作为目标
   * - 传入函数时每次测量都会重新执行，适合动态渲染目标
   */
  target: string | HTMLElement | (() => HTMLElement | null);
  /** Popover 标题 */
  title: React.ReactNode;
  /** Popover 正文内容 */
  content: React.ReactNode;
  /**
   * Popover 相对目标的优先展示方向
   * @default "bottom"
   */
  placement?: TourPlacement;
  /**
   * Popover 在交叉轴上的对齐方式
   * @default "center"
   */
  align?: TourAlign;
  /** Popover 与聚焦区域边缘的距离，单位 px */
  offset?: number;
  /** 目标元素外扩的聚焦区域内边距，单位 px */
  spotlightPadding?: number;
  /** 聚焦区域圆角，单位 px */
  spotlightRadius?: number;
  /** 当前步骤 Popover 的额外 className */
  popoverClassName?: string;
  /** 进入当前步骤后的回调 */
  onEnter?: () => void;
  /** 离开当前步骤前的回调 */
  onLeave?: () => void;
}

/** 自定义 Tour 底部操作区时可使用的上下文 */
export interface TourRenderContext {
  /** 当前步骤配置 */
  step: TourStep;
  /** 当前步骤下标，从 0 开始 */
  stepIndex: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 当前是否为第一步 */
  isFirstStep: boolean;
  /** 当前是否为最后一步 */
  isLastStep: boolean;
  /** 切换到上一步 */
  previous: () => void;
  /** 切换到下一步，最后一步会完成并关闭 */
  next: () => void;
  /** 跳过并关闭 Tour */
  skip: () => void;
  /** 完成并关闭 Tour */
  finish: () => void;
}

/** Tour 组件的属性 */
export interface TourProps {
  /** 引导步骤列表 */
  steps: TourStep[];
  /** 受控打开状态 */
  open?: boolean;
  /**
   * 非受控默认打开状态
   * @default false
   */
  defaultOpen?: boolean;
  /** 打开状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 受控当前步骤下标 */
  currentStep?: number;
  /**
   * 非受控默认步骤下标
   * @default 0
   */
  defaultStep?: number;
  /** 步骤变化回调 */
  onStepChange?: (stepIndex: number) => void;
  /** 点击完成或最后一步继续后的回调 */
  onFinish?: () => void;
  /** 点击跳过或按 Escape 关闭后的回调 */
  onSkip?: () => void;
  /**
   * 打开步骤时是否自动滚动目标元素到可视区域
   * @default true
   */
  scrollIntoView?: boolean;
  /**
   * 是否允许用户点击聚焦区域内的目标元素
   * @default false
   */
  allowTargetInteraction?: boolean;
  /**
   * 点击遮罩层外部时是否跳过并关闭 Tour
   * @default false
   */
  maskClosable?: boolean;
  /**
   * 是否显示遮罩层
   * @default true
   */
  showMask?: boolean;
  /**
   * 顶层浮层 z-index
   * @default 80
   */
  zIndex?: number;
  /**
   * Popover 最大宽度，单位 px
   * @default 340
   */
  popoverWidth?: number;
  /**
   * 视口边缘安全距离，单位 px
   * @default 16
   */
  viewportPadding?: number;
  /** Popover 的额外 className */
  popoverClassName?: string;
  /** 聚焦区域的额外 className */
  spotlightClassName?: string;
  /** 自定义底部操作区 */
  renderFooter?: (context: TourRenderContext) => React.ReactNode;
  /** 根浮层的额外 className */
  className?: string;
}

interface TourRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface PopoverSize {
  width: number;
  height: number;
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  placement: TourPlacement;
  arrowX: number;
  arrowY: number;
}

// 自动滚动期间保持旧视觉步骤，稳定后再提交新步骤并恢复 Motion layout 动画。
type TourScrollPhase = "idle" | "scrolling" | "settling";

interface PendingScrollStep {
  stepIndex: number;
  step: TourStep;
}

const DEFAULT_POPOVER_WIDTH = 340;
const DEFAULT_VIEWPORT_PADDING = 16;
const DEFAULT_SPOTLIGHT_PADDING = 8;
const DEFAULT_SPOTLIGHT_RADIUS = 12;
const DEFAULT_OFFSET = 14;
const DEFAULT_Z_INDEX = 80;
const DEFAULT_POPOVER_HEIGHT = 220;
const ARROW_SAFE_OFFSET = 18;
const SCROLL_STABLE_FRAME_COUNT = 3;
const SCROLL_STABLE_THRESHOLD = 0.5;
const SCROLL_MIN_SETTLE_DURATION = 220;
const SCROLL_NO_MOVEMENT_SETTLE_DURATION = 320;
const SCROLL_MAX_SETTLE_DURATION = 1600;

const layoutTransition = {
  type: "spring" as const,
  duration: 0.5,
  bounce: 0,
};

const reducedTransition = {
  duration: 0.18,
  ease: "easeOut" as const,
};

const instantTransition = {
  duration: 0,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const getViewportSize = (): ViewportSize => {
  if (typeof window === "undefined") {
    return { width: 0, height: 0 };
  }

  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
};

const toTourRect = (rect: DOMRect): TourRect => ({
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  left: rect.left,
  width: rect.width,
  height: rect.height,
});

const expandRect = (
  rect: TourRect,
  padding: number,
  viewport: ViewportSize,
): TourRect => {
  const left = clamp(rect.left - padding, 0, viewport.width);
  const top = clamp(rect.top - padding, 0, viewport.height);
  const right = clamp(rect.right + padding, 0, viewport.width);
  const bottom = clamp(rect.bottom + padding, 0, viewport.height);

  return {
    top,
    right,
    bottom,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
};

const isRectWithinViewport = (
  rect: TourRect,
  viewport: ViewportSize,
  padding: number,
) =>
  rect.top >= padding &&
  rect.left >= padding &&
  rect.bottom <= viewport.height - padding &&
  rect.right <= viewport.width - padding;

const isTargetWithinVisibleBounds = (
  target: HTMLElement,
  rect: TourRect,
  viewport: ViewportSize,
  padding: number,
) => {
  if (!isRectWithinViewport(rect, viewport, padding)) return false;

  let ancestor = target.parentElement;
  while (ancestor && ancestor !== document.body) {
    const styles = window.getComputedStyle(ancestor);
    const clipsX = ["auto", "scroll", "hidden", "clip"].includes(
      styles.overflowX,
    );
    const clipsY = ["auto", "scroll", "hidden", "clip"].includes(
      styles.overflowY,
    );

    if (clipsX || clipsY) {
      const ancestorRect = ancestor.getBoundingClientRect();
      if (
        (clipsX &&
          (rect.left < ancestorRect.left || rect.right > ancestorRect.right)) ||
        (clipsY &&
          (rect.top < ancestorRect.top || rect.bottom > ancestorRect.bottom))
      ) {
        return false;
      }
    }

    ancestor = ancestor.parentElement;
  }

  return true;
};

const hasRectChanged = (
  previous: TourRect,
  next: TourRect,
  threshold: number,
) =>
  Math.abs(previous.top - next.top) > threshold ||
  Math.abs(previous.left - next.left) > threshold ||
  Math.abs(previous.width - next.width) > threshold ||
  Math.abs(previous.height - next.height) > threshold;

const isHTMLElement = (value: unknown): value is HTMLElement =>
  typeof HTMLElement !== "undefined" && value instanceof HTMLElement;

const resolveTarget = (
  target: TourStep["target"] | undefined,
): HTMLElement | null => {
  if (!target || typeof document === "undefined") return null;

  if (typeof target === "string") {
    return document.querySelector<HTMLElement>(target);
  }

  if (typeof target === "function") {
    return target();
  }

  if (isHTMLElement(target)) {
    return target;
  }

  return null;
};

const isEditableTarget = (target: EventTarget | null) => {
  if (!isHTMLElement(target)) return false;

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
};

const getStepKey = (step: TourStep | undefined, index: number) =>
  step?.id ?? `step-${index}`;

const getBestPlacement = (
  preferred: TourPlacement,
  rect: TourRect,
  popoverSize: PopoverSize,
  viewport: ViewportSize,
  offset: number,
  viewportPadding: number,
): TourPlacement => {
  const available = {
    top: rect.top - viewportPadding - offset,
    right: viewport.width - rect.right - viewportPadding - offset,
    bottom: viewport.height - rect.bottom - viewportPadding - offset,
    left: rect.left - viewportPadding - offset,
  };

  const required = {
    top: popoverSize.height,
    right: popoverSize.width,
    bottom: popoverSize.height,
    left: popoverSize.width,
  };

  if (available[preferred] >= required[preferred]) {
    return preferred;
  }

  const fallbackOrder: TourPlacement[] = [
    preferred,
    preferred === "top"
      ? "bottom"
      : preferred === "bottom"
        ? "top"
        : preferred === "left"
          ? "right"
          : "left",
    "bottom",
    "right",
    "top",
    "left",
  ];

  const uniqueOrder = Array.from(new Set(fallbackOrder));
  const fitting = uniqueOrder.find(
    (placement) => available[placement] >= required[placement],
  );

  if (fitting) return fitting;

  return (
    uniqueOrder.sort((a, b) => available[b] - available[a])[0] ?? preferred
  );
};

const getAlignedStart = (
  align: TourAlign,
  rectStart: number,
  rectSize: number,
  popoverSize: number,
) => {
  if (align === "start") return rectStart;
  if (align === "end") return rectStart + rectSize - popoverSize;
  return rectStart + rectSize / 2 - popoverSize / 2;
};

const getPopoverPosition = ({
  rect,
  popoverSize,
  viewport,
  preferredPlacement,
  align,
  offset,
  viewportPadding,
  popoverWidth,
}: {
  rect: TourRect | null;
  popoverSize: PopoverSize;
  viewport: ViewportSize;
  preferredPlacement: TourPlacement;
  align: TourAlign;
  offset: number;
  viewportPadding: number;
  popoverWidth: number;
}): PopoverPosition => {
  const width = Math.max(
    240,
    Math.min(popoverWidth, Math.max(240, viewport.width - viewportPadding * 2)),
  );
  const height = popoverSize.height || DEFAULT_POPOVER_HEIGHT;

  if (!rect || viewport.width === 0 || viewport.height === 0) {
    return {
      top: Math.max(viewportPadding, viewport.height / 2 - height / 2),
      left: Math.max(viewportPadding, viewport.width / 2 - width / 2),
      width,
      placement: "bottom",
      arrowX: width / 2,
      arrowY: 0,
    };
  }

  const size = { width, height };
  const placement = getBestPlacement(
    preferredPlacement,
    rect,
    size,
    viewport,
    offset,
    viewportPadding,
  );

  let left = 0;
  let top = 0;

  if (placement === "top") {
    top = rect.top - height - offset;
    left = getAlignedStart(align, rect.left, rect.width, width);
  } else if (placement === "bottom") {
    top = rect.bottom + offset;
    left = getAlignedStart(align, rect.left, rect.width, width);
  } else if (placement === "left") {
    top = getAlignedStart(align, rect.top, rect.height, height);
    left = rect.left - width - offset;
  } else {
    top = getAlignedStart(align, rect.top, rect.height, height);
    left = rect.right + offset;
  }

  const clampedLeft = clamp(
    left,
    viewportPadding,
    Math.max(viewportPadding, viewport.width - width - viewportPadding),
  );
  const clampedTop = clamp(
    top,
    viewportPadding,
    Math.max(viewportPadding, viewport.height - height - viewportPadding),
  );
  const targetCenterX = rect.left + rect.width / 2;
  const targetCenterY = rect.top + rect.height / 2;

  return {
    top: clampedTop,
    left: clampedLeft,
    width,
    placement,
    arrowX: clamp(
      targetCenterX - clampedLeft,
      ARROW_SAFE_OFFSET,
      width - ARROW_SAFE_OFFSET,
    ),
    arrowY: clamp(
      targetCenterY - clampedTop,
      ARROW_SAFE_OFFSET,
      height - ARROW_SAFE_OFFSET,
    ),
  };
};

const getArrowClassName = (placement: TourPlacement) => {
  if (placement === "top") {
    return "-bottom-1 left-[var(--tour-arrow-x)] -translate-x-1/2";
  }
  if (placement === "bottom") {
    return "-top-1 left-[var(--tour-arrow-x)] -translate-x-1/2";
  }
  if (placement === "left") {
    return "-right-1 top-[var(--tour-arrow-y)] -translate-y-1/2";
  }
  return "-left-1 top-[var(--tour-arrow-y)] -translate-y-1/2";
};

/**
 * Tour — 产品引导组件
 *
 * 用于按步骤高亮页面目标元素并展示说明弹层：
 * - 支持 `target` 选择器、标题、内容与 placement 配置
 * - 内置遮罩层、透明聚焦区域和步骤进度
 * - 聚焦区域与 Popover 使用 Motion `layoutId` 平滑迁移
 * - 支持上一步、下一步、跳过、完成、键盘退出与自动滚动定位
 *
 * @example
 * ```tsx
 * <Tour
 *   open={open}
 *   onOpenChange={setOpen}
 *   steps={[
 *     {
 *       target: "#sidebar",
 *       title: "Navigation",
 *       content: "Browse your projects here.",
 *       placement: "right",
 *     },
 *   ]}
 * />
 * ```
 */
export function Tour({
  steps,
  open,
  defaultOpen = false,
  onOpenChange,
  currentStep,
  defaultStep = 0,
  onStepChange,
  onFinish,
  onSkip,
  scrollIntoView = true,
  allowTargetInteraction = false,
  maskClosable = false,
  showMask = true,
  zIndex = DEFAULT_Z_INDEX,
  popoverWidth = DEFAULT_POPOVER_WIDTH,
  viewportPadding = DEFAULT_VIEWPORT_PADDING,
  popoverClassName,
  spotlightClassName,
  renderFooter,
  className,
}: TourProps) {
  const prefersReducedMotion = useReducedMotion();
  const reactId = useId();
  const instanceId = useMemo(() => reactId.replace(/:/g, ""), [reactId]);
  const titleId = `${instanceId}-title`;
  const contentId = `${instanceId}-content`;

  const [mounted, setMounted] = useState(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [internalStep, setInternalStep] = useState(defaultStep);
  const [visualStepIndex, setVisualStepIndex] = useState(defaultStep);
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null);
  const [spotlightRect, setSpotlightRect] = useState<TourRect | null>(null);
  const [viewport, setViewport] = useState<ViewportSize>({
    width: 0,
    height: 0,
  });
  const [popoverSize, setPopoverSize] = useState<PopoverSize>({
    width: popoverWidth,
    height: DEFAULT_POPOVER_HEIGHT,
  });
  const [hasMeasured, setHasMeasured] = useState(false);
  const [scrollPhase, setScrollPhase] = useState<TourScrollPhase>("idle");

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const scrollMonitorFrameRef = useRef<number | null>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const scrollPhaseRef = useRef<TourScrollPhase>("idle");
  const pendingScrollStepRef = useRef<PendingScrollStep | null>(null);
  const scrollTargetRef = useRef<HTMLElement | null>(null);
  const scrollStartedAtRef = useRef(0);
  const scrollLastRectRef = useRef<TourRect | null>(null);
  const scrollStableFramesRef = useRef(0);
  const scrollHasMovedRef = useRef(false);
  const previousActiveElementRef = useRef<Element | null>(null);
  const lastEnteredStepRef = useRef<number | null>(null);

  const isOpenControlled = open !== undefined;
  const isStepControlled = currentStep !== undefined;
  const resolvedOpen = open ?? internalOpen;
  const rawStepIndex = currentStep ?? internalStep;
  const maxStepIndex = Math.max(0, steps.length - 1);
  const stepIndex = clamp(rawStepIndex, 0, maxStepIndex);
  const requestedStep = steps[stepIndex];
  const clampedVisualStepIndex = clamp(visualStepIndex, 0, maxStepIndex);
  const activeStep = steps[clampedVisualStepIndex];
  const isFirstStep = clampedVisualStepIndex === 0;
  const isLastStep = clampedVisualStepIndex === steps.length - 1;
  const isRequestedFirstStep = stepIndex === 0;
  const isRequestedLastStep = stepIndex === steps.length - 1;
  const requestedStepKey = getStepKey(requestedStep, stepIndex);
  const stepKey = getStepKey(activeStep, clampedVisualStepIndex);
  const transition = prefersReducedMotion
    ? reducedTransition
    : layoutTransition;
  const positionTransition =
    scrollPhase === "idle"
      ? transition
      : { ...transition, layout: instantTransition };
  const contentTransition =
    scrollPhase === "idle"
      ? prefersReducedMotion
        ? reducedTransition
        : layoutTransition
      : instantTransition;

  const setOpenState = useCallback(
    (nextOpen: boolean) => {
      if (!isOpenControlled) {
        setInternalOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isOpenControlled, onOpenChange],
  );

  const setStepState = useCallback(
    (nextStep: number) => {
      const clampedStep = clamp(nextStep, 0, maxStepIndex);
      if (!isStepControlled) {
        setInternalStep(clampedStep);
      }
      onStepChange?.(clampedStep);
    },
    [isStepControlled, maxStepIndex, onStepChange],
  );

  const skip = useCallback(() => {
    onSkip?.();
    setOpenState(false);
  }, [onSkip, setOpenState]);

  const finish = useCallback(() => {
    onFinish?.();
    setOpenState(false);
  }, [onFinish, setOpenState]);

  const previous = useCallback(() => {
    if (isRequestedFirstStep) return;
    setStepState(stepIndex - 1);
  }, [isRequestedFirstStep, setStepState, stepIndex]);

  const next = useCallback(() => {
    if (isRequestedLastStep) {
      finish();
      return;
    }
    setStepState(stepIndex + 1);
  }, [finish, isRequestedLastStep, setStepState, stepIndex]);

  const updateMeasurement = useCallback(
    (
      step: TourStep,
      nextTarget: HTMLElement | null,
      nextViewport: ViewportSize,
    ) => {
      setViewport(nextViewport);
      setTargetElement(nextTarget);
      setHasMeasured(true);

      if (!nextTarget) {
        setSpotlightRect(null);
        return;
      }

      const targetRect = toTourRect(nextTarget.getBoundingClientRect());
      const padding = step.spotlightPadding ?? DEFAULT_SPOTLIGHT_PADDING;
      setSpotlightRect(expandRect(targetRect, padding, nextViewport));
    },
    [],
  );

  const measure = useCallback(() => {
    if (!resolvedOpen || !activeStep) return;

    const nextViewport = getViewportSize();
    const nextTarget = resolveTarget(activeStep.target);
    updateMeasurement(activeStep, nextTarget, nextViewport);
  }, [activeStep, resolvedOpen, updateMeasurement]);

  const setScrollPhaseState = useCallback((nextPhase: TourScrollPhase) => {
    if (scrollPhaseRef.current === nextPhase) return;
    scrollPhaseRef.current = nextPhase;
    setScrollPhase(nextPhase);
  }, []);

  const cancelScrollTracking = useCallback(() => {
    if (scrollMonitorFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollMonitorFrameRef.current);
      scrollMonitorFrameRef.current = null;
    }
    if (scrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      scrollRestoreFrameRef.current = null;
    }

    pendingScrollStepRef.current = null;
    scrollTargetRef.current = null;
    scrollLastRectRef.current = null;
    scrollStableFramesRef.current = 0;
    scrollHasMovedRef.current = false;
  }, []);

  const finishScrollTracking = useCallback(() => {
    if (scrollPhaseRef.current !== "scrolling") return;

    const pendingStep = pendingScrollStepRef.current;
    if (!pendingStep) {
      setScrollPhaseState("idle");
      return;
    }

    if (scrollMonitorFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollMonitorFrameRef.current);
      scrollMonitorFrameRef.current = null;
    }
    if (measureFrameRef.current !== null) {
      window.cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = null;
    }

    const nextViewport = getViewportSize();
    const nextTarget = resolveTarget(pendingStep.step.target);
    pendingScrollStepRef.current = null;
    scrollTargetRef.current = null;
    setScrollPhaseState("settling");
    setVisualStepIndex(pendingStep.stepIndex);
    updateMeasurement(pendingStep.step, nextTarget, nextViewport);

    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
        scrollRestoreFrameRef.current = null;
        setScrollPhaseState("idle");
      });
    });
  }, [setScrollPhaseState, updateMeasurement]);

  const startScrollTracking = useCallback(
    (
      target: HTMLElement,
      initialRect: TourRect,
      pendingStep: PendingScrollStep,
    ) => {
      cancelScrollTracking();
      pendingScrollStepRef.current = pendingStep;
      scrollTargetRef.current = target;
      scrollStartedAtRef.current = performance.now();
      scrollLastRectRef.current = initialRect;

      // 使用目标矩形稳定帧判断滚动结束，兼容页面与嵌套滚动容器。
      const checkScrollSettled = (timestamp: number) => {
        if (
          scrollPhaseRef.current !== "scrolling" ||
          scrollTargetRef.current !== target
        ) {
          return;
        }

        const nextRect = toTourRect(target.getBoundingClientRect());
        const previousRect = scrollLastRectRef.current;
        const moved = previousRect
          ? hasRectChanged(previousRect, nextRect, SCROLL_STABLE_THRESHOLD)
          : false;

        if (moved) {
          scrollHasMovedRef.current = true;
          scrollStableFramesRef.current = 0;
        } else {
          scrollStableFramesRef.current += 1;
        }

        scrollLastRectRef.current = nextRect;

        const elapsed = timestamp - scrollStartedAtRef.current;
        const canSettleWithoutMovement =
          elapsed >= SCROLL_NO_MOVEMENT_SETTLE_DURATION;
        const hasStableFinalPosition =
          elapsed >= SCROLL_MIN_SETTLE_DURATION &&
          scrollStableFramesRef.current >= SCROLL_STABLE_FRAME_COUNT &&
          (scrollHasMovedRef.current || canSettleWithoutMovement);

        if (hasStableFinalPosition || elapsed >= SCROLL_MAX_SETTLE_DURATION) {
          finishScrollTracking();
          return;
        }

        scrollMonitorFrameRef.current =
          window.requestAnimationFrame(checkScrollSettled);
      };

      scrollMonitorFrameRef.current =
        window.requestAnimationFrame(checkScrollSettled);
    },
    [cancelScrollTracking, finishScrollTracking],
  );

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) {
      window.cancelAnimationFrame(measureFrameRef.current);
    }

    measureFrameRef.current = window.requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!resolvedOpen && !isStepControlled) {
      setInternalStep(defaultStep);
    }
  }, [defaultStep, isStepControlled, resolvedOpen]);

  useEffect(() => {
    if (rawStepIndex !== stepIndex && !isStepControlled) {
      setInternalStep(stepIndex);
    }
  }, [isStepControlled, rawStepIndex, stepIndex]);

  useEffect(() => {
    if (!resolvedOpen) {
      cancelScrollTracking();
      setScrollPhaseState("idle");
      setVisualStepIndex(defaultStep);
      setTargetElement(null);
      setSpotlightRect(null);
      setHasMeasured(false);
    }
  }, [
    cancelScrollTracking,
    defaultStep,
    resolvedOpen,
    setScrollPhaseState,
  ]);

  useEffect(() => {
    if (!resolvedOpen || !requestedStep) return;

    let cancelled = false;
    cancelScrollTracking();

    const nextViewport = getViewportSize();
    const target = resolveTarget(requestedStep.target);
    const targetRect = target
      ? toTourRect(target.getBoundingClientRect())
      : null;
    const shouldAutoScroll = Boolean(
      target &&
      targetRect &&
      scrollIntoView &&
      !isTargetWithinVisibleBounds(
        target,
        targetRect,
        nextViewport,
        viewportPadding,
      ),
    );

    if (target && targetRect && shouldAutoScroll) {
      setScrollPhaseState("scrolling");

      measureFrameRef.current = window.requestAnimationFrame(() => {
        measureFrameRef.current = null;
        if (cancelled) return;

        target.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
        startScrollTracking(target, targetRect, {
          stepIndex,
          step: requestedStep,
        });
      });
    } else {
      setScrollPhaseState("idle");
      setVisualStepIndex(stepIndex);
      updateMeasurement(requestedStep, target, nextViewport);

      const frameOne = window.requestAnimationFrame(() => {
        const frameTwo = window.requestAnimationFrame(() => {
          if (!cancelled) {
            const refreshedViewport = getViewportSize();
            const refreshedTarget = resolveTarget(requestedStep.target);
            updateMeasurement(
              requestedStep,
              refreshedTarget,
              refreshedViewport,
            );
          }
        });

        measureFrameRef.current = frameTwo;
      });

      measureFrameRef.current = frameOne;
    }

    return () => {
      cancelled = true;
      cancelScrollTracking();
      if (measureFrameRef.current !== null) {
        window.cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
    };
  }, [
    cancelScrollTracking,
    prefersReducedMotion,
    requestedStep,
    requestedStepKey,
    resolvedOpen,
    scrollIntoView,
    setScrollPhaseState,
    startScrollTracking,
    stepIndex,
    updateMeasurement,
    viewportPadding,
  ]);

  useEffect(() => {
    if (!resolvedOpen) return;

    const handleScrollOrResize = () => {
      if (scrollPhaseRef.current === "settling") return;
      scheduleMeasure();
    };

    window.addEventListener("resize", handleScrollOrResize);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.visualViewport?.addEventListener("resize", handleScrollOrResize);
    window.visualViewport?.addEventListener("scroll", handleScrollOrResize);

    const observer =
      targetElement && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(handleScrollOrResize)
        : null;
    if (observer && targetElement) {
      observer.observe(targetElement);
    }

    return () => {
      window.removeEventListener("resize", handleScrollOrResize);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.visualViewport?.removeEventListener(
        "resize",
        handleScrollOrResize,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        handleScrollOrResize,
      );
      observer?.disconnect();
    };
  }, [resolvedOpen, scheduleMeasure, targetElement]);

  useEffect(() => {
    return () => {
      cancelScrollTracking();
    };
  }, [cancelScrollTracking]);

  useEffect(() => {
    if (!resolvedOpen) return;

    const preventScroll = (event: Event) => {
      if (event.cancelable) {
        event.preventDefault();
      }
    };

    window.addEventListener("wheel", preventScroll, { passive: false });
    window.addEventListener("touchmove", preventScroll, { passive: false });

    return () => {
      window.removeEventListener("wheel", preventScroll);
      window.removeEventListener("touchmove", preventScroll);
    };
  }, [resolvedOpen]);

  useEffect(() => {
    if (!resolvedOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        skip();
        return;
      }

      if (scrollPhase !== "idle") return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        previous();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [next, previous, resolvedOpen, scrollPhase, skip]);

  useEffect(() => {
    if (!resolvedOpen) return;

    previousActiveElementRef.current = document.activeElement;

    return () => {
      const previousElement = previousActiveElementRef.current;
      if (isHTMLElement(previousElement)) {
        previousElement.focus({ preventScroll: true });
      }
      previousActiveElementRef.current = null;
    };
  }, [resolvedOpen]);

  useEffect(() => {
    if (!resolvedOpen || !hasMeasured || scrollPhase !== "idle") return;

    const focusFrame = window.requestAnimationFrame(() => {
      popoverRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(focusFrame);
  }, [hasMeasured, resolvedOpen, scrollPhase, stepKey]);

  useEffect(() => {
    if (!resolvedOpen || !requestedStep) {
      const previousStepIndex = lastEnteredStepRef.current;
      if (previousStepIndex !== null) {
        steps[previousStepIndex]?.onLeave?.();
      }
      lastEnteredStepRef.current = null;
      return;
    }

    const previousStepIndex = lastEnteredStepRef.current;
    if (previousStepIndex === stepIndex) return;

    if (previousStepIndex !== null) {
      steps[previousStepIndex]?.onLeave?.();
    }

    requestedStep.onEnter?.();
    lastEnteredStepRef.current = stepIndex;
  }, [requestedStep, resolvedOpen, stepIndex, steps]);

  useEffect(() => {
    if (!resolvedOpen || !popoverRef.current) return;

    const updateSize = () => {
      const rect = popoverRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopoverSize({
        width: rect.width || popoverWidth,
        height: rect.height || DEFAULT_POPOVER_HEIGHT,
      });
    };

    updateSize();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSize);
    observer.observe(popoverRef.current);

    return () => observer.disconnect();
  }, [popoverWidth, resolvedOpen, stepKey]);

  const preferredPlacement = activeStep?.placement ?? "bottom";
  const align = activeStep?.align ?? "center";
  const offset = activeStep?.offset ?? DEFAULT_OFFSET;
  const spotlightRadius =
    activeStep?.spotlightRadius ?? DEFAULT_SPOTLIGHT_RADIUS;
  const popoverPosition = useMemo(
    () =>
      getPopoverPosition({
        rect: spotlightRect,
        popoverSize,
        viewport,
        preferredPlacement,
        align,
        offset,
        viewportPadding,
        popoverWidth,
      }),
    [
      align,
      offset,
      popoverSize,
      popoverWidth,
      preferredPlacement,
      spotlightRect,
      viewport,
      viewportPadding,
    ],
  );

  const renderContext: TourRenderContext | null = activeStep
    ? {
        step: activeStep,
        stepIndex: clampedVisualStepIndex,
        totalSteps: steps.length,
        isFirstStep,
        isLastStep,
        previous,
        next,
        skip,
        finish,
      }
    : null;

  const handleMaskClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (maskClosable) {
        skip();
      }
    },
    [maskClosable, skip],
  );

  const blockers = useMemo(() => {
    if (!spotlightRect || viewport.width === 0 || viewport.height === 0) {
      return [];
    }

    return [
      {
        key: "top",
        style: {
          top: 0,
          left: 0,
          width: viewport.width,
          height: spotlightRect.top,
        },
      },
      {
        key: "left",
        style: {
          top: spotlightRect.top,
          left: 0,
          width: spotlightRect.left,
          height: spotlightRect.height,
        },
      },
      {
        key: "right",
        style: {
          top: spotlightRect.top,
          left: spotlightRect.right,
          width: Math.max(0, viewport.width - spotlightRect.right),
          height: spotlightRect.height,
        },
      },
      {
        key: "bottom",
        style: {
          top: spotlightRect.bottom,
          left: 0,
          width: viewport.width,
          height: Math.max(0, viewport.height - spotlightRect.bottom),
        },
      },
    ];
  }, [spotlightRect, viewport]);

  if (!mounted || !resolvedOpen || steps.length === 0 || !activeStep) {
    return null;
  }

  const missingTarget = hasMeasured && !targetElement;
  const shouldRenderSpotlight = Boolean(showMask && spotlightRect);
  const shouldRenderMaskBlockers = Boolean(
    showMask && spotlightRect && scrollPhase === "idle",
  );
  const shouldRenderTargetBlocker =
    Boolean(showMask && spotlightRect && scrollPhase === "idle") &&
    !allowTargetInteraction;

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="tour-root"
        className={cn("fixed inset-0 pointer-events-none", className)}
        style={{ zIndex }}
        inert={scrollPhase !== "idle" ? true : undefined}
        aria-hidden={scrollPhase !== "idle" ? true : undefined}
        initial={{ opacity: 0 }}
        animate={{ opacity: scrollPhase === "idle" ? 1 : 0 }}
        exit={{ opacity: 0 }}
        transition={
          prefersReducedMotion ? reducedTransition : { duration: 0.2 }
        }
      >
        <LayoutGroup id={`${instanceId}-layout`}>
          {shouldRenderMaskBlockers &&
            blockers.map((blocker) => (
              <div
                key={blocker.key}
                className="fixed pointer-events-auto"
                style={blocker.style}
                onClick={handleMaskClick}
              />
            ))}

          {shouldRenderTargetBlocker && (
            <div
              className="fixed pointer-events-auto"
              style={{
                top: spotlightRect?.top,
                left: spotlightRect?.left,
                width: spotlightRect?.width,
                height: spotlightRect?.height,
              }}
              onClick={handleMaskClick}
            />
          )}

          {shouldRenderSpotlight && spotlightRect && (
            <motion.div
              layout
              layoutId={`${instanceId}-spotlight`}
              className={cn(
                "fixed pointer-events-none border border-white/70 ring-1 ring-primary/50",
                "shadow-[0_0_0_9999px_rgba(2,6,23,0.58)] dark:shadow-[0_0_0_9999px_rgba(0,0,0,0.68)]",
                spotlightClassName,
              )}
              style={{
                top: spotlightRect.top,
                left: spotlightRect.left,
                width: spotlightRect.width,
                height: spotlightRect.height,
                borderRadius: spotlightRadius,
              }}
              transition={positionTransition}
            />
          )}

          {hasMeasured && (
            <motion.div
              ref={popoverRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={contentId}
              layout
              layoutId={`${instanceId}-popover`}
              className={cn(
                "fixed pointer-events-auto outline-none",
                "rounded-lg border border-border/80 bg-popover text-popover-foreground shadow-2xl",
                "focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                popoverClassName,
                activeStep.popoverClassName,
              )}
              style={
                {
                  top: popoverPosition.top,
                  left: popoverPosition.left,
                  width: popoverPosition.width,
                  "--tour-arrow-x": `${popoverPosition.arrowX}px`,
                  "--tour-arrow-y": `${popoverPosition.arrowY}px`,
                } as React.CSSProperties
              }
              initial={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.96, y: 6 }
              }
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={
                prefersReducedMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: 0.98, y: 4 }
              }
              transition={positionTransition}
            >
              {spotlightRect && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute z-0 size-3 rotate-45 border-border/80 bg-popover",
                    popoverPosition.placement === "top" && "border-r border-b",
                    popoverPosition.placement === "bottom" &&
                      "border-l border-t",
                    popoverPosition.placement === "left" && "border-t border-r",
                    popoverPosition.placement === "right" &&
                      "border-b border-l",
                    getArrowClassName(popoverPosition.placement),
                  )}
                />
              )}

              <motion.div
                layout
                className="relative z-10 space-y-4 p-4"
                transition={positionTransition}
              >
                <motion.div
                  layout
                  className="flex items-start justify-between gap-3"
                  transition={positionTransition}
                >
                  <div className="min-w-0 space-y-1">
                    <h2
                      id={titleId}
                      className="text-sm font-semibold leading-6 text-popover-foreground"
                    >
                      {activeStep.title}
                    </h2>
                    <div className="sr-only" aria-live="polite">
                      Step {clampedVisualStepIndex + 1} of {steps.length}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px]"
                  >
                    {clampedVisualStepIndex + 1} / {steps.length}
                  </Badge>
                </motion.div>

                <motion.div
                  layout
                  className="relative overflow-hidden"
                  transition={positionTransition}
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      layout
                      key={stepKey}
                      id={contentId}
                      className="text-sm leading-6 text-muted-foreground"
                      initial={
                        prefersReducedMotion
                          ? { opacity: 0 }
                          : { opacity: 0, y: 4 }
                      }
                      animate={{ opacity: 1, y: 0 }}
                      exit={
                        prefersReducedMotion
                          ? { opacity: 0 }
                          : { opacity: 0, y: -4 }
                      }
                      transition={
                        contentTransition
                      }
                    >
                      {activeStep.content}
                      {missingTarget && (
                        <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                          当前目标暂不可见，你仍然可以继续下一步或跳过引导。
                        </p>
                      )}
                    </motion.div>
                  </AnimatePresence>
                </motion.div>

                {renderFooter && renderContext ? (
                  renderFooter(renderContext)
                ) : (
                  <motion.div
                    layout
                    className="flex flex-wrap items-center justify-between gap-2 pt-1"
                    transition={positionTransition}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 px-2 text-muted-foreground cursor-pointer"
                      onClick={skip}
                    >
                      <X className="size-3.5" />
                      Skip
                    </Button>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 px-2.5 cursor-pointer"
                        disabled={isFirstStep}
                        onClick={previous}
                      >
                        <ChevronLeft className="size-3.5" />
                        Previous
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 gap-1.5 px-3 cursor-pointer"
                        onClick={next}
                      >
                        {isLastStep ? "Done" : "Next"}
                        {!isLastStep && <ChevronRight className="size-3.5" />}
                      </Button>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            </motion.div>
          )}
        </LayoutGroup>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
