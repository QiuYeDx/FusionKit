# 工作包 MEM-003：连贯串行 Executor 与恢复

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：MEM-003

## 本次实现内容

- 新增正式串行响应协议模块，支持动态 `FUSIONKIT_TRANSLATION / FUSIONKIT_MEMORY_PATCH / FUSIONKIT_END` 边界生成与解析。
- 串行响应解析接入正式 `SemanticMemoryPatch` parser；仅 patch 无效时保留译文、追加 warning、memoryVersion 不推进。
- `TextTranslationService.createTask()` 放开单 TXT `sequential_context + target_only`。
- 准备阶段为串行任务初始化 `memory/latest.json`，来源为用户 glossary、documentBackground 和 styleInstructions。
- `startTask()` / `resumeTask()` 根据 executionMode 分流：parallel 保持原并发路径，sequential_context 走严格顺序循环。
- 串行循环每次只 acquire 一个 scheduler 槽位；后一片必须等前一片译文落盘和 memory patch 提交后才启动。
- 串行 prompt 携带裁剪后的 latest memory、当前 segment、用户要求、术语表和最近一片原文/译文尾部。
- 每个串行 segment 完成事件记录 `inputMemoryVersion` 与 `memoryVersion`。
- 当前片失败后立即停止后续 segment；已有结果保留，任务按既有规则进入 `partially_completed` 或 `failed`。
- 恢复新 service 实例时，event sequence 从旧日志末尾继续，避免恢复后新事件被 replay 忽略。
- 恢复时从第一个未完成 segment 开始，使用工作区 latest memory 和已完成上一片译文尾部继续串行翻译。

## 修改文件

- `electron/main/text-translation/model/translation-response-protocol.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `electron/main/text-translation/persistence/event-log.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增主进程内部 `ParsedSequentialTranslationResponse`、`TranslationProtocolError` 和 sequential prompt/marker helpers。
- 工作区 `segment_completed` 事件新增可选 `inputMemoryVersion`，并继续使用已有 `memoryVersion` 表示输出稳定版本。
- `replayTextTranslationEvents()` 现在返回 `segmentMemoryVersions`，可按 segmentId 查询输入/输出 memoryVersion。
- IPC DTO 暂无新增字段；Renderer 仍可通过既有 task/progress 事件感知状态。

## 验证结果

执行命令：

```text
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`：1 个测试文件、5 个测试通过。
- 核心文本翻译回归：12 个测试文件、70 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 串行执行首版仍限定单 TXT、target-only；Markdown、双语和多文件项目由后续工作包接入。
- 中间重翻后续 stale 标记、禁止混用旧依赖链和分片级重跑入口由 MEM-004 落地。
- 串行 patch warning 当前写入工作区 warning event，尚未在 Renderer 中单独展示。
- 压缩器仍为 MEM-002 的注入式接口；真实压缩请求尚未接入。

## 下一步建议

- 继续认领 `MEM-004：中间重翻与后续 stale 契约`。
- MEM-004 需要在事件、恢复、输出组装和 service API 上收口 stale 结果，防止用户重翻中间片后继续组装旧后续译文。
