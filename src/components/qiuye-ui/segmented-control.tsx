"use client";

import * as React from "react";
import {
  LayoutGroup,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";

import { cn } from "@/lib/utils";

/** SegmentedControl 的尺寸 */
export type SegmentedControlSize = "sm" | "md";

/** SegmentedControl 的视觉风格 */
export type SegmentedControlVariant = "contained" | "floating";

/** 单个分段选项的配置 */
export interface SegmentedControlItem {
  /** 选项唯一值 */
  value: string;
  /** 选项显示内容 */
  label: React.ReactNode;
  /** 标签前的可选图标 */
  icon?: React.ReactNode;
  /**
   * 是否禁用该选项
   * @default false
   */
  disabled?: boolean;
  /** 当 label 不是纯文本时使用的无障碍标签 */
  ariaLabel?: string;
  /** 用于定位单个选项的测试标识 */
  testId?: string;
}

/** SegmentedControl 组件的属性 */
export interface SegmentedControlProps
  extends Omit<
    React.HTMLAttributes<HTMLDivElement>,
    "defaultValue" | "onChange"
  > {
  /** 分段选项列表，value 应保持唯一 */
  items: SegmentedControlItem[];
  /** 当前选中值（受控模式） */
  value?: string;
  /** 非受控模式的默认选中值，未传时选中第一个可用项 */
  defaultValue?: string;
  /** 选中值变化回调 */
  onValueChange?: (value: string) => void;
  /** 指针完成选择后触发，用于衔接聚焦等指针专属行为 */
  onPointerValueChange?: (value: string) => void;
  /**
   * 控件尺寸
   * - `"md"`：卡片或局部内容切换
   * - `"sm"`：单个配置项切换
   * @default "md"
   */
  size?: SegmentedControlSize;
  /**
   * 选项排列方向
   * @default "horizontal"
   */
  orientation?: "horizontal" | "vertical";
  /**
   * 视觉风格
   * - `"contained"`：选中滑块内嵌于灰色轨道
   * - `"floating"`：选中滑块比灰色轨道略大，呈现悬浮效果
   * @default "floating"
   */
  variant?: SegmentedControlVariant;
  /**
   * 是否撑满父容器宽度
   * @default false
   */
  fullWidth?: boolean;
  /**
   * 是否禁用整个控件
   * @default false
   */
  disabled?: boolean;
  /** 用于原生表单提交的字段名 */
  name?: string;
  /** 选中态滑块的额外 className */
  indicatorClassName?: string;
  /** 每个选项按钮的额外 className */
  itemClassName?: string;
  /**
   * 选中态滑块的 Motion 过渡配置
   * @default { type: "spring", duration: 0.38, bounce: 0.18 }
   */
  indicatorTransition?: Transition;
}

const sizeStyles: Record<
  SegmentedControlSize,
  {
    root: string;
    containedItem: string;
    floatingItem: string;
    content: string;
  }
> = {
  sm: {
    root: "h-7 min-h-7 shrink-0",
    containedItem: "h-6 min-w-10 px-1.5 text-[11px]",
    floatingItem: "h-7 min-w-10 px-1.5 text-[11px]",
    content: "gap-1 [&_svg]:size-3.5",
  },
  md: {
    root: "h-9 min-h-9 shrink-0",
    containedItem: "h-8 min-w-20 px-4 text-sm",
    floatingItem: "h-9 min-w-20 px-4 text-sm",
    content: "gap-2 [&_svg]:size-4",
  },
};

const defaultIndicatorTransition: Transition = {
  type: "spring",
  duration: 0.38,
  bounce: 0.18,
};

function getFirstEnabledValue(items: SegmentedControlItem[]) {
  return items.find((item) => !item.disabled)?.value ?? "";
}

/**
 * SegmentedControl — 带弹性滑块过渡的分段单选控件
 *
 * 适合在少量互斥选项之间切换：
 * - 使用 Motion `layoutId` 和 spring 实现选中胶囊的弹性滑动
 * - 支持受控与非受控状态，以及 `sm` / `md` 两档尺寸
 * - 提供内嵌与悬浮两种视觉风格，切换时文字尺寸和字重保持稳定
 * - 使用 radiogroup 语义，支持方向键、Home、End 键盘导航
 * - 支持禁用项、整组禁用和原生表单字段提交
 *
 * @example
 * ```tsx
 * const [value, setValue] = useState("chat");
 *
 * <SegmentedControl
 *   aria-label="工作模式"
 *   value={value}
 *   onValueChange={setValue}
 *   items={[
 *     { value: "chat", label: "Chat" },
 *     { value: "work", label: "Work" },
 *   ]}
 * />
 * ```
 */
export const SegmentedControl = React.forwardRef<
  HTMLDivElement,
  SegmentedControlProps
>(function SegmentedControl(
  {
    items,
    value: controlledValue,
    defaultValue,
    onValueChange,
    onPointerValueChange,
    size = "md",
    orientation = "horizontal",
    variant = "floating",
    fullWidth = false,
    disabled = false,
    name,
    indicatorClassName,
    itemClassName,
    indicatorTransition = defaultIndicatorTransition,
    className,
    style,
    ...props
  },
  ref,
) {
  const instanceId = React.useId();
  const prefersReducedMotion = useReducedMotion();
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = React.useState(
    () => defaultValue ?? getFirstEnabledValue(items),
  );
  const buttonRefs = React.useRef(new Map<string, HTMLButtonElement>());

  const selectedValue = isControlled ? controlledValue : internalValue;
  const selectedItem = items.find(
    (item) => item.value === selectedValue && !item.disabled,
  );
  const resolvedValue = selectedItem?.value ?? getFirstEnabledValue(items);
  const enabledItems = items.filter((item) => !item.disabled);
  const styles = sizeStyles[size];
  const transition = prefersReducedMotion
    ? ({ duration: 0 } satisfies Transition)
    : indicatorTransition;

  const selectValue = React.useCallback(
    (nextValue: string) => {
      if (disabled || nextValue === selectedValue) return;

      const nextItem = items.find((item) => item.value === nextValue);
      if (!nextItem || nextItem.disabled) return;

      if (!isControlled) {
        setInternalValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [disabled, isControlled, items, onValueChange, selectedValue],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, currentValue: string) => {
      if (disabled || enabledItems.length === 0) return;

      const currentIndex = enabledItems.findIndex(
        (item) => item.value === currentValue,
      );
      let nextIndex: number | null = null;

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (currentIndex + 1) % enabledItems.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex =
          (currentIndex - 1 + enabledItems.length) % enabledItems.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = enabledItems.length - 1;
      }

      if (nextIndex === null) return;

      event.preventDefault();
      const nextValue = enabledItems[nextIndex]?.value;
      if (!nextValue) return;

      selectValue(nextValue);
      buttonRefs.current.get(nextValue)?.focus();
    },
    [disabled, enabledItems, selectValue],
  );

  return (
    <LayoutGroup id={instanceId}>
      <div
        {...props}
        ref={ref}
        role="radiogroup"
        data-slot="segmented-control"
        data-size={size}
        data-variant={variant}
        data-orientation={orientation}
        aria-orientation={orientation}
        aria-disabled={disabled || undefined}
        className={cn(
          "relative isolate grid max-w-full text-foreground",
          orientation === "horizontal" ? "rounded-full" : "rounded-lg",
          variant === "contained"
            ? "overflow-hidden bg-muted/70 p-0.5"
            : "overflow-visible",
          orientation === "horizontal" && styles.root,
          fullWidth ? "w-full" : "inline-grid",
          disabled && "opacity-60",
          className,
        )}
        style={{
          gridTemplateColumns:
            orientation === "horizontal"
              ? `repeat(${Math.max(items.length, 1)}, minmax(0, 1fr))`
              : "minmax(0, 1fr)",
          ...style,
        }}
      >
        {variant === "floating" && (
          <span
            data-slot="segmented-control-track"
            className={cn(
              "pointer-events-none absolute z-0 bg-muted/70",
              orientation === "horizontal"
                ? "inset-x-0 inset-y-0.5 rounded-full"
                : "inset-0 rounded-lg",
            )}
          />
        )}

        {items.map((item) => {
          const active = item.value === resolvedValue;
          const itemDisabled = disabled || item.disabled;

          return (
            <button
              key={item.value}
              ref={(node) => {
                if (node) buttonRefs.current.set(item.value, node);
                else buttonRefs.current.delete(item.value);
              }}
              type="button"
              role="radio"
              data-slot="segmented-control-item"
              data-state={active ? "active" : "inactive"}
              data-value={item.value}
              data-testid={item.testId}
              aria-checked={active}
              aria-label={item.ariaLabel}
              disabled={itemDisabled}
              tabIndex={active ? 0 : -1}
              className={cn(
                "relative flex min-w-0 cursor-pointer items-center justify-center font-medium outline-none transition-colors",
                orientation === "horizontal" ? "rounded-full" : "rounded-md",
                "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
                active
                  ? "z-0 text-foreground"
                  : "z-[1] text-muted-foreground",
                itemDisabled && "cursor-not-allowed opacity-45",
                variant === "contained"
                  ? styles.containedItem
                  : styles.floatingItem,
                itemClassName,
              )}
              onClick={() => selectValue(item.value)}
              onKeyDown={(event) => handleKeyDown(event, item.value)}
              onPointerUp={() => onPointerValueChange?.(item.value)}
            >
              {active && (
                <motion.span
                  data-slot="segmented-control-indicator"
                  layoutId={`${instanceId}-segmented-control-indicator`}
                  layoutDependency={resolvedValue}
                  initial={false}
                  transition={transition}
                  className={cn(
                    "pointer-events-none absolute inset-0 border bg-background dark:border-white/10 dark:bg-input/75",
                    orientation === "horizontal" ? "rounded-full" : "rounded-md",
                    variant === "contained"
                      ? "border-border/80 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_6px_18px_-12px_rgba(0,0,0,0.34)]"
                      : "border-border/70 shadow-[0_1px_3px_rgba(0,0,0,0.05),0_6px_16px_-10px_rgba(0,0,0,0.14)] dark:bg-input",
                    indicatorClassName,
                  )}
                />
              )}

              <span
                className={cn(
                  "relative z-10 flex min-w-0 items-center justify-center",
                  styles.content,
                )}
              >
                {item.icon && (
                  <span className="flex shrink-0 items-center justify-center">
                    {item.icon}
                  </span>
                )}
                <span data-slot="segmented-control-label" className="truncate">
                  {item.label}
                </span>
              </span>
            </button>
          );
        })}

        {name && <input type="hidden" name={name} value={resolvedValue} disabled={disabled} />}
      </div>
    </LayoutGroup>
  );
});
