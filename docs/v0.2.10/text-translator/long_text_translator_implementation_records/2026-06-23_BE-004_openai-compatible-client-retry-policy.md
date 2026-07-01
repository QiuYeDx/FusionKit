# 工作包 BE-004：通用模型客户端与重试策略

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：BE-004

## 本次实现内容

- 新增 `electron/main/ai/openai-compatible-client.ts`，作为长文本翻译可复用的 OpenAI Compatible Chat Completions 请求层。
- 支持 endpoint 归一化、Authorization、任务模型、messages、temperature、`max_tokens`、timeout、AbortSignal 和 axios proxy 配置。
- 默认复用现有 `getAxiosProxyConfig()`；调用方也可显式传入 `proxy` 覆盖。
- 实现稳定错误类型 `OpenAICompatibleClientError`，包含 code、retryable、status、retryAfterMs、attempt。
- 实现 408/429/5xx、timeout、网络错误、空响应、`finish_reason=length` 的可重试分类。
- 实现 401/403、abort 的不可重试分类。
- 尊重 `Retry-After`，否则使用指数退避、最大延迟和 jitter；测试可将 jitter 设为 0。
- 解析 `message.content`、`reasoning_content`、finish reason、usage 和 reasoning tokens。
- 清理响应开头 `<think>...</think>`，避免 reasoning 文本混入译文。
- HTTP 错误 body 和网络错误 message 均对 API Key 做脱敏。
- 新增 fake server 单测，覆盖成功请求、Authorization、usage、429 重试、401 不重试与脱敏、空响应/length 重试、abort 和 timeout。

## 修改文件

- `electron/main/ai/openai-compatible-client.ts`
- `test/text-translation/model/openAICompatibleClient.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `OpenAICompatibleChatMessage`、`OpenAICompatibleChatRequest`、`OpenAICompatibleRetryOptions`。
- 新增 `OpenAICompatibleUsage`、`OpenAICompatibleChatResult`。
- 新增 `OpenAICompatibleClientErrorCode` 和 `OpenAICompatibleClientError`。
- 新增 `sendOpenAICompatibleChatCompletion(request)`。
- 新增 `cleanThinkTags(text)`。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/model/openAICompatibleClient.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/model/openAICompatibleClient.test.ts`：1 个测试文件、7 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts`：7 个测试文件、46 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- 字幕翻译仍使用原有 axios 逻辑；执行计划已将“是否同步迁移字幕客户端”标记为非阻塞，本包不强制迁移。
- BE-004 只提供请求层，不负责占位符协议、串行 memory patch 解析或调度槽位管理。

## 下一步建议

- 继续认领 `BE-005：全局公平请求调度器`。
- BE-005 应把 429 重试等待期间释放执行槽位作为核心行为之一，避免等待中的请求长期占用全局并发。
- BE-007 接入时应把 `OpenAICompatibleClientError` 映射为任务/segment 结构化错误。
