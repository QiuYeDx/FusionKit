# 工作包 PROJ-001：有序多文件项目与跨文件记忆

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：PROJ-001

## 本次实现内容

- `TextTranslationService.createTask()` 放开 `ordered_project` 模式下的多 TXT 文件创建，并按 request order 冻结文件顺序。
- 准备阶段逐文件读取、编码探测、解析和规划 segment；`globalIndex` 跨文件递增，`indexInFile` 保持文件内顺序。
- `files.ndjson` 保存冻结后的多文件索引；`units/<fileId>.ndjson` 仍按文件独立落盘。
- 串行模式跨文件共享 latest semantic memory；第二个文件的 prompt 可读取前一个文件提交后的 memory。
- 每个文件最后一个 segment 完成后写 `file_end` memory snapshot。
- 新增 `memoryResetFileOrders`，支持按冻结 order 在指定文件前重置语义记忆；同时保留 `memoryResetFileIds` 内部入口。
- 输出组装改为按文件分别生成输出；custom 输出目录会按 `relativePath` 还原子目录。
- Ordered project e2e 覆盖跨文件记忆延续、文件结束快照、相对目录输出和 reset 后不继承前文 memory。

## 修改文件

- `src/type/textTranslation.ts`
- `src/type/textTranslationIpc.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `TextTranslationOptions` 新增可选 `memoryResetFileIds?: string[]` 和 `memoryResetFileOrders?: number[]`。
- `validateCreateTextTranslationTaskIpcRequest()` 校验 memory reset 配置。
- `TextTranslationService` 的输出组装从单文件扩展为多文件，返回多个 outputPaths。
- 暂未新增 Renderer 交互；PROJ-002 将把排序、模式和重置点配置暴露到 UI。

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
- `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`：1 个测试文件、7 个测试通过。
- 核心文本翻译回归：12 个测试文件、72 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- Renderer 仍未开放多文件 ordered project 配置入口；由 PROJ-002 实现。
- 多文件目前限定 TXT 与 target-only；Markdown、双语输出由后续 MD/OUT 工作包接入。
- 文件完成后“先生成正式输出”当前在任务完成时按文件统一输出；如需运行中逐文件早落盘，可在性能/体验验收中继续细化。

## 下一步建议

- 继续认领 `PROJ-002：项目排序与高级小说配置 UI`。
- PROJ-002 需要让用户在页面中选择多个 TXT、确认自然排序/手动顺序、切换串行模式、填写术语/背景/风格和配置 memory reset 点。
