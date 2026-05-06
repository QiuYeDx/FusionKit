"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

type ButtonProps = React.ComponentProps<typeof Button>;

/** 内置过渡效果预设名 */
type ToggleEffectPreset = "fade" | "rotate" | "slide-up" | "slide-down" | "scale";

type MotionValues = Record<string, string | number>;

/** 自定义过渡效果配置 */
interface ToggleEffectConfig {
  /** 进入起始 / 退出结束 的动画属性 */
  initial: MotionValues;
  /** 静止态属性（通常是各属性的"归零"值） */
  animate: MotionValues;
  /** 退出结束态属性 */
  exit: MotionValues;
}

/** 过渡效果：预设名 | 自定义配置 */
type ToggleEffect = ToggleEffectPreset | ToggleEffectConfig;

/* -------------------------------------------------------------------------- */
/*                              Effect Presets                                */
/* -------------------------------------------------------------------------- */

const EFFECT_PRESETS: Record<ToggleEffectPreset, ToggleEffectConfig> = {
  /** 仅 opacity + blur（基础效果） */
  fade: {
    initial: {},
    animate: {},
    exit: {},
  },
  /** opacity + blur + 旋转 */
  rotate: {
    initial: { rotate: -90 },
    animate: { rotate: 0 },
    exit: { rotate: 90 },
  },
  /** opacity + blur + 向上滑入/滑出 */
  "slide-up": {
    initial: { y: 6 },
    animate: { y: 0 },
    exit: { y: -6 },
  },
  /** opacity + blur + 向下滑入/滑出 */
  "slide-down": {
    initial: { y: -6 },
    animate: { y: 0 },
    exit: { y: 6 },
  },
  /** opacity + blur + 缩放（0.75 → 1 → 0.75） */
  scale: {
    initial: { scale: 0.75 },
    animate: { scale: 1 },
    exit: { scale: 0.75 },
  },
};

/* -------------------------------------------------------------------------- */
/*                                   Props                                    */
/* -------------------------------------------------------------------------- */

export interface DualStateToggleProps
  extends Omit<ButtonProps, "onClick" | "onToggle" | "children"> {
  /** 是否处于激活状态 */
  active: boolean;
  /** 状态切换回调 */
  onToggle: (active: boolean) => void;
  /** 激活状态下显示的图标 */
  activeIcon: React.ReactNode;
  /** 非激活状态下显示的图标 */
  inactiveIcon: React.ReactNode;
  /** 激活状态的无障碍标签 */
  activeLabel?: string;
  /** 非激活状态的无障碍标签 */
  inactiveLabel?: string;
  /**
   * 图标切换时的模糊程度
   * @default "2px"
   */
  blurAmount?: string;
  /**
   * 按钮形状快捷设置
   * - `"square"` — 默认圆角矩形（shadcn/ui Button 原始圆角）
   * - `"circle"` — 纯圆形按钮（`rounded-full`）
   *
   * 也可以忽略此属性，通过 `className` 自定义圆角
   * @default "square"
   */
  shape?: "square" | "circle";
  /**
   * 图标切换过渡效果
   *
   * **预设值：**
   * - `"fade"` — 仅 opacity + blur（默认）
   * - `"rotate"` — 附加旋转（-90° → 0° → 90°）
   * - `"slide-up"` — 附加向上滑动
   * - `"slide-down"` — 附加向下滑动
   * - `"scale"` — 附加缩放（0.75 → 1 → 0.75）
   *
   * **自定义配置：** 传入 `{ initial, animate, exit }` 对象，
   * 会与基础的 opacity + blur 动画合并。
   *
   * @default "fade"
   *
   * @example
   * ```tsx
   * // 使用预设
   * <DualStateToggle effect="rotate" ... />
   *
   * // 自定义效果
   * <DualStateToggle
   *   effect={{
   *     initial: { rotate: -180, scale: 0.6 },
   *     animate: { rotate: 0, scale: 1 },
   *     exit:    { rotate: 180, scale: 0.6 },
   *   }}
   *   ...
   * />
   * ```
   */
  effect?: ToggleEffect;
  /**
   * 图标切换动画时长（秒）
   * @default 0.25
   */
  transitionDuration?: number;
}

/* -------------------------------------------------------------------------- */
/*                                 Component                                  */
/* -------------------------------------------------------------------------- */

/**
 * DualStateToggle — 标准双状态切换按钮
 *
 * 基于 shadcn/ui Button，内置点击缩放 + 图标切换动画。
 * 默认 `variant="default"` + `size="icon"`，可通过 props 覆盖。
 *
 * ## 按钮尺寸 & 图标尺寸
 *
 * 按钮尺寸遵循 shadcn/ui Button 规范：
 * - `size="icon"`（默认）→ 36px 方形，icon 自动 size-4（16px）
 * - `size="icon-xs"` → 24px 方形，icon 自动 size-3（12px）
 * - `size="icon-sm"` → 32px 方形，icon 自动 size-4（16px）
 * - `size="icon-lg"` → 40px 方形，icon 自动 size-4（16px）
 *
 * Icon 尺寸由 Button 通过 `[&_svg:not([class*='size-'])]:size-4` 自动控制，
 * **不需要**在 icon 上手动添加 `h-* w-*`。若需自定义尺寸，使用 `size-*`
 * 类名（如 `size-5`），Button 会自动跳过自动尺寸控制。
 *
 * @example
 * ```tsx
 * // 基本用法 — 默认 fade 效果（icon 自动 16px）
 * <DualStateToggle
 *   active={isOpen}
 *   onToggle={setIsOpen}
 *   activeIcon={<XIcon />}
 *   inactiveIcon={<MenuIcon />}
 *   activeLabel="关闭"
 *   inactiveLabel="打开"
 * />
 *
 * // 旋转效果 + 圆形按钮
 * <DualStateToggle
 *   active={isOpen}
 *   onToggle={setIsOpen}
 *   activeIcon={<XIcon />}
 *   inactiveIcon={<MenuIcon />}
 *   effect="rotate"
 *   shape="circle"
 * />
 *
 * // 自定义 icon 尺寸 — 使用 size-* 前缀
 * <DualStateToggle
 *   active={isOpen}
 *   onToggle={setIsOpen}
 *   activeIcon={<XIcon className="size-5" />}
 *   inactiveIcon={<MenuIcon className="size-5" />}
 *   size="icon-lg"
 * />
 *
 * // 自定义效果 + 透传 Button props
 * <DualStateToggle
 *   active={isMuted}
 *   onToggle={setIsMuted}
 *   activeIcon={<VolumeOffIcon />}
 *   inactiveIcon={<Volume2Icon />}
 *   variant="outline"
 *   blurAmount="4px"
 *   effect={{
 *     initial: { rotate: -180, scale: 0.6 },
 *     animate: { rotate: 0, scale: 1 },
 *     exit:    { rotate: 180, scale: 0.6 },
 *   }}
 * />
 * ```
 */
export function DualStateToggle({
  active,
  onToggle,
  activeIcon,
  inactiveIcon,
  activeLabel,
  inactiveLabel,
  blurAmount = "2px",
  shape = "square",
  effect = "fade",
  transitionDuration = 0.25,
  // shadcn/ui Button props — 提供最常用的默认值，外部可覆盖
  variant = "default",
  size = "icon",
  className,
  ...buttonProps
}: DualStateToggleProps) {
  // 解析过渡效果（预设 or 自定义）
  const resolvedEffect: ToggleEffectConfig =
    typeof effect === "string" ? EFFECT_PRESETS[effect] : effect;

  // 基础动画：opacity + blur（始终存在）
  const blurFilter = `blur(${blurAmount})`;
  const baseInitial = { opacity: 0, filter: blurFilter };
  const baseAnimate = { opacity: 1, filter: "blur(0px)" };
  const baseExit = { opacity: 0, filter: blurFilter };

  // 合并：基础 + 过渡效果
  const motionInitial = { ...baseInitial, ...resolvedEffect.initial };
  const motionAnimate = { ...baseAnimate, ...resolvedEffect.animate };
  const motionExit = { ...baseExit, ...resolvedEffect.exit };

  return (
    <Button
      variant={variant}
      size={size}
      className={cn(
        "relative transition-transform duration-150 active:scale-[0.97] cursor-pointer",
        shape === "circle" && "rounded-full",
        className
      )}
      onClick={() => onToggle(!active)}
      {...buttonProps}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {active ? (
          <motion.span
            key="dual-toggle-active"
            initial={motionInitial}
            animate={motionAnimate}
            exit={motionExit}
            transition={{ duration: transitionDuration }}
            className="flex items-center justify-center"
          >
            {activeIcon}
          </motion.span>
        ) : (
          <motion.span
            key="dual-toggle-inactive"
            initial={motionInitial}
            animate={motionAnimate}
            exit={motionExit}
            transition={{ duration: transitionDuration }}
            className="flex items-center justify-center"
          >
            {inactiveIcon}
          </motion.span>
        )}
      </AnimatePresence>

      {(activeLabel || inactiveLabel) && (
        <span className="sr-only">
          {active ? activeLabel : inactiveLabel}
        </span>
      )}
    </Button>
  );
}
