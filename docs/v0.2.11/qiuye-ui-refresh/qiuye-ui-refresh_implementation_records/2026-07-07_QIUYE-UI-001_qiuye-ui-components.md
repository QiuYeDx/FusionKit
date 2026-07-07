# 工作包 QIUYE-UI-001：接入 qiuye-ui 组件

## 基本信息

- 日期：2026-07-07
- 状态：已完成
- 对应执行计划工作包：`docs/v0.2.11/qiuye-ui-refresh/qiuye-ui-refresh-execution-plan.md` / `QIUYE-UI-001`

## 本次实现内容

- 补齐 `src/components/qiuye-ui/theme-transition-toggle.tsx`。
- 将底部导航右侧主题按钮替换为 `ThemeTransitionToggle`，保留 `h-9 w-9 rounded-full` 圆形按钮与日/月图标。
- 移除旧 `html-to-image` 截图遮罩主题切换链路，包括 `FadeMaskLayer`、`useFadeMaskLayerStore`、`html-to-image` 和不再使用的 `@reactuses/core`。
- 在 `ToolPanel`、`ToolConfigPanel`、`ToolStatBar`、`ToolFileDropZone` 和工具总览 `ToolCard` 使用 `SmoothCorners`。
- 修复 qiuye-ui smooth-corners 在当前 `moduleResolution: "Node"` 下无法解析 observer 子路径的问题，改为组件内 size-aware observer。
- 将 qiuye-ui code-block 中的 `<style jsx global>` 改为普通 React `<style>`，适配本项目 Vite React。

## 修改文件

- `src/components/qiuye-ui/theme-transition-toggle.tsx`
- `src/components/qiuye-ui/smooth-corners.tsx`
- `src/components/qiuye-ui/code-block/code-block-panel.tsx`
- `src/components/qiuye-ui/code-block/code-block-root.tsx`
- `src/pages/components/BottomNavigation.tsx`
- `src/App.tsx`
- `src/pages/Tools/index.tsx`
- `src/pages/Tools/_shared/ui/ToolPanel.tsx`
- `src/pages/Tools/_shared/ui/ToolConfigPanel.tsx`
- `src/pages/Tools/_shared/ui/ToolStatBar.tsx`
- `src/pages/Tools/_shared/ui/ToolFileDropZone.tsx`
- `package.json`
- `pnpm-lock.yaml`
- `docs/v0.2.11/qiuye-ui-refresh/`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`

## 接口或数据结构变化

- 无业务数据结构、Electron IPC 或 store 接口新增。
- 删除旧主题截图遮罩专用 store：`useFadeMaskLayerStore`。
- 依赖删除：`html-to-image`、`@reactuses/core`。

## 验证结果

执行命令：

```text
rg -n "html-to-image|useFadeMaskLayer|FadeMaskLayer|fade-mask-layer|@reactuses/core" src package.json pnpm-lock.yaml
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build
git diff --check
```

结果：

- 旧截图链路引用扫描无输出。
- TypeScript 检查通过。
- Vite production build 通过；保留既有 `useModelStore` dynamic/static import warning 和 chunk size warning。
- `git diff --check` 通过。
- 本次未启动 Vite dev server、Electron 或其他前端服务进程。

补充说明：

- 当前环境默认 `pnpm --version` 为 `11.7.0`，仓库 lockfile 为 `lockfileVersion: '6.0'`。本次未使用 pnpm 11 修改 lockfile。
- 为补齐缺失的 registry 文件，执行过 `corepack pnpm@8.7.0 dlx shadcn@latest add @qiuye-ui/theme-transition-toggle --yes`；生成器提示已有 `button.tsx`，未覆盖现有 shadcn 基础组件，只新增 `theme-transition-toggle.tsx`。

## 未完成事项

- 未做 Electron 视觉截图矩阵；建议人工在 Electron 中点击底部主题按钮，确认圆形揭幕动效和降级切换都符合预期。
- 建议人工浏览工具总览、字幕工具、文本工具和文件名翻译工具，复核 smooth corners 视觉细节。

## 下一步建议

- 在 Windows/macOS Electron 环境各进行一次主题切换手测。
- 若后续继续扩大 smooth corners 覆盖面，优先选择真实可交互 surface，避免改全局 radius token。
