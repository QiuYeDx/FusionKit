# 工作包 RN-PERF-004：受控并发翻译、错误分类与 abort 语义

## 基本信息

- 日期：2026-06-17
- 状态：已完成
- 对应执行计划工作包：RN-PERF-004

## 本次实现内容

- 在 planner 内新增 `NameTranslationBatchConfig`，默认 `batchSize = 50`、`concurrency = 3`、`minBatchSize = 5`、`maxBatchSize = 80`、`rateLimitBackoffMs = 1500`。
- 将翻译调度从批次串行改为受控并发 scheduler，按配置限制同时运行的模型批次数。
- progress 继续上报 `activeBatchCount`、`completedBatchCount`、`totalBatchCount`、`retryCount`，metrics 中的 `translationConcurrencyPeak` 改为真实并发峰值。
- 429 / rate limit 归类为可退避错误，触发 `model_rate_limit_backoff:<count>:<ms>ms` warning，并将后续 scheduler 并发降为 1。
- 401 / 403、quota、model not found、network unavailable 等错误 fail fast，不再拆批重试。
- 结构化/解析类错误仍保留 batch split recovery。
- 真实任务模型调用的 text fallback 只在结构化/解析类错误时执行，限流/鉴权/网络/配额类错误交给上层恢复逻辑处理。
- 在批次启动、retry/backoff、split 左右分支、批次输出写入前后增加 abort 检查；取消后不写 plan，不继续启动后续批次。

## 修改文件

- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`

## 接口或数据结构变化

- `CreateNameTranslationPlanDeps` 新增可选 `batchConfig?: Partial<NameTranslationBatchConfig>`。
- 新增导出类型 `NameTranslationBatchConfig`。
- 默认模型请求批大小从 25 调整为 50，并使用 3 路受控并发。
- rate limit 最多退避重试 2 次；持续失败后以 `model_request_failed` 抛出。

## 验证结果

执行命令：

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts src/services/rename/nameTranslationCache.test.ts
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
```

结果：

- planner/cache 最小验证：2 files / 21 tests passed。
- rename 与 store 扩展验证：8 files / 59 tests passed。
- `pnpm run i18n:check`：通过，所有 namespace 多语言 key 数一致。
- `pnpm exec tsc --noEmit`：失败于既有 `src/components/qiuye-ui/code-block/code-block-panel.tsx` 与 `src/components/qiuye-ui/code-block/code-block-root.tsx` 的 `style jsx global` React 类型问题；本次 rename 改动未出现新的类型错误。

## 未完成事项

- 本包未实现批量目标路径存在性 IPC，仍保留现有逐路径 `checkPathExists`；该项进入 RN-PERF-005。
- scheduler 无法真正取消已发出的底层模型请求，但会阻止后续批次启动、阻止结果写入 plan，并在支持 AbortSignal 的外层状态中进入 cancelled。

## 下一步建议

- 下一轮认领 RN-PERF-005：新增批量目标路径存在性 IPC，并让 planner/store revalidate 优先使用批量接口，保留单路径 fallback。
