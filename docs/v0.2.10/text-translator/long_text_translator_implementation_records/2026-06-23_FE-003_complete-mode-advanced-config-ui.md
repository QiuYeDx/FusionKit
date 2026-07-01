# 工作包 FE-003：完整模式与高级配置 UI

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：FE-003

## 本次实现内容

- 配置面板补充执行模式说明，区分快速并发与连贯串行在速度、质量连续性和费用上的差异。
- 新增动态上下文预算摘要，展示默认模型上下文、预计需求和输出预留 token。
- Renderer 在准备任务前执行同源预算校验，超过默认模型上下文窗口时禁用准备并给出明确错误。
- 准备任务时复用同一份 `outputTokenReserve` 计算结果，避免 UI 展示和提交参数不一致。
- 四语言 `text` namespace 新增执行模式说明、预算摘要和预算超限错误文案。

## 修改文件

- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 无新增 IPC 或持久化 schema。
- Renderer 复用 `estimateTextTranslationRequiredContextTokens()` 和默认模型上下文窗口做提交前校验。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/output/markdownOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 924 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- 核心文本翻译回归：14 个测试文件、93 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- Markdown parser/output assembler 已完成，但端到端 Markdown 执行入口仍未开放。
- 未做浏览器截图级视觉验证；当前通过 i18n、类型、核心回归和 build 验证。

## 下一步建议

- 继续认领 `FE-004：批量独立文件任务与队列体验`。
- FE-004 应让多个独立 TXT 文件能拆成多个任务排队执行，并在 UI 中展示队列状态与公平调度结果。
