# 名称翻译小批量预览速度修复

> 日期：2026-06-22  
> 类型：fix  
> 范围：1～50 个文件/文件夹名称的模型翻译批处理

## 背景与现象

用户选择 1 个文件生成预览时尚可接受，但选择 5 个文件时耗时放大明显，体感近似 5 个名称串行处理。

## 根因

原实现虽然有 `concurrency=3` 的 promise pool，但默认 `batchSize=50`：

- 1 个名称形成 1 个批次。
- 5 个名称仍形成 1 个批次。
- 只有超过 50 个名称后才会出现第二个批次。

因此 5 个名称不会触发任何批次级并发。代码没有逐文件 `await`，但模型必须在同一个结构化 JSON 响应中依次生成 5 个 `translatedStem`，输出 token 增长会直接拉长墙钟时间。现有并发能力在该场景中完全闲置。

扫描、缓存、快路径和批量路径存在性检查并不是该差异的主要来源；可控延迟测试确认主要耗时集中在单一模型响应。

## 修复方案

- `NameTranslationBatchConfig` 新增 `adaptiveBatching`，默认开启。
- 1～4 个待翻译名称保持单请求，避免为极小任务重复发送 system prompt。
- 从 5 个名称开始，若原始批次数未超过并发槽，则均匀拆成最多 3 批：
  - 5 项：`2 + 2 + 1`
  - 25 项：`9 + 8 + 8`
  - 50 项：`17 + 17 + 16`
- 中大批量仍遵守 `batchSize=50` 上限和 `concurrency=3`。
- 429 时仍会降级并发到 1 并退避；取消、缓存、快路径和结构化输出失败拆批逻辑保持不变。
- progress 的批次数与峰值并发改为自适应后的真实值。

## 性能对照

fake model 使用“25ms 固定请求延迟 + 每项 35ms 输出延迟”模拟模型响应：

```text
1 项默认策略：64ms
5 项旧单批策略：202ms
5 项自适应策略：97ms
```

该参考测试中：

- 5 项相对旧策略缩短约 52%。
- 5 项相对 1 项从约 3.2 倍降至约 1.5 倍。
- 自适应策略真实形成 3 个请求，批大小为 `2 / 2 / 1`，峰值并发为 3。

以上是稳定、无网络依赖的相对基准，不代表任意真实模型供应商的绝对耗时。

## 影响文件

- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `test/rename/nameTranslationPlanner.performance.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization-final-design.md`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`
- `docs/batch-name-translation-tool/implementation-records/2026-06-22_RN-PERF-008_small-batch-adaptive-concurrency.md`

## 验证结果

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts
结果：25 tests passed

pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts
结果：5 tests passed

pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts src/agent/tool-schemas.test.ts
结果：12 test files、168 tests passed

pnpm exec vite build --mode=test
结果：renderer、main、preload 全部构建成功；仅保留既有 chunk size / mixed import 警告

pnpm run i18n:check
结果：zh / en / ja / zh-Hant 全部通过

pnpm exec tsc --noEmit
结果：本次改动未新增类型错误；仍被既有 styled-jsx 类型错误阻塞：
- src/components/qiuye-ui/code-block/code-block-panel.tsx:300
- src/components/qiuye-ui/code-block/code-block-root.tsx:590

git diff --check
结果：通过
```

## 风险与后续

- 自适应拆批会重复发送少量 system prompt，输入 token 和请求数会增加；这是以小幅调用开销换取明显墙钟时间下降。
- 若真实供应商并发额度较低，现有 429 降速会自动兜底；后续可按模型 profile 配置并发上限。
