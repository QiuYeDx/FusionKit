# 工作包 UI-004：文件名翻译页布局与面板统一

## 基本信息

- 日期：2026-06-26
- 状态：已完成
- 对应执行计划工作包：`UI-004`

## 本次实现内容

- 将批量文件名翻译页外层从页面私有布局迁移到共享 `ToolDetailLayout`：
  - 页面容器、最大宽度、底部留白、双栏 gap 由共享组件统一。
  - 左栏从 `340px` 收敛为共享 `320px`。
  - `RiskConfirmDialog` 与 `Tour` 保持在布局外作为 portal 类兄弟节点，避免进入 main flex 布局。
- 将左栏面板迁移到共享配置面板语法：
  - `PathPickerPanel` 使用 `ToolConfigPanel`。
  - `OptionsPanel` 使用 `ToolConfigPanel`、`ToolField`、`ToolConfigDivider`。
  - Rename 的路径拖拽、文件/文件夹选择、已选路径列表和 preview/reset 行为不变。
  - 范围选项在 320px 侧栏下改为优先单列，到更宽空间再两列，降低最小宽度挤压风险。
- 将右侧工作区面板迁移到共享工作面板语法：
  - `PlanPreviewTable` 使用 `ToolPanel`，保留 dry-run badge、revalidate action、表格局部横向滚动、分页、编辑、跳过、恢复、自动编号和打开位置动作。
  - `ApplySummaryPanel` 使用 `ToolPanel`，保留 planId badge、应用指标、warning/validation alert、apply progress、rollback 和 apply 按钮逻辑。

## 修改文件

- `src/pages/Tools/Rename/NameTranslator/index.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PathPickerPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/ApplySummaryPanel.tsx`
- `docs/tool-detail-page-ui-standardization-execution-plan.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_UI-004_name-translator-layout-migration.md`

## 接口或数据结构变化

- 无 rename store、service、IPC、apply journal、rollback、plan cache 或 i18n key 变化。
- 无共享组件 API 新增。
- 未将 rename plan 抽象为通用 task 类型；表格行、风险确认和 apply/rollback 继续由 Rename 业务页面拥有。

## 视觉核对

- 页面：批量文件名翻译
- 窗口尺寸：786×540、1440×900
- 主题：Light、Dark
- 页面状态：空计划 / 默认配置
- 结果：通过。
  - 4 个组合均 `loading=no`、`modal=0`、`pageOverflow=no`、`globalOverflow=no`。
  - 1440×900 下左栏为 `320w`，右侧预览工作区为 `880w`。
  - 786×540 下单列布局生效，路径配置与工作区宽度均为 `722w`。
  - 最小窗口额外滚动到工作区截图，确认预览和应用面板可见。
  - 截图已预置 `name-translator-tour-done=1`，并等待 `.app-loading-wrap` 与 `#app-loading-style` 移除。

## 验证结果

执行命令：

```text
./node_modules/.bin/vitest run src/store/tools/rename/useNameTranslatorStore.test.ts src/services/rename/nameTranslationPlanner.test.ts
./node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
./node_modules/.bin/vite build
git diff --check
rg -n "CardHeader|CardTitle|<Card|</Card>|lg:grid-cols-\[340px_minmax|text-base" src/pages/Tools/Rename/NameTranslator src/pages/Tools/Rename/NameTranslator/components
node /private/tmp/fusionkit-name-translator-visual-matrix.mjs
```

结果：

- Rename 单测通过：2 个测试文件，37 个测试全部通过。
- `tsc` 通过。
- i18n 检查通过；四语言总 key 数均为 930。
- Vite build 通过；仅保留既有 dynamic/static import 和 chunk size warning。
- `git diff --check` 通过。
- Rename 页面及其组件不再命中旧 `CardHeader`、`CardTitle`、`<Card>`、`340px` 左栏和 `text-base` 大标题扫描。
- Electron 视觉矩阵通过：
  - `name-translator/min/dark`：`loading=no`、`modal=0`、`pageOverflow=no`、`globalOverflow=no`。
  - `name-translator/min/light`：`loading=no`、`modal=0`、`pageOverflow=no`、`globalOverflow=no`。
  - `name-translator/wide/dark`：`loading=no`、`modal=0`、`pageOverflow=no`、`globalOverflow=no`。
  - `name-translator/wide/light`：`loading=no`、`modal=0`、`pageOverflow=no`、`globalOverflow=no`。
  - 截图目录：`/private/tmp/fusionkit-name-translator-visual-matrix/`。

## 前端进程清理

- 启动过的服务：Vite renderer，`VSCODE_DEBUG=1 ./node_modules/.bin/vite --host 127.0.0.1 --port 7777`。
- 结束方式：回复前通过 Ctrl-C 结束 Vite；Playwright Electron 由视觉矩阵脚本 `app.close()` 关闭。
- 结束后进程确认：回复前执行 FusionKit Vite/Electron 进程表检查，输出为空。

## 未完成事项

- 无。

## 下一步建议

- 下一步认领 `TEXT-001`，开始长文本翻译配置栏迁移。
