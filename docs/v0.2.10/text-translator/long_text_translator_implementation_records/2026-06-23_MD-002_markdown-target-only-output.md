# 工作包 MD-002：Markdown 仅译文输出

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：MD-002

## 本次实现内容

- 新增 `markdown-output-assembler.ts`，提供 Markdown target-only 输出组装。
- 基于 MD-001 的 `TranslationUnit.sourceStart/sourceEnd` 建立 replacement 列表，并从后向前替换，避免 offset 漂移。
- 组装时检查 replacement range 是否越界或重叠，缺失/stale unit 结果会阻止输出。
- 支持在写入前还原 unit 译文中的保护占位符。
- 新增 `writeMarkdownTargetOnlyOutput`，复用现有目标路径解析和 UTF-8 原子写入。
- 新增 Markdown 输出单测，覆盖 link label、image alt、列表、表格单元格、emoji offset、占位符恢复、missing/stale/overlap 防护、UTF-8 写盘和输出可被 Markdown parser 重解析。

## 修改文件

- `electron/main/text-translation/output/markdown-output-assembler.ts`
- `test/text-translation/output/markdownOutputAssembler.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `assembleMarkdownTargetOnlyContent()`：
  - 输入原始 Markdown、`TranslationUnit[]` 和 unit 级译文结果。
  - 输出保持未替换字符原样的 target-only Markdown。
- 新增 `MarkdownUnitTranslationResult`：
  - `unitId` 对应 `TranslationUnit.unitId`。
  - `translatedText` 是该 unit 的译文。
  - `placeholders` 可选，用于写入前恢复受保护内容。
- 当前仍是输出组装层能力；主进程执行链路尚未把模型 segment 结果拆回 Markdown unit 结果。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/output/markdownOutputAssembler.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/output/markdownOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 915 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- `test/text-translation/output/markdownOutputAssembler.test.ts`：5 个测试通过。
- 核心文本翻译回归：14 个测试文件、89 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- Markdown 尚未接入 `TextTranslationService` 的端到端执行链路。
- Markdown 双语 blockquote 输出不在本包范围内，由 MD-003 继续。

## 下一步建议

- 继续认领 `MD-003：Markdown 引用块双语输出`。
- MD-003 应实现原块不变、译文 blockquote 插入，覆盖标题、段落、列表、嵌套引用和表格整体译文引用块。
