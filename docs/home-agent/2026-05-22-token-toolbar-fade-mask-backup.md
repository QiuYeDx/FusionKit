# HomeAgent Token 工具条渐变遮罩备份

备份时间：2026-05-22

用途：备份一次已回滚的 HomeAgent 底部输入框上方 Token / 会话操作工具条遮罩方案。该方案在工具条底层加入自上向下逐渐加深的透明模糊渐变，用于提高浅色与深色主题下的文本可读性。

## 样式常量

位置：`src/pages/HomeAgent/index.tsx`，可放在 `SCROLL_BOTTOM_THRESHOLD` 之后。

```tsx
const TOKEN_TOOLBAR_FADE_STYLE: React.CSSProperties = {
  background:
    "linear-gradient(180deg, oklch(from var(--background) l c h / 0) 0%, oklch(from var(--background) l c h / 0.72) 62%, oklch(from var(--background) l c h / 0.82) 100%)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  maskImage: "linear-gradient(to bottom, transparent 0%, black 38%, black 100%)",
  WebkitMaskImage:
    "linear-gradient(to bottom, transparent 0%, black 38%, black 100%)",
};
```

## JSX 片段

位置：`inputCapsule` 内，`TokenStatsBar` 与新会话等按钮所在的那一行。

```tsx
<motion.div
  layout="position"
  initial={{ opacity: 0, y: 6 }}
  animate={{ opacity: 1, y: 0 }}
  exit={{ opacity: 0, y: 6 }}
  transition={{
    type: "spring",
    bounce: 0,
    duration: 0.8,
    delay: 1.2,
  }}
  className="relative isolate max-w-2xl mx-auto mb-2 pointer-events-auto flex items-end justify-between gap-2"
>
  <div
    aria-hidden="true"
    className="pointer-events-none absolute -left-3 -right-3 -top-1 -bottom-2 z-0 rounded-none"
    style={TOKEN_TOOLBAR_FADE_STYLE}
  />
  <TokenStatsBar className="relative z-10 max-w-none mx-0 mb-0" />
  <div className="relative z-10 flex items-center gap-1 ml-auto translate-y-1">
    {/* buttons */}
  </div>
</motion.div>
```

## 注意点

- 遮罩必须保持 `pointer-events-none` 和 `aria-hidden="true"`，避免拦截按钮操作或干扰无障碍语义。
- 使用 `var(--background)` 派生颜色，可跟随明暗主题变化。
- 真实按钮与 Token 文本需要保留 `relative z-10`，保证显示在遮罩之上。
