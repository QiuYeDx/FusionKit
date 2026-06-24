# Fix：Markdown 端到端执行链路缺口

> 日期：2026-06-24
> Feature Slug：`long_text_translator`
> 类型：实现缺口 / 计划修正
> 关联文档：
> - `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
> - `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`

## 背景

Final Design 明确要求长文本翻译支持 `.txt` 和 `.md` 文件，并要求 Markdown 保持代码、URL、frontmatter、HTML 等结构不被破坏，同时支持仅译文和 blockquote 双语输出。

2026-06-24 复核发现，当前实现只开放了 TXT 端到端执行：

- Renderer 文件选择和拖拽只接受 `.txt`。
- `TextTranslationService.createTask()` 对非 TXT 文件返回 `not_implemented`。
- `prepareTask()` 固定调用 `parseTxtTranslationUnits()`。
- `writeTaskOutputs()` 固定调用 `writeTxtOutput()`。

同时，`MD-001` 至 `MD-003` 已完成 Markdown parser、保护占位符、Markdown 仅译文输出组装和 blockquote 双语输出组装，但这些模块尚未接入主进程执行链路、恢复链路和 UI。

## 根因

Execution Plan 将 Markdown 工作拆成了：

1. `MD-001`：Markdown Parser 与保护占位符。
2. `MD-002`：Markdown 仅译文输出。
3. `MD-003`：Markdown 引用块双语输出。

这三个工作包覆盖的是“解析与输出组装模块”，没有单独拆出“Markdown 端到端执行接入”工作包。后续 `FE-004` 的实施范围写有“多选 TXT/MD”，但实际实现和发布文案都保留为 TXT Beta，导致台账出现“模块已完成、端到端未开放”的口径漂移。

## 目标行为

补齐后，长文本翻译应具备：

1. Renderer 可选择 `.txt`、`.md`、`.markdown` 文件。
2. 主进程按文件格式选择 TXT parser 或 Markdown parser。
3. Markdown target-only 输出按 `unitId` 回填可翻译源码范围。
4. Markdown bilingual 输出按 top-level block 插入译文 blockquote。
5. Markdown 代码块、inline code、URL、link/image destination、frontmatter、HTML 等保护内容不发送为自然语言译文，也不会被最终输出改写。
6. Markdown 任务支持并发、串行、恢复、取消、部分完成和 stale 语义。
7. README/CHANGELOG 不再宣称 Markdown 端到端入口未开放。

## 新增工作包

Execution Plan 已新增以下补漏工作包：

- `MD-004`：Markdown 执行协议与结果映射。
- `MD-005`：主进程 Markdown parallel 端到端接入。
- `MD-006`：Markdown 串行记忆、恢复与 stale 接入。
- `FE-005`：Renderer Markdown 文件开放与 Beta 提示。
- `QA-MD-001`：Markdown E2E 自动化与恢复验收。
- `DOC-MD-001`：Markdown 发布文档同步。

## 影响文件

预计涉及：

- `electron/main/text-translation/text-translation-service.ts`
- `electron/main/text-translation/model/translation-response-protocol.ts`
- `electron/main/text-translation/parsing/markdown-parser.ts`
- `electron/main/text-translation/parsing/protected-placeholders.ts`
- `electron/main/text-translation/output/markdown-output-assembler.ts`
- `electron/main/text-translation/persistence/workspace-repository.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/*/text.json`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `test/text-translation/output/markdownOutputAssembler.test.ts`
- `test/text-translation/protocol/*`
- `README.md`
- `CHANGELOG.md`

## 验证要求

补齐后至少运行：

```text
pnpm exec vitest run test/text-translation/protocol test/text-translation/output/markdownOutputAssembler.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run test/text-translation
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

Markdown E2E 验收必须覆盖：

- 单个 `.md` parallel target-only。
- 单个 `.md` parallel bilingual blockquote。
- `.md` sequential_context 至少两个 segment，确认记忆延续和恢复。
- Markdown source changed/missing 时使用冻结 workspace source 恢复输出。
- protected placeholder 缺失、重复、未知、乱序时不写入正式结果。
- 代码块、frontmatter、HTML、URL、link/image destination 输出保持不变。

## 实施进展

- 2026-06-24：`MD-004` 已完成，新增 Markdown target-only `unitId -> translatedText`、bilingual `blockId -> translatedMarkdown` 边界协议、placeholder 完整性校验、sequential `memoryPatch` 共存解析和协议单测。
- 2026-06-24：`MD-005` 已完成，主进程 parallel 模式已支持 `.md/.markdown` prepare、冻结 normalized source、placeholder-safe segment payload、结构化结果增量落盘、target-only/bilingual 输出和 source missing resume；同时修复 Markdown unit 协议错误裁掉边界空格的问题。
- 2026-06-24：`MD-006` 已完成，Markdown `sequential_context` 已接入严格顺序、语义记忆版本、resume、retranslate stale、placeholder 加强重试和 memory patch 降级边界；ordered project 明确支持 TXT/Markdown 混合格式共享记忆。

## 后续建议

下一轮实现优先认领 `FE-005`，开放 Renderer 的 `.md/.markdown` 文件选择、拖拽和批量/ordered project 入口，并同步 Markdown Beta、资源限制和复杂结构检查提示。
