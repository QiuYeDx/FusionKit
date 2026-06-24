# 工作包 MD-001：Markdown Parser 与保护占位符

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：MD-001

## 本次实现内容

- 新增正式 `markdown-parser.ts`，使用 `unified + remark-parse + remark-gfm + remark-frontmatter` 解析 Markdown AST。
- 输出 `TranslationUnit[]`，可翻译范围基于 mdast `position.start.offset` / `position.end.offset`，与源字符串 UTF-16 code unit offset 保持一致。
- 可翻译内容覆盖 heading、paragraph、list item、blockquote、table cell、link label、image alt。
- 保护 frontmatter、fenced/indented code、inline code、HTML、definition、thematic break、autolink、link/image destination。
- 图片 alt 使用小型 bracket scanner 定位源码 span，支持转义符和嵌套方括号，不替换整个 image 节点，也不触碰图片地址。
- 为 list / quote / table 添加结构上下文，给后续 Markdown 输出组装保留 block 归属信息。
- 新增 `protected-placeholders.ts`，支持保护 span 替换为 `⟦FKP:segmentId:0001⟧`、校验数量/未知 token/顺序、以及恢复原文。
- 新增正式 parser/placeholder 单测，覆盖 GFM、frontmatter、代码、URL、HTML、link/alt、source offset、placeholder 校验失败和重叠 span 拒绝。

## 修改文件

- `electron/main/text-translation/parsing/markdown-parser.ts`
- `electron/main/text-translation/parsing/protected-placeholders.ts`
- `test/text-translation/parsing/markdownParser.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `parseMarkdownTranslationUnits()`：
  - 输入已规范化换行的 Markdown 字符串和 `fileId`。
  - 返回 `units`、`protectedSpans` 和 `ast`。
  - `units` 使用现有 `TranslationUnit` 契约，不新增共享 domain 类型。
- 新增 `collectMarkdownTranslatableSpans()` 和 `collectMarkdownProtectedSpans()`，供 MD-002/MD-003 输出组装复用。
- 新增 `applyProtectedPlaceholders()` / `validateProtectedPlaceholders()` / `restoreProtectedPlaceholders()`，供后续模型请求前后校验复用。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/parsing/markdownParser.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 915 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- `test/text-translation/parsing/markdownParser.test.ts`：7 个测试通过。
- 核心文本翻译回归：13 个测试文件、84 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 本包只落正式 parser 和 placeholder 契约，Markdown 尚未接入 `TextTranslationService` 的端到端执行链路。
- Markdown 仅译文组装、双语引用块组装和真实输出写盘由 MD-002/MD-003 继续。

## 下一步建议

- 继续认领 `MD-002：Markdown 仅译文输出`。
- MD-002 应基于 `TranslationUnit.sourceStart/sourceEnd` 从后向前替换可翻译范围，验证 link label、image alt、列表、表格单元格可替换，同时保护 URL、代码、frontmatter 和 HTML 不变。
