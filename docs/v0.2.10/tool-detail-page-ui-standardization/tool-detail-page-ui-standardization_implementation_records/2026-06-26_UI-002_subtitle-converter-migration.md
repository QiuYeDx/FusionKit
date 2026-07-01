# 工作包 UI-002：字幕转换页迁移与文件入口组合件

## 基本信息

- 日期：2026-06-26
- 状态：已完成
- 对应执行计划工作包：`UI-002`

## 本次实现内容

- 迁移“字幕格式转换”详情页到共享紧凑 UI 语法：
  - 页面外壳使用 `ToolDetailLayout`；
  - 左侧配置面板使用 `ToolConfigPanel`、`ToolField`、`ToolConfigDivider`；
  - 输出目录选择继续使用紧凑版 `ToolOutputPathPicker`；
  - 上传入口使用 `ToolFileDropZone`，成为该组件的第二个消费者；
  - 参数摘要行使用 `ToolSummaryLine`；
  - 任务队列外壳使用 `ToolPanel`。
- 删除转换页内手写的核心 Card 壳、拖拽事件处理和隐藏 file input 结构，改由共享上传组件负责：
  - 保留 `.lrc/.srt/.vtt` 的 `accept`；
  - 保留 `multiple` 批量选择；
  - 保留选择同一文件后仍可再次触发的 input reset 行为，由 `ToolFileDropZone` 内部统一处理。
- 保留转换页业务差异：
  - 目标格式、默认时长、去媒体后缀、输出模式、冲突策略；
  - 任务行、任务详情展开、错误弹窗、编辑任务弹窗；
  - 打开位置、删除、清空、全部开始、失败重试等 handler。

## 修改文件

- `src/pages/Tools/Subtitle/SubtitleConverter/index.tsx`
- `docs/tool-detail-page-ui-standardization-execution-plan.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_compact-baseline.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_UI-002_subtitle-converter-migration.md`

## 接口或数据结构变化

- `SubtitleConverter/index.tsx` 的本地 `handleFileUpload` 从接收 `React.ChangeEvent<HTMLInputElement>` 改为接收 `FileList`，以匹配 `ToolFileDropZone` 的 `onFiles` API。
- 未修改 subtitle store、任务状态类型、service、IPC、i18n 文案或持久化数据结构。
- 未新增通用业务任务行抽象；任务行仍留在业务页面，符合“只抽视觉壳，不抽业务状态”的设计约束。

## 视觉核对

- 页面：字幕格式转换
- 窗口尺寸：
  - 默认 Electron 窗口：已核对；
  - 786×540：已通过 Playwright Electron `BrowserWindow.setSize(786, 540)` 补充核对；
  - 宽屏 1440×900：已通过 Playwright Electron `BrowserWindow.setSize(1440, 900)` 补充核对。
- 主题：
  - Dark：已核对，页面与字幕 AI 翻译页一致使用 320px 左栏、紧凑配置面板、横向上传区、摘要行和任务队列面板；
  - Light：已核对，边框、面板层级、按钮和空状态可读性正常。
- 语言：zh
- 页面状态：无任务、输出模式为自定义、输出目录已配置。
- Tour：
  - 保留 `cvt-tour-config`、`cvt-tour-format`、`cvt-tour-output`、`cvt-tour-upload`、`cvt-tour-queue`、`cvt-tour-start`。
- 结果：默认窗口、最小窗口和宽屏 Dark/Light 下转换页均已对齐共享视觉语法；补充矩阵见 `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_UI-002_visual-matrix-closure.md`。

## 验证结果

执行命令：

```text
./node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
./node_modules/.bin/vite build
git diff --check
```

结果：

- `./node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，四语言 key 数一致。
- `./node_modules/.bin/vite build`：通过；存在既有 `useModelStore` dynamic/static import warning 和 chunk size warning。
- `git diff --check`：通过。

## 前端进程清理

- 启动过的服务：
  - Vite：`./node_modules/.bin/vite --host 127.0.0.1 --port 5173`，PID `9227`；
  - Electron：`VITE_DEV_SERVER_URL=http://127.0.0.1:5173 ./node_modules/.bin/electron . --no-sandbox`，PID `9262`。
- 结束方式：
  - 执行 `kill 9262 9227`；
  - Vite session 正常退出。
- 结束后进程确认：
  - `ps -axo pid,ppid,command | rg '/Users/qiuyedx/Documents/Github/FusionKit/(node_modules/.bin/vite|node_modules/.bin/../vite|node_modules/.pnpm/electron|node_modules/.bin/electron)|Electron \\. --no-sandbox|vite --host 127.0.0.1|127.0.0.1 --port 5173' | rg -v 'rg ' || true`
  - 输出为空，确认本轮启动的前端服务和 Electron 进程已结束。

## 未完成事项

- `UI-002` 的视觉和静态验证已完成。
- 本轮没有做真实文件转换链路回归；后续 `QA-*` 工作包建议用 1 个 `.srt` 或 `.lrc` 样例覆盖上传队列与转换链路。

## 下一步建议

1. 下一批代码工作建议认领 `UI-003`，迁移“字幕语言提取”页，用第三个字幕页验证共享抽象是否稳定。
2. 后续 `QA-*` 工作包补真实文件转换链路回归。
