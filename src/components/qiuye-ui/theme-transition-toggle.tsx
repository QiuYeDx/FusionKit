"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { MoonIcon, SunIcon } from "lucide-react";

import {
  DualStateToggle,
  type DualStateToggleProps,
} from "@/components/qiuye-ui/dual-state-toggle";
import { cn } from "@/lib/utils";

type ViewTransitionLike = {
  ready: Promise<void>;
  finished: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
};

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike;
};

type ThemeTransitionLayer = "new" | "old";
type PolygonTransitionShape = "star" | "diamond" | "hexagon";

const ELLIPSE_Y_RATIO = 0.72;
const STAR_INNER_RADIUS_RATIO = 0.46;
const POLYGON_COVER_MULTIPLIERS: Record<PolygonTransitionShape, number> = {
  star: 2.6,
  diamond: 1.5,
  hexagon: 1.25,
};
const DEFAULT_TRANSITION_DURATION = 580;
const DEFAULT_TRANSITION_EASING = "cubic-bezier(0.17,0.84,0.44,1)";

/** 主题切换时的几何揭幕形状 */
export type ThemeTransitionShape =
  | "circle"
  | "ellipse"
  | "star"
  | "diamond"
  | "hexagon";

/** 主题切换动画的方向 */
export type ThemeTransitionDirection = "auto" | "enter" | "exit";

/** 主题切换动画的时间预设 */
export type ThemeTransitionTiming = "spring" | "smooth";

/** 计算揭幕动画起点时可使用的来源 */
export type ThemeTransitionOrigin =
  | HTMLElement
  | React.RefObject<HTMLElement | null>
  | PointerEvent
  | MouseEvent
  | React.MouseEvent<HTMLElement>
  | { x: number; y: number }
  | "center";

/** 执行 View Transition 主题动画时使用的配置 */
export interface ThemeTransitionOptions {
  /** 触发主题切换的 DOM 更新函数 */
  updateTheme: () => void;
  /**
   * 用于计算几何揭幕中心点的来源
   * @default "center"
   */
  origin?: ThemeTransitionOrigin | null;
  /**
   * 动画时长，单位毫秒
   * @default 580
   */
  duration?: number;
  /**
   * CSS easing 曲线
   * @default "cubic-bezier(0.17,0.84,0.44,1)"
   */
  easing?: string;
  /**
   * 动画时间预设
   * - `"spring"`：使用连续半径插值，保留兼容命名但不做 overshoot/尾段停靠
   * - `"smooth"`：只使用起止两帧，完全由 duration/easing 控制
   * @default "spring"
   */
  timing?: ThemeTransitionTiming;
  /**
   * 揭幕形状
   * - `"circle"`：圆形揭幕
   * - `"ellipse"`：椭圆揭幕
   * - `"star"`：五角星揭幕
   * - `"diamond"`：菱形揭幕
   * - `"hexagon"`：六边形揭幕
   * @default "circle"
   */
  shape?: ThemeTransitionShape;
  /**
   * 主题截图的揭幕方向
   * - `"auto"`：进入深色时扩散新主题，回到浅色时收束旧主题
   * - `"enter"`：始终扩散新主题截图
   * - `"exit"`：始终收束旧主题截图
   * @default "auto"
   */
  direction?: ThemeTransitionDirection;
  /** 切换前是否为深色主题，用于 direction="auto" 的方向判断 */
  isDark?: boolean;
  /**
   * 切换后的目标主题是否为深色；传入后会在 View Transition 的 update 阶段同步更新 html class
   */
  targetDark?: boolean;
  /**
   * 深色主题挂载在 documentElement 上的 className，设为 null 可关闭同步
   * @default "dark"
   */
  themeClassName?: string | null;
  /**
   * 额外覆盖半径，避免大屏和缩放场景下边角露白
   * @default 48
   */
  extraRadius?: number;
  /**
   * 是否尊重系统减少动态效果偏好
   * @default true
   */
  respectReducedMotion?: boolean;
  /** View Transition 不可用或被降级时触发 */
  onFallback?: () => void;
  /** 动画完成后的回调 */
  onFinish?: () => void;
}

/** useThemeTransition Hook 的配置 */
export interface UseThemeTransitionOptions
  extends Omit<ThemeTransitionOptions, "updateTheme" | "origin"> {
  /** 触发主题切换的 DOM 更新函数 */
  updateTheme: () => void;
  /**
   * 默认揭幕中心点；调用 run 时传入的 origin 会覆盖它
   * @default "center"
   */
  origin?: ThemeTransitionOrigin | null;
}

/** ThemeTransitionToggle 组件的属性 */
export interface ThemeTransitionToggleProps
  extends Omit<
      DualStateToggleProps,
      | "active"
      | "onToggle"
      | "activeIcon"
      | "inactiveIcon"
      | "activeLabel"
      | "inactiveLabel"
      | "shape"
    >,
    Omit<ThemeTransitionOptions, "updateTheme" | "origin"> {
  /** 当前是否处于深色主题 */
  isDark: boolean;
  /** 主题切换回调，组件会在 View Transition 的 update 阶段调用它 */
  onToggle: (nextDark: boolean) => void;
  /**
   * 浅色主题下显示的图标
   * @default <SunIcon />
   */
  lightIcon?: React.ReactNode;
  /**
   * 深色主题下显示的图标
   * @default <MoonIcon />
   */
  darkIcon?: React.ReactNode;
  /**
   * 浅色主题下的无障碍标签
   * @default "切换到深色主题"
   */
  lightLabel?: string;
  /**
   * 深色主题下的无障碍标签
   * @default "切换到浅色主题"
   */
  darkLabel?: string;
  /**
   * 按钮形状快捷设置，独立于揭幕 shape
   * @default "square"
   */
  buttonShape?: DualStateToggleProps["shape"];
  /** 点击切换前触发 */
  onToggleStart?: (nextDark: boolean) => void;
}

function isViewTransitionSupported() {
  return typeof document !== "undefined" && "startViewTransition" in document;
}

function shouldReduceMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function getRefCurrent(
  origin: ThemeTransitionOrigin,
): HTMLElement | undefined {
  if (
    typeof origin === "object" &&
    "current" in origin &&
    origin.current instanceof HTMLElement
  ) {
    return origin.current;
  }

  return undefined;
}

function getPointFromOrigin(origin: ThemeTransitionOrigin | null | undefined) {
  if (typeof window === "undefined") {
    return { x: 0, y: 0 };
  }

  if (!origin || origin === "center") {
    const { width, height } = getViewportSize();

    return {
      x: width / 2,
      y: height / 2,
    };
  }

  const refElement = getRefCurrent(origin);
  if (refElement) {
    const rect = refElement.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  if (typeof HTMLElement !== "undefined" && origin instanceof HTMLElement) {
    const rect = origin.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  if ("clientX" in origin && "clientY" in origin) {
    return {
      x: origin.clientX,
      y: origin.clientY,
    };
  }

  if ("x" in origin && "y" in origin) {
    return {
      x: origin.x,
      y: origin.y,
    };
  }

  return {
    x: getViewportSize().width / 2,
    y: getViewportSize().height / 2,
  };
}

function getViewportSize() {
  if (typeof window === "undefined") {
    return { width: 0, height: 0 };
  }

  const viewport = window.visualViewport;

  return {
    width: Math.max(
      window.innerWidth,
      document.documentElement.clientWidth,
      viewport?.width ?? 0,
    ),
    height: Math.max(
      window.innerHeight,
      document.documentElement.clientHeight,
      viewport?.height ?? 0,
    ),
  };
}

function getCircleCoverRadius(x: number, y: number, extraRadius: number) {
  if (typeof window === "undefined") return extraRadius;

  const { width, height } = getViewportSize();

  return (
    Math.max(
      Math.hypot(x, y),
      Math.hypot(width - x, y),
      Math.hypot(x, height - y),
      Math.hypot(width - x, height - y),
    ) + extraRadius
  );
}

function getEllipseCoverRadii(x: number, y: number, extraRadius: number) {
  if (typeof window === "undefined") {
    return { radiusX: extraRadius, radiusY: extraRadius };
  }

  const { width, height } = getViewportSize();
  const requiredRadiusX = Math.max(
    Math.hypot(x, y / ELLIPSE_Y_RATIO),
    Math.hypot(width - x, y / ELLIPSE_Y_RATIO),
    Math.hypot(x, (height - y) / ELLIPSE_Y_RATIO),
    Math.hypot(width - x, (height - y) / ELLIPSE_Y_RATIO),
  );
  const radiusX = requiredRadiusX + extraRadius / ELLIPSE_Y_RATIO;

  return {
    radiusX,
    radiusY: radiusX * ELLIPSE_Y_RATIO,
  };
}

function isPolygonShape(shape: ThemeTransitionShape): shape is PolygonTransitionShape {
  return shape === "star" || shape === "diamond" || shape === "hexagon";
}

function getPolygonPoints(shape: PolygonTransitionShape) {
  if (shape === "diamond") {
    return [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
  }

  if (shape === "hexagon") {
    return Array.from({ length: 6 }, (_, index) => {
      const angle = -Math.PI / 2 + index * (Math.PI / 3);
      return [Math.cos(angle), Math.sin(angle)];
    });
  }

  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI / 5);
    const radius = index % 2 === 0 ? 1 : STAR_INNER_RADIUS_RATIO;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
}

function getPolygonCoverRadii(
  shape: PolygonTransitionShape,
  radius: number,
) {
  const coverRadius = radius * POLYGON_COVER_MULTIPLIERS[shape];

  return {
    radiusX: coverRadius,
    radiusY: coverRadius,
  };
}

function getClipPathValue({
  x,
  y,
  radiusX,
  radiusY,
  shape,
}: {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  shape: ThemeTransitionShape;
}) {
  if (shape === "ellipse") {
    return `ellipse(${radiusX}px ${radiusY}px at ${x}px ${y}px)`;
  }

  if (isPolygonShape(shape)) {
    const points = getPolygonPoints(shape)
      .map(([pointX, pointY]) => {
        return `${x + pointX * radiusX}px ${y + pointY * radiusY}px`;
      })
      .join(", ");

    return `polygon(${points})`;
  }

  return `circle(${radiusX}px at ${x}px ${y}px)`;
}

function waitForNextPaint() {
  if (
    typeof window === "undefined" ||
    document.visibilityState === "hidden"
  ) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function getClipPathKeyframes({
  x,
  y,
  radiusX,
  radiusY,
  shape,
  layer,
}: {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  shape: ThemeTransitionShape;
  layer: ThemeTransitionLayer;
}) {
  const zero = getClipPathValue({ x, y, radiusX: 0, radiusY: 0, shape });
  const full = getClipPathValue({ x, y, radiusX, radiusY, shape });

  return layer === "old"
    ? [{ clipPath: full }, { clipPath: zero }]
    : [{ clipPath: zero }, { clipPath: full }];
}

function getTransitionLayer(
  direction: ThemeTransitionDirection,
  isDark: boolean,
): ThemeTransitionLayer {
  if (direction === "enter") return "new";
  if (direction === "exit") return "old";

  return isDark ? "old" : "new";
}

function syncDocumentThemeClass(
  targetDark: boolean | undefined,
  themeClassName: string | null,
) {
  if (typeof document === "undefined" || typeof targetDark !== "boolean") {
    return;
  }

  if (!themeClassName) return;

  document.documentElement.classList.toggle(themeClassName, targetDark);
}

function commitThemeUpdate({
  updateTheme,
  targetDark,
  themeClassName = "dark",
}: Pick<
  ThemeTransitionOptions,
  "targetDark" | "themeClassName" | "updateTheme"
>) {
  syncDocumentThemeClass(targetDark, themeClassName);
  updateTheme();
}

function createViewTransitionStyle(layer: ThemeTransitionLayer) {
  const style = document.createElement("style");
  style.dataset.qiuyeThemeTransition = "true";
  style.textContent = `
::view-transition-old(root),
::view-transition-group(root),
::view-transition-image-pair(root),
::view-transition-new(root) {
  animation: none !important;
  mix-blend-mode: normal !important;
  backface-visibility: hidden;
  will-change: clip-path;
}

::view-transition-old(root) {
  z-index: ${layer === "old" ? 2 : 1};
}

::view-transition-new(root) {
  z-index: ${layer === "new" ? 2 : 1};
}
`;
  document.head.appendChild(style);
  return style;
}

/**
 * runThemeViewTransition — 执行一次主题 View Transition
 *
 * 封装浏览器 View Transition API 的主题切换流程：
 * - 在 update 阶段同步提交主题 DOM 变化
 * - 可提前同步 `html.dark`，避免 next-themes 等异步 effect 在尾帧补切主题
 * - 根据按钮、鼠标事件或坐标计算揭幕中心点
 * - 浅色→深色时扩散 `::view-transition-new(root)`
 * - 深色→浅色时收束 `::view-transition-old(root)`，露出下方新主题
 * - 自动尊重 `prefers-reduced-motion` 并在不支持 API 时降级
 *
 * @example
 * ```tsx
 * await runThemeViewTransition({
 *   isDark,
 *   targetDark: !isDark,
 *   origin: buttonRef,
 *   updateTheme: () => setTheme(isDark ? "light" : "dark"),
 * });
 * ```
 */
export async function runThemeViewTransition({
  updateTheme,
  origin = "center",
  duration = DEFAULT_TRANSITION_DURATION,
  easing = DEFAULT_TRANSITION_EASING,
  timing = "spring",
  shape = "circle",
  direction = "auto",
  isDark = false,
  targetDark,
  themeClassName = "dark",
  extraRadius = 48,
  respectReducedMotion = true,
  onFallback,
  onFinish,
}: ThemeTransitionOptions) {
  void timing;

  const shouldFallback =
    !isViewTransitionSupported() ||
    (respectReducedMotion && shouldReduceMotion());

  if (shouldFallback) {
    commitThemeUpdate({ updateTheme, targetDark, themeClassName });
    onFallback?.();
    onFinish?.();
    return;
  }

  const { x, y } = getPointFromOrigin(origin);
  const circleRadius = getCircleCoverRadius(x, y, extraRadius);
  const { radiusX, radiusY } =
    shape === "ellipse"
      ? getEllipseCoverRadii(x, y, extraRadius)
      : isPolygonShape(shape)
        ? getPolygonCoverRadii(shape, circleRadius)
      : { radiusX: circleRadius, radiusY: circleRadius };
  const layer = getTransitionLayer(direction, isDark);
  const keyframes = getClipPathKeyframes({
    x,
    y,
    radiusX,
    radiusY,
    shape,
    layer,
  });
  const pseudoElement =
    layer === "old"
      ? "::view-transition-old(root)"
      : "::view-transition-new(root)";
  const documentWithTransition = document as DocumentWithViewTransition;
  const style = createViewTransitionStyle(layer);
  let clipPathAnimation: Animation | undefined;

  const transition = documentWithTransition.startViewTransition?.(() => {
    flushSync(() => {
      commitThemeUpdate({ updateTheme, targetDark, themeClassName });
    });
  });

  if (!transition) {
    style.remove();
    commitThemeUpdate({ updateTheme, targetDark, themeClassName });
    onFallback?.();
    onFinish?.();
    return;
  }

  try {
    await transition.ready;

    clipPathAnimation = document.documentElement.animate(keyframes, {
      duration,
      easing,
      fill: "both",
      pseudoElement,
    });

    await Promise.allSettled([
      transition.finished,
      clipPathAnimation.finished,
    ]);
  } catch {
    await transition.updateCallbackDone.catch(() => undefined);
  } finally {
    await waitForNextPaint();
    clipPathAnimation?.cancel();
    style.remove();
    onFinish?.();
  }
}

/**
 * useThemeTransition — 在任意交互控件里复用主题揭幕动画
 *
 * 返回一个稳定的 `run` 函数，可传入鼠标事件、按钮 ref 或坐标作为动画原点。
 *
 * @example
 * ```tsx
 * const { run, isTransitioning } = useThemeTransition({
 *   isDark,
 *   updateTheme: () => setTheme(isDark ? "light" : "dark"),
 * });
 *
 * <button onClick={(event) => run(event)}>切换主题</button>
 * ```
 */
export function useThemeTransition({
  updateTheme,
  origin,
  onFinish,
  duration = DEFAULT_TRANSITION_DURATION,
  easing = DEFAULT_TRANSITION_EASING,
  timing = "spring",
  shape = "circle",
  direction = "auto",
  isDark = false,
  targetDark,
  themeClassName = "dark",
  extraRadius = 48,
  respectReducedMotion = true,
  onFallback,
}: UseThemeTransitionOptions) {
  const [isTransitioning, setIsTransitioning] = React.useState(false);

  const run = React.useCallback(
    async (nextOrigin?: ThemeTransitionOrigin | null) => {
      setIsTransitioning(true);

      await runThemeViewTransition({
        updateTheme,
        origin: nextOrigin ?? origin,
        duration,
        easing,
        timing,
        shape,
        direction,
        isDark,
        targetDark: targetDark ?? !isDark,
        themeClassName,
        extraRadius,
        respectReducedMotion,
        onFallback,
        onFinish: () => {
          setIsTransitioning(false);
          onFinish?.();
        },
      });
    },
    [
      direction,
      duration,
      easing,
      extraRadius,
      isDark,
      onFallback,
      onFinish,
      origin,
      respectReducedMotion,
      shape,
      timing,
      targetDark,
      themeClassName,
      updateTheme,
    ],
  );

  return { run, isTransitioning } as const;
}

/**
 * ThemeTransitionToggle — View Transition 深浅模式切换按钮
 *
 * 提供可直接安装使用的主题按钮：
 * - 用浏览器 View Transition API 做全屏圆形、椭圆或多边形揭幕
 * - 复用 DualStateToggle，默认带图标旋转与点击缩放反馈
 * - 默认从按钮中心扩散，支持鼠标点击位置、坐标或居中降级
 * - 暴露 `runThemeViewTransition` 与 `useThemeTransition` 复用能力
 * - 不支持 API 或用户开启减少动态效果时自动切换为无动画更新
 *
 * @example
 * ```tsx
 * const { resolvedTheme, setTheme } = useTheme();
 * const isDark = resolvedTheme === "dark";
 *
 * <ThemeTransitionToggle
 *   isDark={isDark}
 *   onToggle={(nextDark) => setTheme(nextDark ? "dark" : "light")}
 * />
 * ```
 */
export const ThemeTransitionToggle = React.forwardRef<
  HTMLButtonElement,
  ThemeTransitionToggleProps
>(function ThemeTransitionToggle(
  {
    isDark,
    onToggle,
    lightIcon = <SunIcon />,
    darkIcon = <MoonIcon />,
    lightLabel = "切换到深色主题",
    darkLabel = "切换到浅色主题",
    duration = DEFAULT_TRANSITION_DURATION,
    easing = DEFAULT_TRANSITION_EASING,
    timing = "spring",
    shape = "circle",
    direction = "auto",
    targetDark,
    themeClassName = "dark",
    extraRadius = 48,
    respectReducedMotion = true,
    onFallback,
    onFinish,
    onToggleStart,
    variant = "outline",
    size = "icon",
    buttonShape = "square",
    effect = "rotate",
    transitionDuration = 0.35,
    disabled,
    className,
    onClick,
    type = "button",
    ...buttonProps
  },
  forwardedRef,
) {
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const [isTransitioning, setIsTransitioning] = React.useState(false);

  const setRefs = React.useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node;

      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  const handleClick = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;

      const nextDark = !isDark;
      onToggleStart?.(nextDark);
      setIsTransitioning(true);

      await runThemeViewTransition({
        isDark,
        duration,
        easing,
        timing,
        shape,
        direction,
        targetDark: targetDark ?? nextDark,
        themeClassName,
        extraRadius,
        respectReducedMotion,
        onFallback,
        updateTheme: () => onToggle(nextDark),
        origin: buttonRef,
        onFinish: () => {
          setIsTransitioning(false);
          onFinish?.();
        },
      });
    },
    [
      direction,
      duration,
      easing,
      extraRadius,
      isDark,
      onClick,
      onFallback,
      onFinish,
      onToggle,
      onToggleStart,
      respectReducedMotion,
      shape,
      timing,
      targetDark,
      themeClassName,
    ],
  );

  return (
    <DualStateToggle
      ref={setRefs}
      active={isDark}
      onToggle={() => undefined}
      activeIcon={darkIcon}
      inactiveIcon={lightIcon}
      activeLabel={darkLabel}
      inactiveLabel={lightLabel}
      variant={variant}
      size={size}
      shape={buttonShape}
      effect={effect}
      transitionDuration={transitionDuration}
      type={type}
      disabled={disabled || isTransitioning}
      aria-label={isDark ? darkLabel : lightLabel}
      aria-pressed={isDark}
      className={cn(
        "overflow-hidden",
        className,
      )}
      {...buttonProps}
      onClick={handleClick}
    />
  );
});
