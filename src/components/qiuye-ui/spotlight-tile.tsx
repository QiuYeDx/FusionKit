"use client";

import * as React from "react";
import { Slot } from "radix-ui";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { SmoothCorners } from "@/components/qiuye-ui/smooth-corners";

const RISE_EASE = [0.23, 1, 0.32, 1] as const;
const RISE_STAGGER = 0.05;

const MotionSlot = motion.create(Slot.Root);

type ToneStyle = React.CSSProperties & { "--qy-spotlight-tone"?: string };

/* ------------------------------------------------------------------ */
/* 样式                                                                 */
/* ------------------------------------------------------------------ */

// 布局与排版用 Tailwind 类，用户的 className 可以覆盖；
// 这里只放伪元素、遮罩、悬停联动与减少动态效果等无法用类名表达的部分。
// React 19 <style href precedence>：提升到 <head> 并按 href 去重，Vite 等环境同样可用。
const SPOTLIGHT_TILE_CSS = `
.qy-spotlight-tile {
  transition:
    border-color 220ms ease,
    box-shadow 220ms ease,
    translate 220ms cubic-bezier(0.23, 1, 0.32, 1);
}

/* 跟随指针的光：沿边框的一圈（::before）和内部的柔光（::after）。
   坐标只写在这一层上，指针移动时不会让整张卡片的子树重算样式。 */
.qy-spotlight-tile-light {
  --qy-spot-x: 50%;
  --qy-spot-y: 0%;
  position: absolute;
  inset: -1px;
  z-index: -1;
  border-radius: inherit;
  corner-shape: inherit;
  pointer-events: none;
  opacity: 0;
  transition: opacity 260ms ease;
}
.qy-spotlight-tile-light::before,
.qy-spotlight-tile-light::after {
  content: "";
  position: absolute;
  border-radius: inherit;
  corner-shape: inherit;
}
.qy-spotlight-tile-light::before {
  inset: 0;
  padding: 1px;
  background: radial-gradient(
    240px circle at var(--qy-spot-x) var(--qy-spot-y),
    color-mix(in oklab, var(--qy-spotlight-tone) 85%, transparent),
    transparent 70%
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask:
    linear-gradient(#000 0 0) content-box exclude,
    linear-gradient(#000 0 0);
}
.qy-spotlight-tile-light::after {
  inset: 1px;
  background: radial-gradient(
    380px circle at var(--qy-spot-x) var(--qy-spot-y),
    color-mix(in oklab, var(--qy-spotlight-tone) 10%, transparent),
    transparent 65%
  );
}

/* 角落里大而淡的水印图标，裁切在卡片内。 */
.qy-spotlight-tile-clip {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  border-radius: inherit;
  corner-shape: inherit;
  pointer-events: none;
}
.qy-spotlight-tile-watermark {
  position: absolute;
  right: -14px;
  bottom: -22px;
  width: 128px;
  height: 128px;
  color: var(--qy-spotlight-tone);
  opacity: 0.06;
  rotate: -12deg;
  transition:
    rotate 520ms cubic-bezier(0.23, 1, 0.32, 1),
    translate 520ms cubic-bezier(0.23, 1, 0.32, 1),
    scale 520ms cubic-bezier(0.23, 1, 0.32, 1),
    opacity 320ms ease;
}
.qy-spotlight-tile-watermark > svg {
  width: 100%;
  height: 100%;
  stroke-width: 1.4;
}
:where(.dark) .qy-spotlight-tile-watermark {
  opacity: 0.08;
}

/* 带色调渐变的图标底板 */
.qy-spotlight-tile-icon {
  border-color: color-mix(in oklab, var(--qy-spotlight-tone) 26%, transparent);
  background: linear-gradient(
    145deg,
    color-mix(in oklab, var(--qy-spotlight-tone) 20%, transparent),
    color-mix(in oklab, var(--qy-spotlight-tone) 8%, transparent)
  );
  color: var(--qy-spotlight-tone);
  transition:
    rotate 320ms cubic-bezier(0.34, 1.4, 0.64, 1),
    scale 320ms cubic-bezier(0.34, 1.4, 0.64, 1);
}
.qy-spotlight-tile-arrow {
  transition:
    translate 220ms cubic-bezier(0.23, 1, 0.32, 1),
    color 220ms ease;
}

/* 标题链接的点击区域铺满整张卡片；actions 等内层控件浮在它上面。 */
.qy-spotlight-tile-link::after {
  content: "";
  position: absolute;
  inset: -1px;
  z-index: 2;
}

@media (hover: hover) {
  .qy-spotlight-tile:hover .qy-spotlight-tile-light {
    opacity: 1;
  }
  .qy-spotlight-tile:hover {
    box-shadow: 0 18px 36px -26px
      color-mix(in oklab, var(--qy-spotlight-tone) 60%, transparent);
  }
  .qy-spotlight-tile:is([data-interactive], :has([data-slot="spotlight-tile-link"])):hover {
    translate: 0 -2px;
  }
  .qy-spotlight-tile:hover .qy-spotlight-tile-watermark {
    opacity: 0.11;
    rotate: -4deg;
    translate: -6px -6px;
    scale: 1.04;
  }
  :where(.dark) .qy-spotlight-tile:hover .qy-spotlight-tile-watermark {
    opacity: 0.14;
  }
  .qy-spotlight-tile:hover .qy-spotlight-tile-icon {
    rotate: -6deg;
    scale: 1.05;
  }
  .qy-spotlight-tile:hover .qy-spotlight-tile-arrow {
    color: var(--qy-spotlight-tone);
    translate: 2px -2px;
  }
}

/* 键盘聚焦：色调描边，边框光停在顶部中央。 */
.qy-spotlight-tile:is(:focus-visible, :has([data-slot="spotlight-tile-link"]:focus-visible)) {
  outline: 2px solid var(--qy-spotlight-tone);
  outline-offset: 3px;
}
.qy-spotlight-tile:is(:focus-visible, :has([data-slot="spotlight-tile-link"]:focus-visible))
  .qy-spotlight-tile-light {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .qy-spotlight-tile,
  .qy-spotlight-tile-icon,
  .qy-spotlight-tile-arrow,
  .qy-spotlight-tile-watermark {
    transition: opacity 260ms ease, color 220ms ease, box-shadow 220ms ease;
  }
  .qy-spotlight-tile:is([data-interactive], :has([data-slot="spotlight-tile-link"])):hover,
  .qy-spotlight-tile:hover .qy-spotlight-tile-icon,
  .qy-spotlight-tile:hover .qy-spotlight-tile-arrow,
  .qy-spotlight-tile:hover .qy-spotlight-tile-watermark {
    translate: none;
    scale: none;
  }
  .qy-spotlight-tile:hover .qy-spotlight-tile-icon {
    rotate: none;
  }
  .qy-spotlight-tile:hover .qy-spotlight-tile-watermark {
    rotate: -12deg;
  }
}
`;

function SpotlightTileStyles() {
  return (
    <style href="qiuye-spotlight-tile" precedence="default">
      {SPOTLIGHT_TILE_CSS}
    </style>
  );
}

/* ------------------------------------------------------------------ */
/* SpotlightTileLink                                                    */
/* ------------------------------------------------------------------ */

/** SpotlightTileLink 组件的属性 */
export interface SpotlightTileLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /**
   * 是否把链接行为应用到唯一子元素，用于路由库的链接组件（如 `next/link`、
   * `react-router` 的 `Link`）。
   * @default false
   */
  asChild?: boolean;
}

/**
 * SpotlightTileLink — 铺满整张卡片的标题链接
 *
 * 放在 SpotlightTile 的 `title` 中使用：
 * - 链接文字仍是标题，读屏器读到的链接名称就是标题
 * - 点击区域通过伪元素铺满整张卡片，actions 中的按钮仍可单独点击
 * - 键盘聚焦时整张卡片显示色调描边
 *
 * 只传 `href` 时 SpotlightTile 会自动用它包裹标题；需要路由链接时手动使用。
 *
 * @example
 * ```tsx
 * <SpotlightTile
 *   title={
 *     <SpotlightTileLink asChild>
 *       <Link href="/tools/translate">字幕翻译</Link>
 *     </SpotlightTileLink>
 *   }
 * />
 * ```
 */
export const SpotlightTileLink = React.forwardRef<
  HTMLAnchorElement,
  SpotlightTileLinkProps
>(({ asChild = false, className, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : "a";
  return (
    <Comp
      ref={ref}
      data-slot="spotlight-tile-link"
      className={cn("qy-spotlight-tile-link outline-none", className)}
      {...props}
    />
  );
});

SpotlightTileLink.displayName = "SpotlightTileLink";

/* ------------------------------------------------------------------ */
/* SpotlightTile                                                        */
/* ------------------------------------------------------------------ */

/** SpotlightTile 组件的属性 */
export interface SpotlightTileProps
  extends Omit<
    React.HTMLAttributes<HTMLDivElement>,
    | "title"
    | "onDrag"
    | "onDragStart"
    | "onDragEnd"
    | "onAnimationStart"
    | "onAnimationEnd"
    | "onAnimationIteration"
  > {
  /**
   * 卡片的色调，可以是任意 CSS 颜色（`#7c3aed`、`oklch(...)`、`var(--chart-1)` 等）。
   * 用于边框光、内部柔光、图标底板、水印、悬停阴影与聚焦描边。
   * @default "var(--primary)"
   */
  tone?: string;
  /** 左上角的图标，建议传入 24×24 的线性图标（如 lucide-react 图标） */
  icon?: React.ReactNode;
  /**
   * 右下角的水印图标
   * - `true`：复用 `icon`
   * - 传入节点：使用该节点作为水印
   * - `false`：不显示
   * @default true
   */
  watermark?: boolean | React.ReactNode;
  /** 图标右侧的小标签，如 `"Beta"`、`"New"` */
  badge?: React.ReactNode;
  /** 标题；传入 `href` 时会被包裹为铺满卡片的链接 */
  title?: React.ReactNode;
  /**
   * 标题使用的标签
   * @default "h3"
   */
  titleAs?: "h2" | "h3" | "h4" | "p";
  /** 标题下方的描述，默认最多显示两行 */
  description?: React.ReactNode;
  /** 底部的特性标签 */
  chips?: React.ReactNode[];
  /** 底部右侧的操作区，其中的按钮浮在卡片链接之上，可以单独点击 */
  actions?: React.ReactNode;
  /** 卡片链接地址；设置后标题成为链接，点击区域铺满整张卡片 */
  href?: string;
  /** 传给标题链接的其他属性，如 `target`、`rel` */
  linkProps?: Omit<SpotlightTileLinkProps, "href" | "asChild" | "children">;
  /**
   * 是否在右上角显示箭头，悬停时朝右上轻推
   * @default 设置了 `href` 或 `asChild` 时为 `true`
   */
  arrow?: boolean;
  /**
   * 是否把卡片样式应用到唯一子元素（如 `<a>`、`<button>`），让整张卡片成为该元素。
   * 子元素自身的子节点显示在描述下方；此时不要在 `actions` 中放交互元素。
   * @default false
   */
  asChild?: boolean;
  /**
   * 是否在进入视口时上浮淡入；系统开启减少动态效果时只做不位移的短淡入
   * @default true
   */
  appear?: boolean;
  /**
   * 在网格中的序号，用于错开上浮淡入的时间（每张 50ms）
   * @default 0
   */
  index?: number;
  /**
   * 平滑圆角半径，单位 px
   * @default 20
   */
  radius?: number;
  /**
   * 平滑圆角强度，范围 0..1
   * @default 0.72
   */
  smoothing?: number;
}

/**
 * SpotlightTile — 跟随指针取光的聚光卡片
 *
 * 适合工具入口、功能目录、导航宫格等场景：
 * - 1px 边框沿指针位置亮起一圈色调光，内部铺一层柔光
 * - 角落里大而淡的水印图标，悬停时漂移并转正
 * - 带色调渐变的图标底板悬停时轻微倾斜，右上角箭头朝右上轻推
 * - 可作为链接卡片：标题链接铺满整张卡片，`actions` 中的按钮仍可点击
 * - 进入视口时按序号错开上浮淡入，平滑圆角、聚焦描边与减少动态效果
 *
 * @example
 * ```tsx
 * <SpotlightTile
 *   tone="oklch(0.62 0.19 255)"
 *   icon={<LanguagesIcon />}
 *   badge="Beta"
 *   title="字幕翻译"
 *   description="批量翻译 SRT / ASS 字幕，保留时间轴与样式。"
 *   chips={["SRT", "ASS", "VTT"]}
 *   href="/tools/translate"
 *   actions={<Button size="sm" variant="outline">快速开始</Button>}
 * />
 * ```
 *
 * @example
 * ```tsx
 * // 整张卡片就是一个链接
 * <SpotlightTile asChild tone="#10b981" icon={<BookIcon />} title="阅读文档">
 *   <a href="/docs" />
 * </SpotlightTile>
 * ```
 */
export const SpotlightTile = React.forwardRef<HTMLDivElement, SpotlightTileProps>(
  (
    {
      tone = "var(--primary)",
      icon,
      watermark = true,
      badge,
      title,
      titleAs: TitleTag = "h3",
      description,
      chips,
      actions,
      href,
      linkProps,
      arrow,
      asChild = false,
      appear = true,
      index = 0,
      radius = 20,
      smoothing = 0.72,
      className,
      style,
      children,
      onPointerMove,
      ...props
    },
    ref,
  ) => {
    const reduceMotion = useReducedMotion() ?? false;
    const lightRef = React.useRef<HTMLSpanElement>(null);
    const frameRef = React.useRef(0);
    const spotRef = React.useRef({ x: 0, y: 0 });

    React.useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      onPointerMove?.(event);
      if (event.pointerType === "touch") return;
      const bounds = event.currentTarget.getBoundingClientRect();
      spotRef.current = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      };
      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        const light = lightRef.current;
        if (!light) return;
        light.style.setProperty("--qy-spot-x", `${spotRef.current.x}px`);
        light.style.setProperty("--qy-spot-y", `${spotRef.current.y}px`);
      });
    };

    const watermarkNode = watermark === true ? icon : watermark || null;
    const showArrow = arrow ?? (Boolean(href) || asChild);
    const hasHead = Boolean(icon || badge || showArrow);
    const hasFoot = Boolean((chips && chips.length > 0) || actions);

    const titleNode =
      title != null && href ? (
        <SpotlightTileLink href={href} {...linkProps}>
          {title}
        </SpotlightTileLink>
      ) : (
        title
      );

    const Root = asChild ? MotionSlot : motion.div;

    return (
      <SmoothCorners asChild radius={radius} smoothing={smoothing}>
        <Root
          ref={ref}
          data-slot="spotlight-tile"
          data-interactive={href || asChild ? "" : undefined}
          className={cn(
            "qy-spotlight-tile group/spotlight-tile relative isolate flex min-w-0 flex-col rounded-[20px] border bg-card p-[18px] text-card-foreground",
            className,
          )}
          style={{ ...style, "--qy-spotlight-tone": tone } as ToneStyle}
          // initial 只在挂载时读取，而 useReducedMotion 在水合后才有值，
          // 所以起点保持不变，减少动态效果时只把过渡改为不位移的短淡入。
          initial={appear ? { opacity: 0, y: 14 } : false}
          whileInView={appear ? { opacity: 1, y: 0 } : undefined}
          viewport={{ once: true, amount: 0.2 }}
          transition={
            reduceMotion
              ? { duration: 0.2, y: { duration: 0 } }
              : {
                  duration: 0.6,
                  delay: index * RISE_STAGGER,
                  ease: RISE_EASE,
                }
          }
          onPointerMove={handlePointerMove}
          {...props}
        >
          <SpotlightTileStyles />
          {watermarkNode ? (
            <span aria-hidden className="qy-spotlight-tile-clip">
              <span className="qy-spotlight-tile-watermark">{watermarkNode}</span>
            </span>
          ) : null}
          <span ref={lightRef} aria-hidden className="qy-spotlight-tile-light" />

          {hasHead ? (
            <div data-slot="spotlight-tile-head" className="flex items-start gap-2">
              {icon ? (
                <SmoothCorners
                  radius={13}
                  smoothing={0.72}
                  aria-hidden
                  className="qy-spotlight-tile-icon inline-flex size-10 shrink-0 items-center justify-center rounded-[13px] border [&_svg]:size-5"
                >
                  {icon}
                </SmoothCorners>
              ) : null}
              {badge ? (
                <span
                  data-slot="spotlight-tile-badge"
                  className="rounded-full border bg-muted/60 px-2 py-px text-[10.5px] leading-4 font-semibold text-muted-foreground"
                >
                  {badge}
                </span>
              ) : null}
              {showArrow ? (
                <ArrowUpRightIcon
                  aria-hidden
                  className="qy-spotlight-tile-arrow ml-auto size-4 shrink-0 text-muted-foreground"
                />
              ) : null}
            </div>
          ) : null}

          {titleNode != null ? (
            <TitleTag
              data-slot="spotlight-tile-title"
              className={cn(
                "text-[15px] leading-[22px] font-semibold tracking-[-0.01em]",
                hasHead && "mt-4",
              )}
            >
              {titleNode}
            </TitleTag>
          ) : null}
          {description != null ? (
            <p
              data-slot="spotlight-tile-description"
              className="mt-1 line-clamp-2 text-[12.5px] leading-5 text-muted-foreground"
            >
              {description}
            </p>
          ) : null}

          {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : children}

          {hasFoot ? (
            <div
              data-slot="spotlight-tile-foot"
              className="mt-auto flex items-end justify-between gap-2.5 pt-4"
            >
              {chips && chips.length > 0 ? (
                <ul className="flex min-w-0 flex-wrap gap-[5px]">
                  {chips.map((chip, chipIndex) => (
                    <li
                      key={chipIndex}
                      className="rounded-full bg-muted/75 px-2 py-0.5 text-[10.5px] leading-4 whitespace-nowrap text-foreground/70"
                    >
                      {chip}
                    </li>
                  ))}
                </ul>
              ) : (
                <span />
              )}
              {actions ? (
                <div
                  data-slot="spotlight-tile-actions"
                  className="relative z-[3] flex shrink-0 items-center gap-1.5"
                >
                  {actions}
                </div>
              ) : null}
            </div>
          ) : null}
        </Root>
      </SmoothCorners>
    );
  },
);

SpotlightTile.displayName = "SpotlightTile";
