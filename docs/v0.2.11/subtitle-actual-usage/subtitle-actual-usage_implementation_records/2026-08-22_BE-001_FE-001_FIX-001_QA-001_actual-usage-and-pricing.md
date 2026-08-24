# 工作包 BE-001 / FE-001 / FIX-001 / QA-001：实际用量与价格更新

## 基本信息

- 日期：2026-08-22
- 状态：已完成
- 对应执行计划工作包：BE-001、FE-001、FIX-001、QA-001

## 本次实现内容

- 统一累计 Chat Completions 与 Responses 返回的 input/output/total/reasoning/cached Token。
- 解析失败、截断、重试、并发失败和任务失败均保留已发生用量；并发失败等待在途请求 settle。
- usage 写入 checkpoint、完成摘要、恢复候选、IPC 事件、Renderer queue 与任务 Store。
- 新任务冻结 profile TokenPricing；旧任务缺单价时显示 Token，费用显示不可用。
- 任务列表、详情与汇总区区分实际 Token、按配置价计算费用、任务预估和剩余预估。
- DeepSeek V4 Flash/Pro 更新为 2026-08-22 官网高峰 cache-miss 价格。
- 新增项目 pitfall，防止并发失败在请求仍在途时过早冻结 usage。

## 修改文件

- `electron/main/ai/adapters/*`、`electron/main/translation/*`
- `src/type/subtitle*`、`src/renderer/subtitle.ts`
- `src/services/subtitle/*`、`src/store/tools/subtitle/useSubtitleTranslatorStore.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/*`、`src/locales/*/subtitle.json`
- `src/constants/model.ts`、`CHANGELOG.md`、相关测试与设计文档

## 接口或数据结构变化

- 新增 `SubtitleTranslationUsage`，记录累计 Token、请求覆盖率和可选计算费用。
- `SubtitleTaskReadyExecutionBinding` 新增可选 `tokenPricing` 冻结快照。
- checkpoint、恢复 DTO、progress/resolved/failed 事件新增可选 actual usage。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/ai/modelRuntimeClient.test.ts test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts test/translation/subtitle-translation-usage.test.ts test/translation/subtitle-translation-reference-schema.test.ts test/translation/subtitle-translation-preload.test.ts test/translation/subtitle-translation-ipc-service.test.ts test/translation/subtitle-translation-recovery-capability.test.ts test/translation/subtitle-translation-directory-capability.test.ts src/services/subtitle src/store/tools/subtitle src/agent/task-model-config.test.ts src/constants/model.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- Vitest 21 个文件、142 个测试通过。
- TypeScript、i18n locale parity、Renderer/Main/Preload build、diff check 通过。
- i18n source usage checker 仅有 Rename 工具两项既有错误：动态 `SCOPE_OPTIONS...hintKey`
  与陈旧 `scope.hintKey` manifest selector；本次字幕 key 无新增错误。
- 未启动 Vite/Electron 常驻服务，未使用真实模型 API Key。

## 未完成事项

- 未接入供应商账单 API；计算费用不是最终账单。
- TokenPricing 暂不表达 DeepSeek 分时价与 cache-hit 单价。

## 下一步建议

- 后续若扩展 pricing 合同，可分别表达高峰/非高峰与 cache hit/miss，再根据请求时间精算。
