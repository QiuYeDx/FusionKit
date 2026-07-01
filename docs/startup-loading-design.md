# FusionKit 启动加载动画设计

## 目标

FusionKit 的启动加载页采用「反色圆形揭幕」方案：深色模式下视口初始为纯黑底色，中心显示大号百分比；随着加载进度增加，一个白色圆形从视口正中心向外扩张，直到 `100%` 时覆盖整个可见区域。随后白场中心开出一个从半径 `0` 开始扩大的圆形裁剪孔，让背后的应用内容从中心逐步显露。浅色模式下使用同一套动效，但黑白关系整体反转。

这套动效刻意避免复杂装饰，强调一个清晰的启动叙事：黑场等待、中心计数、反色扩张、完整揭幕。

## 视觉规则

- 深色模式保持现有效果：背景为 `#000`，揭幕圆与退场遮罩为 `#fff`。
- 浅色模式整体反相：背景为 `#fff`，揭幕圆与退场遮罩为 `#000`。
- 启动页在 preload 阶段读取 `fusionkit-theme` 的 Zustand persist JSON；主题为 `system` 时跟随 `prefers-color-scheme`。
- 进度数字位于视口中心，字号使用 `clamp(76px, 15vw, 168px)`，保证窗口尺寸变化时仍然足够醒目。
- 数字层使用 `mix-blend-mode: difference`，因此文字会随当前黑白底色自动反转。
- 百分比下方保留小号 `FusionKit` 字标和一条极简进度线，二者同样随背景反色。

## 时序策略

启动页运行在 `electron/preload/index.ts`，先于 React 渲染：

1. `domReady()` 后挂载加载层，并初始化进度为 `00%`。
2. 在 React 尚未 ready 前，使用合成进度平滑推进，最高停在 `92%`，避免显示虚假的完成状态。
3. `src/main.tsx` 渲染完成后发送 `postMessage({ payload: "removeLoading" }, "*")`。
4. 即使 renderer 很快 ready，也会等待最短计数时长结束，再将目标进度切到 `100%`，避免加载动画一闪而过。
5. 白色圆形覆盖视口后，`100%` 白场会短暂停留，给完成状态一个稳定帧。
6. 完成停留后，先切入不透明纯白退场遮罩，百分比文字在纯白底上上移淡出，避免底层应用参与 `mix-blend-mode` 造成白场发灰。
7. 文字退场后，全屏白色退场遮罩在中心打开一个半径从 `0` 逐帧变大的透明圆孔，让应用内容从中心裁剪显露。
8. 仍保留 `4999ms` 兜底超时，避免异常情况下加载层永久停留。

默认时序底线：

| 阶段 | 默认时长 | `prefers-reduced-motion` |
| --- | ---: | ---: |
| 计数与白圆扩张 | ≥ 1200ms | ≥ 180ms |
| 收束到 `100%` | 420ms | 120ms |
| `100%` 白场停留 | ≥ 180ms | ≥ 80ms |
| 文字/图层切换 | 500ms / 180ms | 120ms / 80ms |
| 中心圆孔揭幕 | 920ms | 220ms |

## 关键实现

启动加载页在 Electron preload 中运行，无法使用 `motion/react` 组件，但可以使用 Motion 的 vanilla `animate` API。除入场关键帧外，动态阶段统一使用 Motion spring：

```ts
const springTransition = (durationMs: number) => ({
  type: "spring" as const,
  duration: durationMs / 1000,
  bounce: 0,
})
```

当前由 Motion spring 驱动的阶段包括：合成进度到 `92%`、ready 后收束到 `100%`、百分比文字上移淡出、白色图层切换，以及中心圆孔揭幕。`100%` 后文字淡出期间，退场遮罩会先进入 solid 模式，保持整屏纯白；圆孔揭幕开始前再恢复 `mask-image`。

注意：preload 在 Electron 沙箱中运行，不能把 `motion` 保留为运行时 external dependency，否则会出现 `Unable to load preload script` / `module not found: motion`。`vite.config.ts` 中 preload 的 `rollupOptions.external` 会单独排除 `motion`，让 Motion 被打进 preload bundle。

圆形尺寸由 JS 按当前视口实时计算：

```ts
const radiusToFarthestCorner = Math.sqrt(width * width + height * height) / 2
maxRevealSize = Math.ceil(radiusToFarthestCorner * 2)
```

然后通过 CSS 变量驱动：

```css
.app-loading-wrap {
  --fk-reveal-size: 0px;
  --fk-progress-ratio: 0%;
}

.fk-reveal-circle {
  width: var(--fk-reveal-size);
  height: var(--fk-reveal-size);
}
```

窗口尺寸变化时会重新计算最大覆盖直径，确保任意视口比例下 `100%` 都能完整覆盖。

退场裁剪孔也使用同一个视口几何基准：

```ts
maxExitRadius = Math.ceil(radiusToFarthestCorner + 32)
```

退场遮罩是一个全屏白色层，通过 `mask-image` 挖出中心透明圆孔；Motion 的数值动画更新 `--fk-exit-radius` 和 `--fk-exit-edge`，避免依赖自定义 CSS 属性动画。

快速启动时不会立刻进入 `100%`。合成进度按最短计数时长以 spring 推进到 `92%`；收到 ready 信号且底线结束后，再用 spring 收束到 `100%`。

## 可访问性

- 加载层使用 `role="progressbar"`。
- 通过 `aria-valuenow` 与 `aria-valuetext` 同步当前百分比。
- 遵循 `prefers-reduced-motion: reduce`：减少入场和退出动画时长，并在 ready 前不主动推进视觉进度。

## 验证方式

常规检查：

```bash
pnpm exec tsc --noEmit
pnpm exec vite build
```

视觉检查：

```bash
pnpm dev -- --host 127.0.0.1
```

观察 Electron 应用启动阶段：黑底中央百分比应随白色中心圆同步增长，达到 `100%` 后白色圆覆盖全屏并过渡到应用内容。

退场验收重点：`100%` 后不应静止后硬切；文字淡出时白场不应变灰；背后的首页内容应从视口中心的圆形裁剪孔中逐渐显露，直到圆孔覆盖整个视口。
