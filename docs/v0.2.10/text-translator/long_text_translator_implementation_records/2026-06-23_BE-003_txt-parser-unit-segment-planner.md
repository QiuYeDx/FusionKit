# 工作包 BE-003：TXT Parser、Unit 与 Segment Planner

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：BE-003

## 本次实现内容

- 新增主进程内部结构类型 `TranslationUnit`、`TranslationSegment` 和 `CountTextTokens`。
- 新增 `token-counter.ts`，默认使用 `gpt-tokenizer` 精确计数，异常时回退到字符数估算。
- 新增 `text-parser.ts`，将规范化 TXT 按空行解析成自然块，连续非空行保留为同一段落。
- 增加章节/标题识别，覆盖英文 `Chapter/Part/Book/Volume` 和中文 `第...章/节/卷/部/回` 等常见形式。
- 对超预算自然段按句子标点、换行和最终硬切降级拆分，并在 `structuralContext` 中记录 split parent、part index/count 和 hardCut。
- 新增 `segment-planner.ts`，按稳定 unit 顺序规划 segment，生成 `segmentId`、`indexInFile`、`globalIndex`、`unitIds`、`sourceTokenCount`、相对 `sourceTextSnapshotPath` 和 split 边界标记。
- Segment 预算会计算 unit 拼接时的 `\n\n` 开销，避免最终发送文本超过预算。
- 新增 parser/planner 单测，覆盖 offset、标题识别、句子拆分、硬切、token 上限、source snapshot path 和 deterministic 输出。

## 修改文件

- `electron/main/text-translation/types.ts`
- `electron/main/text-translation/parsing/text-parser.ts`
- `electron/main/text-translation/planning/token-counter.ts`
- `electron/main/text-translation/planning/segment-planner.ts`
- `test/text-translation/planning/textParserSegmentPlanner.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `TranslationUnitKind`、`TranslationUnit`、`TranslationSegment`、`CountTextTokens`。
- 新增 `parseTxtTranslationUnits(options)`。
- 新增 `countTextTokens(text)` 与 `estimateTextTokens(text)`。
- 新增 `planTranslationSegments(options)`，支持 `startingGlobalIndex` 与可注入 `countTokens`。
- `sourceTextSnapshotPath` 当前为相对路径，例如 `segments/source/00000005.txt`；正式写入由 BE-007 调用 Repository 完成。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/planning/textParserSegmentPlanner.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/planning/textParserSegmentPlanner.test.ts`：1 个测试文件、5 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts`：6 个测试文件、39 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- BE-003 尚未把 units/segments 写入 BE-001 Repository；BE-007 组装任务准备流程时接入。
- Markdown parser 不在本包范围内，后续由 MD-001 实现。

## 下一步建议

- 继续认领 `BE-004：通用模型客户端与重试策略`。
- BE-004 应直接复用 PRE-003 的 fake server 测试思路，覆盖 timeout、429/Retry-After、5xx、401/403、abort、空响应、finish_reason=length 和 think 标签清理。
- 新客户端不得记录 API Key、Authorization 或完整正文。
