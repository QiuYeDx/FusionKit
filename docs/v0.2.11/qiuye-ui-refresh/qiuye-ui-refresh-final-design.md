# QiuYe UI 组件接入 Final Design

> 日期：2026-07-07
> Feature Slug：`qiuye-ui-refresh`
> 版本：`v0.2.11`
> 状态：已用于 `QIUYE-UI-001` 实施

## 背景

v0.2.11 需要在前端接入最新 QiuYe UI 组件。用户已手动执行过：

```text
pnpm dlx shadcn@latest add @qiuye-ui/smooth-corners
pnpm dlx shadcn@latest add @qiuye-ui/theme-transition-toggle
```

本次实现基于本仓库已有 qiuye-ui registry 配置和 lockfile v6 约束推进，避免使用当前环境默认 pnpm 11 改写旧 lockfile。

## 目标

- 用 `ThemeTransitionToggle` 替换底部导航主题按钮的旧截图遮罩实现。
- 保持主题按钮原有圆形 `h-9 w-9 rounded-full` 形态和日/月图标识别。
- 在适合的高频前端 surface 使用 `SmoothCorners`，改善工具页卡片、拖拽区、统计条和工具总览卡片的边缘质感。
- 移除旧截图主题切换链路不再需要的 store、遮罩组件和依赖。

## 非目标

- 不重做全局设计系统 radius token。
- 不改设置页的三态主题配置入口。
- 不改变工具页业务流程、队列执行、翻译状态或 Electron IPC。
- 不引入新的前端服务常驻流程。

## 当前实现约束

- `components.json` 已配置 `@qiuye-ui` registry。
- `src/components/qiuye-ui/smooth-corners.tsx` 已存在，但需要兼容当前 `moduleResolution: "Node"`。
- 旧主题切换位于 `src/pages/components/BottomNavigation.tsx`，通过 `html-to-image` 截图并驱动 `FadeMaskLayer`。
- `pnpm-lock.yaml` 为 lockfileVersion 6，依赖清理需要保持 pnpm 8 时代格式。

## 最终设计

### 主题切换

- 底部导航右侧按钮改用 `ThemeTransitionToggle`。
- `buttonShape="circle"`，并保留 `className="h-9 w-9 rounded-full ..."`。
- `shape="circle"`，使用按钮中心触发 View Transition 圆形揭幕。
- 不支持 View Transition API 或用户开启减少动态效果时使用组件内降级逻辑，直接同步切换主题。
- 旧 `FadeMaskLayer` 和 `useFadeMaskLayerStore` 删除。

### Smooth Corners 使用位置

- 工具详情工作面板：`ToolPanel`。
- 工具详情配置面板：`ToolConfigPanel`。
- 工具详情统计条：`ToolStatBar`。
- 工具文件拖拽区：`ToolFileDropZone`。
- 工具总览卡片：`Tools/index.tsx` 的 `ToolCard`。

这些区域都是真实可交互或信息承载 surface，不额外嵌套装饰卡片。

### 兼容处理

- `smooth-corners` 的 size-aware 路径改为组件内 `ResizeObserver` 小实现，使用包公开导出的 `computeSmoothCorners`，避免直接导入当前 TS 配置解析不到的 `@qiuyedx/smooth-corners/observer` 子路径。
- qiuye code-block 中 Next 风格 `<style jsx global>` 改为普通 React `<style>`，适配本项目 Vite React 环境。

## 验证策略

- 引用扫描确认旧截图链路无残留。
- `node_modules/.bin/tsc --noEmit` 验证类型。
- `node_modules/.bin/vite build` 验证 renderer/main/preload build。
- `git diff --check` 验证补丁格式。
- 如启动 Vite/Electron 做视觉验证，结束前必须关闭进程并确认无遗留。
