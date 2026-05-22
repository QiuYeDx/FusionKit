# 工作包 RN-004：手动工具页

## 基本信息

- 日期：2026-05-20
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-004_manual-tool-page.md`

## 本次实现内容

- 新增 `useNameTranslatorStore`，维护路径选择、翻译 options、当前 plan、应用进度、校验结果、apply/rollback 结果和最近历史。
- 接入 RN-001 至 RN-003：
  - `inspect-rename-paths` 用于路径选择后的类型/风险补全。
  - `createNameTranslationPlan` 用于生成 dry-run 预览。
  - `validateNameTranslationPlan` 用于手动编辑后重新校验和 apply 前复验。
  - `applyNameTranslationPlan` / `rollbackNameTranslationJournal` 用于执行与基础回滚入口。
- 新增 `/tools/rename/name-translator` 工具详情页，复用现有工具页的 `ToolPageHeader`、左侧粘性配置 rail、右侧卡片式任务区域和 shadcn UI 组件。
- 实现路径选择面板，支持系统选择器、拖拽、已选路径列表、风险标签和目录子项数量展示。
- 实现范围、目标类型、语言、命名风格、隐藏项、扩展名、技术 token、冲突策略等配置项。
- 实现预览表：
  - 状态、类型、原名称、新名称、原路径、目标路径、原因/警告、操作列。
  - 50 项分页，避免大批量一次渲染。
  - 支持编辑新名称、跳过、恢复 AI 建议、对冲突使用自动编号、重新校验。
- 实现应用摘要和高风险确认弹窗：
  - blocked 为 0 且 ready 大于 0 才允许应用。
  - 目录重命名、递归、path_segments、ready 超 100、包含 warnings 时二次确认。
  - 应用后展示 journalId、成功/失败/跳过统计和基础回滚按钮。

## 修改文件

- `src/services/rename/nameTypes.ts`
- `src/store/tools/rename/useNameTranslatorStore.ts`
- `src/pages/Tools/Rename/NameTranslator/index.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PathPickerPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/ApplySummaryPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/RiskConfirmDialog.tsx`
- `src/App.tsx`
- `src/constants/router.ts`
- `src/pages/Tools/_shared/toolMeta.ts`
- `src/locales/zh/common.json`
- `src/locales/en/common.json`
- `src/locales/ja/common.json`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-004_manual-tool-page.md`
- `docs/batch-name-translation-tool/implementation-records/2026-05-20_RN-004_manual-tool-page.md`

## 接口或数据结构变化

- `src/services/rename/nameTypes.ts` 新增 renderer UI/store 使用的类型：
  - `RenamePathKind`
  - `RenameRiskLevel`
  - `InspectedRenamePath`
  - `SelectedPath`
  - `ApplyProgress`
- `TOOL_META.rename` 新增 route：`/tools/rename/name-translator`，但状态仍为 `soon`，工具列表入口不在 RN-004 放开。
- `ToolNameMap` 新增 rename 工具详情页标题映射，并在 `common.json` 三语中补充最小二级页标题。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename src/services/rename
pnpm exec tsc --noEmit
pnpm build
pnpm dev
```

结果：

- rename 相关测试：6 files passed，26 tests passed。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：通过；electron-builder 产生 macOS arm64 DMG/zip，构建日志仅保留既有 dynamic import/chunk size、package description missing 和未签名提示。
- `pnpm dev`：通过；临时将 rename 卡片置为可点后进入 Electron 窗口 `/tools/rename/name-translator` 冒烟检查，页面按现有工具页风格渲染，无明显重叠；检查后已恢复 `TOOL_META.rename.status = "soon"`。

## 未完成事项

- RN-005 需要正式放开工具列表入口，并补齐工具页多语言文案，而不是依赖 RN-004 中的中文页面文案。
- RN-006/RN-007 需要复用 `useNameTranslatorStore` / rename services 接入 HomeAgent，不得绕过 dry-run、validate、apply/journal 链路。
- `path_segments` 仍按 RN-002 设计保持需确认/不可应用，后续若要支持高级编辑器需要单独扩展。

## 下一步建议

- 下一会话优先认领 RN-005：把 `rename` 工具从 Coming Soon 变为正式入口，补充 `tools.json` 和新页面的多语言命名，确认工具卡片可直接进入 `/tools/rename/name-translator`。
