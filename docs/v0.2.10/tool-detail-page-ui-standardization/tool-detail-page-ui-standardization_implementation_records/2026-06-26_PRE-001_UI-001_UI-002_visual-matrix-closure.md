# 工作包 PRE-001 / UI-001 / UI-002：最小与宽屏视觉矩阵闭环

## 基本信息

- 日期：2026-06-26
- 状态：已完成
- 对应执行计划工作包：`PRE-001`、`UI-001`、`UI-002`

## 本次实现内容

- 补齐此前缺失的 Electron 视觉矩阵：
  - 字幕 AI 翻译页；
  - 字幕格式转换页；
  - 786×540 最小窗口；
  - 1440×900 宽屏窗口；
  - Dark / Light。
- 绕过 macOS `osascript` / System Events 辅助访问限制，改用 Playwright Electron 调用 `BrowserWindow.setSize()` 设置窗口尺寸。
- 修正第一版截图脚本的问题：
  - 第一版截图在 `.app-loading-wrap` 仍处于 100% 退出态时就截图，结果只拍到了全局 loading，不可作为验收依据；
  - 最终版脚本显式等待 `.app-loading-wrap` 和 `#app-loading-style` 从 DOM 消失；
  - 等待目标路由、目标标题、配置区、上传区和任务区都存在且可见；
  - 写入主题后强制 reload，让 Zustand theme store 重新 hydrate，再进入目标路由；
  - 每个 case 截图前额外等待 1.25s，避开路由 motion 和主题过渡。
- 为 786×540 单列布局额外补拍工作区截图：
  - 首屏截图覆盖配置栏；
  - `*-workspace.png` 截图覆盖上传区与任务队列。

## 修改文件

- `docs/tool-detail-page-ui-standardization-execution-plan.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_compact-baseline.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_UI-002_subtitle-converter-migration.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_UI-002_visual-matrix-closure.md`

## 接口或数据结构变化

- 无产品代码变更。
- 无 store、IPC、service、i18n、持久化数据结构变化。
- 临时验证脚本位于 `/private/tmp/fusionkit-tool-detail-visual-matrix.mjs`，不进入仓库。

## 验证结果

执行命令：

```text
VSCODE_DEBUG=1 ./node_modules/.bin/vite
node /private/tmp/fusionkit-tool-detail-visual-matrix.mjs
git diff --check
```

结果：

- Vite 调试服务启动在 `http://127.0.0.1:7777/`，`VSCODE_DEBUG=1` 模式未自动拉起 Electron。
- Playwright Electron 成功启动应用并控制 `BrowserWindow` 尺寸。
- 8 个主矩阵 case 均满足：
  - `loading=false`
  - `pageOverflow=false`
  - `globalOverflow=false`
- `git diff --check`：通过。

矩阵指标：

| 页面 | 尺寸 | 主题 | viewport | 配置区 | 上传区 | 任务区 | 横向溢出 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 字幕 AI 翻译 | 786×540 | Dark | 786×540 | 722px | 722px | 722px | 无 |
| 字幕 AI 翻译 | 786×540 | Light | 786×540 | 722px | 722px | 722px | 无 |
| 字幕 AI 翻译 | 1440×900 | Dark | 1440×861 | 320px | 880px | 880px | 无 |
| 字幕 AI 翻译 | 1440×900 | Light | 1440×861 | 320px | 880px | 880px | 无 |
| 字幕格式转换 | 786×540 | Dark | 786×540 | 722px | 722px | 722px | 无 |
| 字幕格式转换 | 786×540 | Light | 786×540 | 722px | 722px | 722px | 无 |
| 字幕格式转换 | 1440×900 | Dark | 1440×861 | 320px | 880px | 880px | 无 |
| 字幕格式转换 | 1440×900 | Light | 1440×861 | 320px | 880px | 880px | 无 |

截图产物：

```text
/private/tmp/fusionkit-tool-detail-visual-matrix/translator-min-dark.png
/private/tmp/fusionkit-tool-detail-visual-matrix/translator-min-dark-workspace.png
/private/tmp/fusionkit-tool-detail-visual-matrix/translator-min-light.png
/private/tmp/fusionkit-tool-detail-visual-matrix/translator-min-light-workspace.png
/private/tmp/fusionkit-tool-detail-visual-matrix/translator-wide-dark.png
/private/tmp/fusionkit-tool-detail-visual-matrix/translator-wide-light.png
/private/tmp/fusionkit-tool-detail-visual-matrix/converter-min-dark.png
/private/tmp/fusionkit-tool-detail-visual-matrix/converter-min-dark-workspace.png
/private/tmp/fusionkit-tool-detail-visual-matrix/converter-min-light.png
/private/tmp/fusionkit-tool-detail-visual-matrix/converter-min-light-workspace.png
/private/tmp/fusionkit-tool-detail-visual-matrix/converter-wide-dark.png
/private/tmp/fusionkit-tool-detail-visual-matrix/converter-wide-light.png
/private/tmp/fusionkit-tool-detail-visual-matrix/visual-matrix-results.json
```

人工抽查结论：

- 786×540 下符合设计中的 `lg` 以下单列布局；配置栏、上传区和任务队列纵向排列，主 ScrollArea 纵向滚动，无横向页面滚动。
- 1440×900 下保持 320px 左侧配置栏和右侧自适应工作区；配置区、上传区、摘要行和任务面板间距与字幕 AI 翻译基准一致。
- Dark / Light 下边框、按钮、空状态和弱化文案可读性正常。
- 底部导航为全局固定层，未造成页面横向溢出。

## 前端进程清理

- 启动过的服务：
  - `VSCODE_DEBUG=1 ./node_modules/.bin/vite`，Codex session `66552`。
  - Playwright Electron 子进程由 `/private/tmp/fusionkit-tool-detail-visual-matrix.mjs` 启动，并在脚本 `finally` 中执行 `app.close()`。
- 结束方式：
  - 对 Vite session 发送 `Ctrl-C`，session 以 code `130` 退出。
- 结束后进程确认：
  - `ps -axo pid,ppid,command | rg '/Users/qiuyedx/Documents/Github/FusionKit/(node_modules/.bin/vite|node_modules/.bin/../vite|node_modules/.pnpm/electron|node_modules/.bin/electron)|Electron \\. --no-sandbox|vite --host 127.0.0.1|127.0.0.1:7777|VSCODE_DEBUG=1' | rg -v 'rg ' || true`
  - 输出为空，确认本轮启动的前端服务和 Electron 进程已结束。

## 未完成事项

- 无阻塞 `PRE-001` / `UI-001` / `UI-002` 完成的事项。
- `UI-002` 未在本次视觉矩阵中做真实文件转换链路回归；该项留至后续 `QA-*` 工作包覆盖。

## 下一步建议

1. 下一批代码工作建议认领 `UI-003`，迁移“字幕语言提取”页。
2. `UI-003` 也应复用本次 Playwright Electron 视觉矩阵策略，避免再被全局 loading 截图误导。
