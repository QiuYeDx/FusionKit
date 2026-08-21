# 字幕 AI 翻译实际 Token 用量执行计划

## 使用方式

后续会话先阅读本目录 final design 与本计划，检查进度台账，再领取一个未完成工作包。
状态只使用：未开始、进行中、已完成、阻塞、废弃。

## 不可违反的约束

- API usage 是实际 Token 来源，离线 tokenizer 只用于请求前预估。
- calculatedCost 必须描述为按冻结 profile 单价计算，不能冒充供应商账单。
- 失败、解析重试、并发分片和 checkpoint 恢复不能丢已发生 usage。
- 旧任务、旧 checkpoint 缺字段时继续可用。
- 不启动未固定版本的 pnpm；使用 node_modules/.bin 下的项目工具。
- 如启动 Vite/Electron，结束前必须关闭并检查进程。

## 进度台账

| ID | 状态 | 完成日期 | 工作包 | 关键文件 | 验证 | 实施记录 | 未决事项 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BE-001 | 已完成 | 2026-08-22 | usage 聚合、任务绑定、checkpoint 与 IPC | `electron/main/translation/*`、`src/type/subtitle.ts`、`src/renderer/subtitle.ts` | 相关 Vitest、tsc | `subtitle-actual-usage_implementation_records/2026-08-22_BE-001_FE-001_FIX-001_QA-001_actual-usage-and-pricing.md` | - |
| FE-001 | 已完成 | 2026-08-22 | 实际/预估用量显示 | `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`、locales、`src/services/subtitle/subtitleUsageStats.ts` | 统计测试、i18n、build | `subtitle-actual-usage_implementation_records/2026-08-22_BE-001_FE-001_FIX-001_QA-001_actual-usage-and-pricing.md` | - |
| FIX-001 | 已完成 | 2026-08-22 | DeepSeek V4 最新价格 | `src/constants/model.ts`、测试、CHANGELOG | constants test | `subtitle-actual-usage_implementation_records/2026-08-22_BE-001_FE-001_FIX-001_QA-001_actual-usage-and-pricing.md` | 单组 profile 价格采用高峰 cache-miss |
| QA-001 | 已完成 | 2026-08-22 | 端到端回归与文档收尾 | subtitle/runtime/recovery tests、docs | 142 tests、tsc、i18n parity、三段 build、diff | `subtitle-actual-usage_implementation_records/2026-08-22_BE-001_FE-001_FIX-001_QA-001_actual-usage-and-pricing.md` | 未使用真实 API Key；i18n usage checker 有 Rename 既有问题 |

## 实施顺序

1. BE-001：先闭环 Adapter -> BaseTranslator -> event -> Store -> checkpoint/recovery。
2. FE-001：消费稳定的 actualUsage 合同，拆分实际与预估显示。
3. FIX-001：更新官方价格、来源说明和预设测试。
4. QA-001：扩大回归、更新 ledger 与实施记录。

## 实施记录要求

每个会话记录日期、状态、改动文件、接口变化、准确命令与结果、未完成事项和下一步建议。
