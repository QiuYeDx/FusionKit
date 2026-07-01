# TEXT-004 长文本恢复、响应式与多语言视觉回归实施记录

> 日期：2026-06-26
> 工作包：`TEXT-004`
> 状态：已完成
> 范围：长文本翻译迁移后的恢复弹窗、响应式、主题、多语言和 active/queued task 切换回归。

## 1. 本次目标

`TEXT-001` 至 `TEXT-003` 已完成长文本翻译页配置栏、工作区入口、任务行和统计条迁移。本次不继续抽象组件，重点验证迁移后现有业务入口仍可达且视觉不回退：

- 恢复弹窗打开、刷新、继续、从头开始、删除、工作区路径；
- active task 与 queued task 切换；
- 786×540、1080×786、1440×900 下布局不横向溢出；
- Light / Dark；
- `zh` / `en` / `ja` 最小窗口按钮与标题长度；
- FusionKit 全局 loading 完全退出后再截图。

## 2. 实现结果

本次未修改产品代码。

验证过程中曾重点复核：

- `src/pages/Tools/Text/TextTranslator/index.tsx`
  - `RecoveryDialog` 弹窗内容、按钮和 handler；
  - `handleResumeRecovery` / `handleRestartRecovery` / `handleDeleteRecovery` / `handleRevealRecoveryWorkspace`；
  - active task / queued task 切换入口；
- `src/pages/Tools/Text/TextTranslator/components/TaskPanel.tsx`
  - 任务面板卡头按钮换行；
  - 独立任务队列行点击选中态；
  - 统计条在最小窗口下的可达性；
- `src/locales/{zh,en,ja,zh-Hant}/text.json`
  - 未新增 key；
  - i18n 数量校验通过。

发现但未作为本包修复的问题：

- 恢复弹窗的 `blockingReason` 仍直接展示后端原始值，例如 `missing_segment_index`。这是既有数据文案，不是本次 UI 迁移导致的布局问题；如需产品化，可后续单独做文案映射。

## 3. Electron 视觉与交互 QA

临时脚本：

```text
/private/tmp/fusionkit-text-004-visual-qa.mjs
```

脚本特性：

- 使用 Playwright Electron 启动真实 Electron 窗口；
- 连接本次 Vite dev server：`http://127.0.0.1:7777/`；
- 使用临时 `--user-data-dir=/private/tmp/fusionkit-text-004-user-data`，不污染真实用户数据；
- 启动临时 fake OpenAI-compatible server，供“继续恢复”路径快速完成；
- 每次截图前显式等待：
  - `.app-loading-wrap` 不存在；
  - `#app-loading-style` 不存在；
  - 路由为 `#/tools/text/translator`；
  - `#text-translator-config-panel`、`#text-translator-upload-zone`、`#text-translator-task-panel` 可见；
  - 主题 class 与预期一致；
  - 非弹窗场景无 dialog，弹窗场景仅 1 个 dialog。

覆盖结果：

| Case | 结果 | 截图 |
| --- | --- | --- |
| 786×540 Dark zh 已选 TXT+MD | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/responsive-min-dark-selected.png` |
| 786×540 Light zh 已选 TXT+MD | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/responsive-min-light-selected.png` |
| 1080×786 Dark zh 已选 TXT+MD | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/responsive-default-dark-selected.png` |
| 1080×786 Light zh 已选 TXT+MD | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/responsive-default-light-selected.png` |
| 1440×900 Dark zh 已选 TXT+MD | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/responsive-wide-dark-selected.png` |
| 1440×900 Light zh 已选 TXT+MD | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/responsive-wide-light-selected.png` |
| 786×540 Light zh 已准备 | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/language-zh-min-light-prepared.png` |
| 786×540 Light en 已准备 | loading=no；按钮换行/滚动可达；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/language-en-min-light-prepared.png` |
| 786×540 Light ja 已准备 | loading=no；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/language-ja-min-light-prepared.png` |
| 786×540 Light active task 切换 | 第二个 queued task 点击后 active class 生效 | `/private/tmp/fusionkit-text-004-visual-qa/active-task-switch-min-light.png` |
| 786×540 Light 恢复弹窗打开 | loading=no；dialog=1；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/recovery-dialog-min-light-open.png` |
| 786×540 Light 恢复动作后 | 刷新/工作区路径/从头开始/删除/继续 均执行；dialog=1；无页面/全局横向溢出 | `/private/tmp/fusionkit-text-004-visual-qa/recovery-dialog-min-light-after-actions.png` |

动作烟测结果记录：

```json
{
  "activeTaskSwitch": true,
  "refreshClicked": true,
  "workspaceClicked": true,
  "restartClicked": true,
  "deleteClicked": true,
  "resumeClicked": true
}
```

完整 JSON：

```text
/private/tmp/fusionkit-text-004-visual-qa/visual-results.json
```

## 4. 静态验证与测试

执行命令：

```text
./node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
git diff --check
./node_modules/.bin/vitest run test/text-translation src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
./node_modules/.bin/vite build
```

结果：

- `tsc --noEmit`：通过；
- i18n：`8 namespaces / 930 keys`，四语言数量一致；
- `git diff --check`：通过；
- text 相关测试：`19 files / 150 tests passed`；
- Vite build：renderer、main、preload 均构建成功；仅有既有 chunk 体积和动态导入 warning。

## 5. 前端进程清理

本次启动过：

```text
./node_modules/.bin/vite --host 127.0.0.1 --port 7777
```

Electron 由 Playwright 脚本启动，并在脚本 `finally` 中 `app.close()`。

fake model HTTP server 由临时脚本启动，并在脚本 `finally` 中关闭。

Vite 已通过当前终端 session 发送 `Ctrl-C` 关闭，退出码 `130`。

最终进程检查：

```text
ps -axo pid,ppid,command | rg 'FusionKit/(node_modules/.bin/vite|node_modules/.bin/../vite|node_modules/.pnpm/electron|node_modules/.bin/electron)|Electron \\. --no-sandbox|127.0.0.1:7777|--port 7777|vite --host 127.0.0.1' | rg -v 'rg ' || true
```

结果为空，无遗留 Vite/Electron 前端服务进程。

## 6. 后续建议

下一步认领 `CLEAN-001`：

- 检查并删除无生产引用的旧视觉组件：
  - `ToolSection`
  - `ToolStat` / `ToolStatGrid`
  - `ToolActionBar` / `TooltipIconButton`
- 清理 `_shared/ui/index.ts` 导出；
- 检查是否仍存在旧 340px 双栏、大 CardHeader 或漂移 class；
- 更新 Final Design 中“计划删除/完成标准”与真实实现一致。

遗留风险：

- `missing_segment_index` 等后端阻塞原因仍是原始值，若需要更产品化的恢复文案，应另开小型文案/错误映射工作。
