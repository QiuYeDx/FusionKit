# 工作包 BE-001：ModelRuntimeClient 与 Chat Completions adapter

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`BE-001`

## 本次实现内容

- 新增 `ModelRuntimeClient` 文本调用入口 `sendModelRuntimeText()`，按 `model.apiFormat` 路由 adapter。
- 新增统一 runtime 错误模型 `ModelRuntimeClientError`、错误码与重试配置类型。
- 新增 Chat Completions adapter，复用旧客户端的重试、HTTP 错误分类、Retry-After、timeout、abort、API Key 脱敏、think 清理、usage 映射和截断/空响应处理逻辑。
- Chat adapter 使用 `normalizeModelEndpoint().chatCompletionsUrl`，兼容 base URL 与历史 `/chat/completions` full endpoint 输入。
- Chat adapter 支持 `outputTokenParameter`，确保 `max_tokens` 与 `max_completion_tokens` 二选一发送。
- 保留旧 `sendOpenAICompatibleChatCompletion`、`OpenAICompatibleClientError`、`cleanThinkTags` export，内部委托新 runtime，并固定旧 wrapper 继续发送 `max_tokens` 以保持历史行为。
- `sendModelRuntimeText()` 对 `responses` 暂时返回 `unsupported_api_format`，为 `BE-002` 明确留出 adapter 接口。

## 修改文件

- `electron/main/ai/model-runtime-client.ts`
- `electron/main/ai/model-runtime-errors.ts`
- `electron/main/ai/adapters/chat-completions-adapter.ts`
- `electron/main/ai/openai-compatible-client.ts`
- `test/ai/modelRuntimeClient.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 新增 `ModelRuntimeTextRequest`：
  - `model.apiFormat`
  - `messages`
  - `temperature`
  - `maxOutputTokens`
  - `responseFormat`
  - `timeoutMs/signal/proxy/retry`
- 新增 `ModelRuntimeTextResult`，统一返回 `content/usage/finishReason/responseId/model/apiFormat`。
- 新增 `ModelRuntimeClientError`，错误码覆盖 Chat/Responses runtime 共用分类。
- 旧 `OpenAICompatible*` 类型和函数仍保留，作为 Chat Completions 兼容 wrapper。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `test/ai/modelRuntimeClient.test.ts` 与 `test/text-translation/model/openAICompatibleClient.test.ts`：2 个测试文件、12 个测试通过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- Responses 非流式文本 adapter 尚未实现。
- 长文本、字幕、名称翻译业务调用面尚未直接消费 `sendModelRuntimeText()` 的 Responses path。
- 现有旧 wrapper 仍固定以 Chat Completions 语义运行，这是为了保证旧调用兼容。

## 下一步建议

- 认领 `BE-002`：实现 Responses 非流式文本 adapter，支持 `instructions/input/max_output_tokens/store:false` 请求、`output_text/output[]` 解析、usage 映射、incomplete 截断、HTTP 错误分类和 fake server 覆盖。
