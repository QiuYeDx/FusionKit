# 工作包 RN-PERF-001：Planner 进度与耗时观测

## 基本信息

- 日期：2026-06-17
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md` 中的 `RN-PERF-001`

## 本次实现内容

- 新增名称翻译 planning progress 类型，覆盖阶段、目标数量、批次进度、重试计数、warning 计数和阶段耗时 metrics。
- 扩展 `createNameTranslationPlan` deps，支持可选 `progress` callback 和 `signal` 占位。
- 在 planner 中上报 `scanning`、`translating`、`checking_targets`、`validating`、`storing`、`done`、`failed` 阶段。
- 增加扫描、翻译、路径检查、plan build、总耗时等 metrics。
- 给现有串行翻译流程补充请求数、批次数、完成批次数、重试数和已处理目标数统计。
- 保持现有 25 条一批的串行模型请求策略不变。
- 补充 planner 单元测试，覆盖正常进度、metrics 和失败进度。

## 修改文件

- `src/services/rename/nameTypes.ts`
- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`
- `docs/batch-name-translation-tool/implementation-records/2026-06-17_RN-PERF-001_planner-progress.md`

## 接口或数据结构变化

- 新增 `NameTranslationPlanningPhase`。
- 新增 `NameTranslationPlanningMetrics`。
- 新增 `NameTranslationPlanningProgress`。
- `CreateNameTranslationPlanDeps` 新增：
  - `progress?: (progress: NameTranslationPlanningProgress) => void`
  - `signal?: AbortSignal`

本工作包只接入 `progress`；`signal` 为 RN-PERF-002 的取消入口预留，不改变当前 planner 行为。

## 验证结果

执行命令：

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts
```

结果：

- 通过：1 个测试文件，10 个测试。

执行命令：

```text
pnpm exec vitest run test/rename src/services/rename
```

结果：

- 通过：6 个测试文件，42 个测试。

执行命令：

```text
pnpm exec tsc --noEmit
```

结果：

- 未通过，失败点为既有 `src/components/qiuye-ui/code-block/code-block-panel.tsx` 和 `src/components/qiuye-ui/code-block/code-block-root.tsx` 中 `<style jsx global>` 属性类型问题，和本工作包改动无关。

## 未完成事项

- 尚未将 progress 接入工具页 store/UI。
- 尚未实现 cancel commit 防护。
- 尚未实现去重、缓存、快路径或并发翻译。

## 下一步建议

- 下一次优先认领 `RN-PERF-002`，把 planner progress 接入 `useNameTranslatorStore` 和工具页，提供可见进度与取消入口。

