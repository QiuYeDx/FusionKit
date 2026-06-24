# 工作包 MEM-002：记忆 Patch 协议、合并与压缩

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：MEM-002

## 本次实现内容

- 新增正式 `SemanticMemoryPatch` schema，落地 PRE-003 的受限 patch 协议。
- Patch 仅允许替换文档/章节/场景摘要、upsert 人物、upsert 模型术语、追加风格规则/未决上下文/近期连贯性备注，以及按内容 resolve 未决上下文。
- Patch 使用 strict schema，不允许模型提交 `schemaVersion`、`version`、术语 `origin` 或任意 JSON Patch 路径。
- 新增 patch 解析函数；非法 JSON 或 schema 失败会返回 `invalid_memory_patch` warning。
- 新增本地合并函数；模型术语与用户 glossary 冲突时保留用户术语并返回 `user_terminology_conflict` warning。
- `SemanticMemoryManager.applyPatch()` 现在可以从 latest 读取稳定记忆，非法 patch 不写 latest，合法 patch 合并后统一走版本提交。
- 新增 90% 阈值压缩判断；达到阈值时先写 `pre_compression` 快照。
- 压缩成功时提交压缩后的记忆并递增 version；压缩失败时保留原 latest，不污染稳定恢复链，并返回缩短近期备注后的 fallback memory 供后续请求降级使用。

## 修改文件

- `electron/main/text-translation/memory/memory-patch.ts`
- `electron/main/text-translation/memory/semantic-memory-manager.ts`
- `test/text-translation/memory/semanticMemoryPatch.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增主进程内部类型 `SemanticMemoryPatch`、`SemanticMemoryWarning`。
- 新增 `parseSemanticMemoryPatch()`、`applySemanticMemoryPatch()`、`createCompressionFailureFallbackMemory()`。
- `SemanticMemoryManager` 新增 `applyPatch()`，返回 `updated`、warnings、compressionStatus、preCompressionSnapshotId 和可选 fallbackMemory。
- 新增 `analyzeSemanticMemoryCompression()`，默认使用 90% 阈值判断是否需要压缩。
- 暂无 Renderer/IPC 契约变化；串行模型请求和响应解析由 MEM-003 接入。

## 验证结果

执行命令：

```text
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm exec tsc --noEmit`：通过。
- memory 定向测试：2 个测试文件、10 个测试通过。
- 核心文本翻译回归：12 个测试文件、68 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 尚未把串行模型响应线协议接入执行器；当前只完成受限 patch 与 manager 更新入口。
- 压缩器目前通过注入函数提供，真实压缩请求 prompt、模型调用和失败重试由 MEM-003/MEM-004 或后续细化接入。
- 用户术语冲突 warning 目前停留在主进程内部返回值，尚未接入 Renderer 展示。

## 下一步建议

- 继续认领 `MEM-003：连贯串行 Executor 与恢复`。
- MEM-003 需要将 OpenAI Compatible client、动态边界协议、`SemanticMemoryManager.applyPatch()` 和工作区事件串起来，确保每片记录输入/输出 memoryVersion 并支持中断恢复。
