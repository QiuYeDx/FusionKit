# 工作包 RV-003：`createPlanFromSummary` fallback 使用截断 items

## 基本信息

- 日期：2026-06-22
- 状态：已完成
- 对应执行计划工作包：RV-003

## 本次实现内容

- 在 `createPlanFromSummary()` 中，当 `itemsPreview.length < totalTargets` 时将 `applyable` 设为 `false`，从源头阻止不完整 plan 的 apply。
- 在 `applyCurrentPlan()` 中新增守卫：检测到 `isPlanIncomplete(plan)` 时拒绝执行并 toast 提示用户。
- 新增 `isPlanIncomplete()` 工具函数（`!plan.itemsStored && plan.items.length < plan.totalTargets`），导出供 UI 组件使用。
- `PlanPreviewTable` 在不完整 plan 时显示警告 Alert banner，提示用户重新生成预览。
- `ApplySummaryPanel` 在不完整 plan 时显示专用红色提示文案，替代默认的 blocked hint。
- 4 种语言（zh/en/ja/zh-Hant）同步新增 3 个 i18n key：`messages.plan_items_incomplete`、`preview.incomplete_warning_title` + `desc`、`apply.incomplete_hint`。

**额外修复**：同步修复 store 层 `collectExistingTargetPaths()` 中 `checkRenameTargetsExist` 的调用方式，适配 RV-002 改为 `BatchPathCheckResult` 返回类型后的新接口（从 `[...result]` 改为 `[...result.existingPaths]`）。

## 修改文件

- `src/store/tools/rename/useNameTranslatorStore.ts` — `createPlanFromSummary` 不完整判定 + `applyCurrentPlan` 守卫 + `isPlanIncomplete` 导出 + `collectExistingTargetPaths` 适配 BatchPathCheckResult
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx` — 不完整 plan 警告 banner
- `src/pages/Tools/Rename/NameTranslator/components/ApplySummaryPanel.tsx` — 不完整 plan 提示
- `src/locales/zh/rename.json` — 新增 3 个 key
- `src/locales/en/rename.json` — 新增 3 个 key
- `src/locales/ja/rename.json` — 新增 3 个 key
- `src/locales/zh-Hant/rename.json` — 新增 3 个 key
- `src/store/tools/rename/useNameTranslatorStore.test.ts` — 新增 3 个测试用例

## 接口或数据结构变化

- 新增导出函数 `isPlanIncomplete(plan: NameTranslationPlan): boolean`（从 `useNameTranslatorStore` 模块导出）

## 验证结果

执行命令：

```text
pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts
```

结果：

- 10 tests passed（含 3 个新增 incomplete plan 测试）
- Duration: 444ms

全量回归：

```text
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
```

- 73/75 tests passed
- 2 failures 均在 `nameTranslationPlanner.performance.test.ts`，属于 RV-006 待修复范围（`pathCheckRequestCount` 预期值因 RV-002 返回类型变更而过期）

i18n 检查：

```text
pnpm run i18n:check → ✅ All checks passed (174 keys × 4 languages)
```

## 未完成事项

无。

## 下一步建议

继续 RV-004：批量 path-check 两层 fallback 全部失败时无警告。
