# 工作包 RN-PERF-007：性能回归测试、验收记录与文档回填

## 基本信息

- 日期：2026-06-18
- 状态：已完成
- 对应执行计划工作包：RN-PERF-007

## 本次实现内容

- 新增 fake model 性能回归测试，不依赖真实模型供应商、网络或 Electron 主进程。
- 固化 500 targets 场景下的串行 batch 与并发 batch 相对耗时合同，并校验请求数、批次数、峰值并发和批量路径检查请求数。
- 固化缓存和快路径组合收益：500 targets 二次生成时不再调用 fake model，并记录 `translationCacheHitCount` / `translationFastPathCount`。
- 固化取消语义：取消后不继续启动 queued work，且不写入半成品 plan。
- 固化 recoverable parse 失败的 batch split recovery 行为和 retry 指标。
- 回填 final design、执行计划台账和最终 implementation notes。

## 修改文件

- `test/rename/nameTranslationPlanner.performance.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization-final-design.md`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`
- `docs/batch-name-translation-tool/implementation-notes/2026-05-21_final-implementation-status.md`
- `docs/batch-name-translation-tool/implementation-records/2026-06-18_RN-PERF-007_perf-tests-docs.md`

## 接口或数据结构变化

- 无生产接口变化。
- 新增测试入口 `test/rename/nameTranslationPlanner.performance.test.ts`，通过 `createNameTranslationPlan` 既有依赖注入点覆盖性能合同。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts src/services/rename/nameTranslationPlanner.test.ts
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm run i18n:check
pnpm exec tsc --noEmit
git diff --check
```

结果：

- 性能测试 + planner 测试：2 files / 24 tests passed。
- rename、store 扩展验证：10 files / 70 tests passed。
- i18n completeness check passed。
- `git diff --check` passed。
- `pnpm exec tsc --noEmit` 失败于既有 styled-jsx React 类型问题：
  - `src/components/qiuye-ui/code-block/code-block-panel.tsx(300,14)`
  - `src/components/qiuye-ui/code-block/code-block-root.tsx(590,12)`
- `pnpm build` 未单独运行；当前 build 前置 `tsc` 门禁仍会被上述既有问题阻塞。

## 未完成事项

- 真实模型性能不进入 CI 自动断言；发布前仍需按 final design 10.3 执行手工验收并记录实际模型、目录规模、网络和耗时。
- 修复既有 `code-block` styled-jsx 类型问题后，再补跑 `pnpm exec tsc --noEmit` 和 `pnpm build`。

## 下一步建议

- 性能优化主线 `RN-PERF-001` 到 `RN-PERF-007` 已收口。
- 下一轮优先修复发布前阻塞项：`src/components/qiuye-ui/code-block/*` 的 styled-jsx React 类型问题。
