# 工作包 BE-006：TXT 仅译文输出组装器

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：BE-006

## 本次实现内容

- 新增 TXT target-only 输出组装器。
- 按 `globalIndex` / `indexInFile` 稳定排序 segment。
- 缺失 segment result 或 stale result 会阻止正式输出组装。
- 使用 `startsMidUnit` / `endsMidUnit` 判断段内硬切，硬切上下片之间不插入额外空行。
- 普通 segment 间使用稳定 `\n\n` 分隔。
- 支持默认输出命名：`chapter.txt -> chapter.zh.txt`。
- 支持 `source` / `custom` 输出目录。
- 支持 `index` 冲突策略，自动生成 `name (1).ext`。
- 支持 `overwrite` 冲突策略，但仍禁止输出路径覆盖源文件。
- 使用临时文件写入后 rename，输出 UTF-8 无 BOM。

## 修改文件

- `electron/main/text-translation/output/text-output-assembler.ts`
- `test/text-translation/output/textOutputAssembler.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `TextTranslationSegmentResult`。
- 新增 `AssembleTxtTargetOnlyOptions`。
- 新增 `ResolveTxtOutputPathOptions`。
- 新增 `WriteTxtTargetOnlyOutputOptions`。
- 新增 `WriteTxtTargetOnlyOutputResult`。
- 新增 `assembleTxtTargetOnlyContent()`。
- 新增 `resolveTxtOutputPath()`。
- 新增 `writeTxtTargetOnlyOutput()`。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/output/textOutputAssembler.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/output/textOutputAssembler.test.ts`：1 个测试文件、4 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts`：9 个测试文件、55 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- BE-006 只消费可信 segment results；BE-007 负责真实模型请求、结果写入工作区和最终调用输出组装器。
- TXT 双语输出不在本包范围内，后续由 OUT-001 实现。

## 下一步建议

- 继续认领 `BE-007：单文件并发执行垂直切片`。
- BE-007 应把 BE-001 至 BE-006 串起来，使用 fake server 做主进程端到端验证。
- 端到端任务应保证完成 segment 立即写入 `results/` 和 `events.ndjson`，不能只存在内存中。
