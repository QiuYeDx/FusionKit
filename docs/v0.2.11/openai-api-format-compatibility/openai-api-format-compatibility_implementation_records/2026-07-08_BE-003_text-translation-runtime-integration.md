# 工作包 BE-003：长文本翻译接入双格式 runtime

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`BE-003`

## 本次实现内容

- 将长文本翻译 service 的模型请求从旧 `sendOpenAICompatibleChatCompletion()` wrapper 切换为 `sendModelRuntimeText()`。
- 并行 TXT、并行 Markdown、顺序 TXT、顺序 Markdown 四个请求点均通过 runtime model DTO 选择 Chat Completions 或 Responses。
- 保留现有 marker text / Markdown / sequential protocol prompt 和 parser，不引入 Responses structured output 依赖。
- usage 映射切换为统一 `ModelRuntimeUsage`，workspace event 中仍只写入 input/output token 统计。
- 新增 TXT parallel target-only Responses E2E，验证长文本任务可通过 `/v1/responses` 完成翻译、写出结果、持久化 `apiFormat`，且不写入 API Key。

## 修改文件

- `electron/main/text-translation/text-translation-service.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 长文本翻译主进程 service 开始消费 `TextTranslationRuntimeModelConfig.apiFormat`。
- 业务调用结果仍沿用原有 segment result、Markdown result、workspace event 和 output assembly 结构。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/text-translation/service/textTranslationService.e2e.test.ts -t "Responses runtime adapter"
node_modules/.bin/vitest run test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts test/text-translation/service/textTranslationService.e2e.test.ts -t "Responses runtime adapter|ModelRuntimeClient|OpenAI Compatible client|text translation IPC contract|text translation domain contract"
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- 新增长文本 Responses E2E：1 个测试通过、同文件 14 个用例按 `-t` 跳过。
- 组合回归：5 个测试文件、31 个测试通过、14 个同文件用例按 `-t` 跳过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- 字幕翻译仍直接手写 axios Chat Completions 请求，尚未迁移到 runtime。
- 名称翻译仍未接入 Responses path。
- 长文本 Markdown/顺序模式已切 runtime，但本次只新增 TXT Responses E2E；完整矩阵留给后续 QA。

## 下一步建议

- 认领 `BE-004`：字幕翻译迁移到 `ModelRuntimeClient`，消除手写 axios 请求，并保留取消、空响应重试、checkpoint 和 LRC/SRT 解析行为。
