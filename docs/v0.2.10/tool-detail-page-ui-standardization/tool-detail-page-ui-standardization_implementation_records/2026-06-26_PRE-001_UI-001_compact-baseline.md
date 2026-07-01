# 工作包 PRE-001 / UI-001：视觉基准冻结与共享紧凑骨架首迁

## 基本信息

- 日期：2026-06-26
- 状态：已完成
- 对应执行计划工作包：`PRE-001`、`UI-001`

## 本次实现内容

- 在改代码前通过 Electron 打开“字幕 AI 翻译”详情页，记录当前基准：
  - 页面容器为 `max-w-7xl` 居中布局；
  - 左侧为约 320px 配置栏，配置 Card 使用 `p-0 gap-0`；
  - 配置栏头为 11px uppercase 标题；
  - 右侧为上传区、参数摘要行、任务队列 Card、空状态；
  - 任务队列 header 使用 13.5px 标题、任务数 Badge 和紧凑 `size="sm"` 操作按钮。
- 新增共享紧凑 UI 组件：
  - `ToolConfigPanel`
  - `ToolPanel`
  - `ToolConfigDivider`
  - `ToolFileDropZone`
  - `ToolSummaryLine`
- 调整既有共享组件：
  - `ToolDetailLayout` 收敛为 320px 双栏、sticky aside、main `gap-3`；
  - `ToolField` 收敛为 11px muted 标签，并支持 `id` 以保留 Tour target；
  - `InfoHint`、`ToolOutputPathPicker` 调整为更紧凑尺寸；
  - `_shared/ui/index.ts` 导出新增组件，同时保留旧组件供长文本页后续迁移。
- 迁移 `SubtitleTranslator/index.tsx`：
  - 页面外壳改用 `ToolDetailLayout`；
  - 左侧配置卡改用 `ToolConfigPanel` / `ToolField` / `ToolConfigDivider`；
  - 上传区改用 `ToolFileDropZone`；
  - 参数摘要行改用 `ToolSummaryLine`；
  - 任务队列外壳改用 `ToolPanel`；
  - 任务行、任务状态、handler、store、IPC、RecoveryDialog、编辑弹窗、统计条业务展示保持原实现。

## 修改文件

- `src/pages/Tools/_shared/ui/ToolDetailLayout.tsx`
- `src/pages/Tools/_shared/ui/ToolField.tsx`
- `src/pages/Tools/_shared/ui/InfoHint.tsx`
- `src/pages/Tools/_shared/ui/ToolOutputPathPicker.tsx`
- `src/pages/Tools/_shared/ui/index.ts`
- `src/pages/Tools/_shared/ui/ToolConfigPanel.tsx`
- `src/pages/Tools/_shared/ui/ToolPanel.tsx`
- `src/pages/Tools/_shared/ui/ToolConfigDivider.tsx`
- `src/pages/Tools/_shared/ui/ToolFileDropZone.tsx`
- `src/pages/Tools/_shared/ui/ToolSummaryLine.tsx`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `docs/tool-detail-page-ui-standardization-execution-plan.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_compact-baseline.md`

## 接口或数据结构变化

- 新增的共享 UI 组件只接收 ReactNode / slot / DOM event，不读取 Zustand store，不调用 IPC，不内置业务文案。
- `ToolDetailLayout` 新增 `asideClassName`、`mainClassName`，默认双栏从 340px 改为 320px。
- `ToolField` 新增可选 `id`，用于保留 Tour target。
- 字幕翻译业务数据结构、任务状态、IPC、store、service 均未修改。

## 视觉核对

- 页面：字幕 AI 翻译
- 窗口尺寸：
  - 默认 Electron 窗口：已核对；
  - 786×540：已通过 Playwright Electron `BrowserWindow.setSize(786, 540)` 补充核对；
  - 宽屏 1440×900：已通过 Playwright Electron `BrowserWindow.setSize(1440, 900)` 补充核对。
- 主题：
  - Dark：迁移前后已核对，左栏、上传区、摘要行、任务队列空态和按钮位置无明显回归；
  - Light：迁移前后已核对，面板层级、边框和按钮可读性正常；
  - 核对后已切回初始 Dark。
- 语言：zh
- 页面状态：无任务、已有模型配置、输出目录已配置。
- Tour：
  - 本地未自动弹出 Tour；
  - 代码层保留 `tour-config-panel`、`tour-lang-pair`、`tour-output-mode`、`tour-slice-mode`、`tour-output-path`、`tour-schedule`、`tour-upload-zone`、`tour-task-queue`、`tour-start-all-btn`。
- 结果：默认窗口、最小窗口和宽屏下基准视觉保持一致；补充矩阵见 `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_UI-002_visual-matrix-closure.md`。

## 验证结果

执行命令：

```text
./node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
./node_modules/.bin/vite build
./node_modules/.bin/electron-builder --publish never
./node_modules/.bin/electron-builder --mac zip --publish never
git diff --check
```

结果：

- `./node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，四语言 key 数一致。
- `./node_modules/.bin/vite build`：通过；存在既有 chunk size / dynamic import warning。
- `./node_modules/.bin/electron-builder --publish never`：失败于 DMG 生成阶段，错误为 `hdiutil process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`；zip 已生成 blockmap，判断为本机 DMG 打包环境问题。
- `./node_modules/.bin/electron-builder --mac zip --publish never`：通过。
- `git diff --check`：通过。

补充：

- `pnpm dev --host 127.0.0.1 --port 5173` 未启动成功；当前全局 pnpm 认为 lockfile 不兼容并尝试 install，随后因非 TTY 拒绝清理 modules。已改用 `./node_modules/.bin/vite --host 127.0.0.1 --port 5173` 启动开发服务。

## 前端进程清理

- 启动过的服务：
  - Vite：`./node_modules/.bin/vite --host 127.0.0.1 --port 5173`，PID `46571`；
  - Electron：`VITE_DEV_SERVER_URL=http://127.0.0.1:5173 ./node_modules/.bin/electron . --no-sandbox`，PID `46634`。
- 结束方式：
  - 执行 `kill 46634 46571`；
  - Vite session 正常退出。
- 结束后进程确认：
  - `ps -axo pid,ppid,command | rg '/Users/qiuyedx/Documents/Github/FusionKit/(node_modules/.bin/vite|node_modules/.pnpm/electron|node_modules/.bin/electron)|Electron \\. --no-sandbox|vite --host 127.0.0.1|127.0.0.1 --port 5173' | rg -v 'rg ' || true`
  - 输出为空，确认本轮启动的前端服务和 Electron 进程已结束。

## 未完成事项

- `ToolSection`、`ToolStat`、`ToolActionBar` 暂时保留，因为长文本翻译页仍在使用；后续 `TEXT-*` / `CLEAN-001` 再删除。
- 已补齐 786×540 与 1440×900 视觉矩阵，`PRE-001` / `UI-001` 可标记为已完成。

## 下一步建议

1. 下一批代码工作建议认领 `UI-003`，迁移字幕语言提取页。
2. 后续 `TEXT-*` / `CLEAN-001` 再删除旧长文本视觉组件。
