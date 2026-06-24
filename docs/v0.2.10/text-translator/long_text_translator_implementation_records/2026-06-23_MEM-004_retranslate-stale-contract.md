# 工作包 MEM-004：中间重翻与后续 stale 契约

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：MEM-004

## 本次实现内容

- 新增 `retranslateFromSegment` IPC/service 契约，用于从指定 segment 开始重翻串行任务。
- 重翻前会把目标 segment 及后续 segment 写入 `segment_stale` 事件，旧结果文件可保留在磁盘上，但不再计入有效 completed 集合。
- `replayTextTranslationEvents()` 遇到 `segment_stale` 会移除旧 resultPath 和 memoryVersion；后续同 segment 再次 completed 才恢复有效。
- 重翻时只保留目标 segment 之前的有效 results，清空 outputPaths，并把 `staleFromSegmentId` 写入 task.json。
- 对目标片前一片使用 periodic memory snapshot 恢复 latest memory；目标为第一片时重建初始 memory。
- 串行 segment 成功提交 patch 时写 periodic snapshot，供后续中间重翻恢复依赖链。
- 重翻失败后任务保持 `partially_completed`，stale segment 不会参与正式输出组装。
- 重翻完成全部后清空 `staleFromSegmentId` 并重新生成输出文件。
- 恢复弹窗展示 `staleFromSegmentId` 提示，说明该片起的后续译文会重新生成。

## 修改文件

- `src/type/textTranslationIpc.ts`
- `src/services/text/textTranslatorExecutionService.ts`
- `electron/main/text-translation/ipc.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `electron/main/text-translation/persistence/event-log.ts`
- `electron/main/text-translation/memory/semantic-memory-manager.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `TEXT_TRANSLATION_IPC_CHANNELS` 新增 `retranslateFromSegment`。
- 新增 `RetranslateTextTranslationFromSegmentRequest`：`taskId`、`segmentId`、可选 `model`。
- `TextTranslationIpcService` 新增 `retranslateFromSegment()`。
- `SemanticMemoryManager.applyPatch()` 支持提交时写 snapshot。
- 工作区 replay 对 `segment_stale` 的语义变为：旧完成结果不再有效，直到该 segment 再次完成。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 888 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`：1 个测试文件、5 个测试通过。
- 核心文本翻译回归：12 个测试文件、70 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 分片级重翻 UI 操作入口尚未开放；当前先完成 service/IPC 契约和恢复弹窗影响提示。
- 仅串行任务支持从 segment 重翻；parallel 模式仍按独立分片失败恢复处理。
- 多文件边界和指定文件前重置记忆由 PROJ-001/PROJ-002 接入。

## 下一步建议

- 继续认领 `PROJ-001：有序多文件项目与跨文件记忆`。
- PROJ-001 需要放开多 TXT 文件、冻结文件顺序、在文件边界写 memory snapshot，并让 ordered project 的串行模式跨文件延续记忆。
