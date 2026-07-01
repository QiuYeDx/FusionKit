# 工作包 MEM-001：语义记忆模型、预算与快照

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：MEM-001

## 本次实现内容

- 新增 `SemanticMemory` 结构，包含 schemaVersion、version、updatedAfterSegmentId、文档/章节/场景摘要、人物、术语、风格规则、未决上下文和近期连贯性备注。
- 新增初始记忆创建逻辑：用户 glossary 转换为 `origin: "user"` 术语，文档背景写入长期概要，风格指令写入显式风格规则。
- 新增语义记忆 token 估算和 effective budget 解析，按 Final Design 公式扣除系统指令、glossary、当前 segment、近期窗口、输出预留和安全边距。
- 新增语义记忆预算裁剪：保留用户术语和显式风格规则，优先裁剪模型术语、长期概要、人物、低优先级近期备注和未决上下文；预算仍不足时返回 `overBudget`，不静默删除用户约束。
- 新增 `SemanticMemoryManager`，负责初始化 latest、加载 latest、提交新版本和按 periodic/file_end/pre_compression 写快照。
- 版本提交按 latest 的稳定整数版本单调递增，忽略调用方传入的旧 version。
- 工作区 Repository 增加 `readMemorySnapshot()`，用于恢复和测试读取快照。

## 修改文件

- `electron/main/text-translation/memory/semantic-memory.ts`
- `electron/main/text-translation/memory/memory-budget.ts`
- `electron/main/text-translation/memory/semantic-memory-manager.ts`
- `electron/main/text-translation/persistence/workspace-repository.ts`
- `test/text-translation/memory/semanticMemoryManager.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增主进程内部数据结构 `SemanticMemory`、`SemanticMemoryTerminologyEntry`、`SemanticMemoryCharacter`。
- 新增 `resolveSemanticMemoryBudget()`、`estimateSemanticMemoryTokens()`、`trimSemanticMemoryToBudget()`。
- 新增 `SemanticMemoryManager.initialize/loadLatest/commit()` 和 `createSemanticMemorySnapshotId()`。
- `TextTranslationWorkspaceRepository` 新增 `readMemorySnapshot<TMemory>()`。
- 暂无 Renderer/IPC 契约变化；模型 patch schema、冲突 warning 和压缩请求由 MEM-002 接入。

## 验证结果

执行命令：

```text
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/memory/semanticMemoryManager.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vitest run test/text-translation/memory/semanticMemoryManager.test.ts`：1 个测试文件、5 个测试通过。
- 核心文本翻译回归：11 个测试文件、63 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 尚未接入模型返回的 `SemanticMemoryPatch` schema、冲突过滤、合并 warning 和压缩请求。
- 尚未把语义记忆接入串行 executor；当前仅完成可复用的本地模型、预算和快照层。
- 当前 `styleRules` 暂不区分用户来源和模型来源，因此裁剪时整体保留；MEM-002 若允许模型追加风格规则，可继续细化来源或数量上限。

## 下一步建议

- 继续认领 `MEM-002：记忆 Patch 协议、合并与压缩`。
- MEM-002 应复用 PRE-003 的结构化协议结论，先实现受限 patch schema 和本地合并，再加入 90% 阈值压缩前快照与失败回退。
