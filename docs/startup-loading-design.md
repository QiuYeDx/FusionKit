# FusionKit 启动加载动画设计

## 目标

FusionKit 的启动加载页采用「反色圆形揭幕」方案：视口初始为纯黑底色，中心显示大号百分比；随着加载进度增加，一个白色圆形从视口正中心向外扩张，直到 `100%` 时覆盖整个可见区域，再通过白场退场过渡到应用真实内容。

这套动效刻意避免复杂装饰，强调一个清晰的启动叙事：黑场等待、中心计数、反色扩张、完整揭幕。

## 视觉规则

- 背景固定为 `#000`，揭幕圆固定为 `#fff`。
- 进度数字位于视口中心，字号使用 `clamp(76px, 15vw, 168px)`，保证窗口尺寸变化时仍然足够醒目。
- 数字层使用 `mix-blend-mode: difference`，因此文字在黑底上显示为白色，在白色圆形上自动反转为黑色。
- 百分比下方保留小号 `FusionKit` 字标和一条极简进度线，二者同样随背景反色。

## 时序策略

启动页运行在 `electron/preload/index.ts`，先于 React 渲染：

1. `domReady()` 后挂载加载层，并初始化进度为 `00%`。
2. 在 React 尚未 ready 前，使用合成进度平滑推进，最高停在 `92%`，避免显示虚假的完成状态。
3. `src/main.tsx` 渲染完成后发送 `postMessage({ payload: "removeLoading" }, "*")`。
4. preload 收到 ready 信号后，将目标进度切到 `100%`，白色圆形扩张到覆盖视口最远角。
5. 圆形完全覆盖后，百分比文字上移淡出；白色揭幕圆轻微放大、模糊并淡出，让应用内容渐进露出。
6. 仍保留 `4999ms` 兜底超时，避免异常情况下加载层永久停留。

## 关键实现

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

退场验收重点：`100%` 后不应静止后硬切，数字和白场应有可见的淡出/露出过程。
