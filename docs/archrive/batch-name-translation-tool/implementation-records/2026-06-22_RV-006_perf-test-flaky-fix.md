# RV-006：性能测试阈值 CI flaky 风险 — 实施记录

> 日期：2026-06-22
> 状态：已完成

## 问题

`test/rename/nameTranslationPlanner.performance.test.ts` 中第一个测试用例使用时间比较断言 `expect(concurrent.durationMs).toBeLessThan(serial.durationMs * 0.85)`，在高负载 CI 环境下可能抖动失败。

## 修复内容

### 1. 移除 flaky 时间比较断言，改为确定性结构断言

**文件：** `test/rename/nameTranslationPlanner.performance.test.ts`

- 删除 `expect(concurrent.durationMs).toBeLessThan(serial.durationMs * 0.85)` 断言
- 添加 `console.log` 输出时间数据供手工验收参考
- 新增 serial 端的 progress metrics 断言（`translationConcurrencyPeak: 1`），与 concurrent 端（`translationConcurrencyPeak: 3`）形成结构性对比验证

### 2. 修复 `checkPathsExist` mock 返回类型不匹配

RV-002 将 `checkPathsExist` 返回类型从 `Set<string>` 改为 `BatchPathCheckResult`，但性能测试中 4 处 mock 仍返回 `new Set()`，导致批量检查因 `batchResult.errorPaths` 未定义而抛异常，fallback 到逐条 `checkPathExists` 调用，`pathCheckRequestCount` 偏高。

**修复：** 将全部 4 处 `checkPathsExist: async () => new Set()` 改为 `checkPathsExist: async () => ({ existingPaths: new Set(), errorPaths: new Map() })`。

## 验证

```text
pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts — 4 tests passed
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts — 153 tests (11 files) passed
```
