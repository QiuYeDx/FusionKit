# 工作包 RN-PERF-008：小批量自适应并发拆分

## 基本信息

- 日期：2026-06-22
- 状态：已完成
- 对应执行计划工作包：`RN-PERF-008`

## 本次实现内容

- 定位 1～50 个未缓存名称始终进入单一模型请求的问题。
- 增加自适应批处理开关，默认开启。
- 1～4 项保留单请求；5 项及以上在可用并发槽内均匀拆批。
- 5 项默认拆为 `2 + 2 + 1`，同时启动 3 个模型请求。
- progress 和 metrics 改为记录自适应后的真实批次数与峰值并发。
- 新增一文件、旧五文件单批、自适应五文件三组 fake model 性能对照。

## 修改文件

- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `test/rename/nameTranslationPlanner.performance.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization-final-design.md`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`
- `docs/batch-name-translation-tool/implementation-records/2026-05-21_final-implementation-status.md`
- `docs/batch-name-translation-tool/fix/2026-06-22_small-batch-adaptive-concurrency-fix.md`

## 接口或数据结构变化

- `NameTranslationBatchConfig` 新增 `adaptiveBatching: boolean`。
- 默认值为 `true`；测试或诊断可设为 `false` 复现旧单批策略。
- 计划与 apply 数据结构不变。

## 验证结果

执行命令：

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts
pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts src/agent/tool-schemas.test.ts
pnpm exec vite build --mode=test
pnpm run i18n:check
pnpm exec tsc --noEmit
git diff --check
```

结果：

- planner：25 tests passed。
- performance：5 tests passed。
- 名称翻译完整回归：12 test files、168 tests passed。
- fake model 参考：single=64ms、legacy five=202ms、adaptive five=97ms。
- renderer、main、preload 构建成功，仅保留既有 chunk size / mixed import 警告。
- zh / en / ja / zh-Hant i18n 完整性检查通过。
- `tsc --noEmit` 仅被既有两个 styled-jsx React 类型错误阻塞，本次改动未新增类型错误。
- `git diff --check` 通过。

## 未完成事项

- 真实模型绝对耗时受供应商、网络、模型推理速度和限流影响，不写入自动化硬阈值。

## 下一步建议

- 发布前使用当前任务模型分别手工测试 1、5、20 个非缓存名称，记录 translation metrics 与实际墙钟时间。
- 若供应商对 3 并发频繁返回 429，可按模型 profile 增加可配置并发上限，而不是回退到永久单批。
