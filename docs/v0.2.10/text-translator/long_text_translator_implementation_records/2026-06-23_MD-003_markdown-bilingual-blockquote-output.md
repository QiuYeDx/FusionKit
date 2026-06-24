# 工作包 MD-003：Markdown 引用块双语输出

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：MD-003

## 本次实现内容

- 在 `markdown-output-assembler.ts` 中新增 Markdown 双语 blockquote 输出能力。
- 新增 `collectMarkdownBilingualBlocks()`，只收集顶层可翻译 block；frontmatter、代码、HTML、thematic break 等保护块不会生成空译文块。
- 新增 `assembleMarkdownBilingualContent()`，保持原始 block 不变，在 block 结束位置插入译文 blockquote。
- 普通标题、段落、列表、表格译文使用一层 `>`；原 blockquote 的译文使用比原文更深一层的引用深度。
- 双语插入从后向前应用，避免 offset 漂移。
- 使用 PRE-002 的 `complex-bilingual-expected.md` 作为精确 fixture，验证标题、段落、列表、嵌套引用、表格整体译文引用块输出完全一致。
- 新增缺失/stale block translation 防护和保护块不插入空译文测试。

## 修改文件

- `electron/main/text-translation/output/markdown-output-assembler.ts`
- `test/text-translation/output/markdownOutputAssembler.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `MarkdownBilingualBlock`：
  - 描述顶层可翻译 Markdown block 的 `blockId`、node type、occurrence、source range 和译文 quote depth。
- 新增 `MarkdownBlockTranslationResult`：
  - 以 `blockId` 匹配译文 Markdown。
  - 支持 `stale` 和可选 placeholder 恢复。
- 新增 `assembleMarkdownBilingualContent()`：
  - 输入原始 Markdown 和 block 级译文。
  - 输出原 block + 译文 blockquote 的双语 Markdown。

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
- `test/text-translation/output/markdownOutputAssembler.test.ts`：9 个测试通过。
- 核心文本翻译回归：14 个测试文件、93 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- Markdown parser/output assembler 已完成，但 `TextTranslationService` 尚未把 Markdown 接入端到端执行链路。
- 当前双语 assembler 接收 block 级译文，后续接 service 时需要把模型请求/响应协议映射到 block translation result。

## 下一步建议

- 继续认领 `FE-003：完整模式与高级配置 UI`。
- FE-003 应收口 Renderer 可见配置，确保格式、输出模式、串行/并发、有序项目、token 预算、glossary、背景和风格配置在页面中表达一致。
