# 工作包 BE-002：Responses 非流式文本 adapter

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`BE-002`

## 本次实现内容

- 新增 Responses 非流式文本 adapter，并接入 `sendModelRuntimeText()` 的 `responses` 路由。
- 请求侧将 system 消息合并到 `instructions`，单轮 user 消息映射为字符串 `input`，多轮 user/assistant 消息映射为 input message array。
- Responses 请求默认发送 `store:false`，并使用 `max_output_tokens` 承接统一 `maxOutputTokens`。
- 支持 `responseFormat: "json_object"` 时发送 `text.format.type = "json_object"`。
- 响应侧优先解析 `output_text`，缺失时遍历 `output[].content[]` 中的文本字段。
- 映射 Responses usage：`input_tokens/output_tokens/total_tokens/output_tokens_details.reasoning_tokens`。
- 将 `status = "incomplete"` 且 `incomplete_details.reason = "max_output_tokens"` 映射为不可重试 `length_truncated`。
- 复用 Chat adapter 的错误分类口径：401/403 不重试，408/429/5xx 可重试，尊重 `Retry-After`，错误消息脱敏 API Key。

## 修改文件

- `electron/main/ai/adapters/responses-adapter.ts`
- `electron/main/ai/model-runtime-client.ts`
- `test/ai/modelRuntimeClient.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- `sendModelRuntimeText()` 现在对 `model.apiFormat = "responses"` 执行真实 Responses adapter。
- Responses adapter 返回统一 `ModelRuntimeTextResult`：
  - `content`
  - `usage`
  - `responseId`
  - `model`
  - `apiFormat = "responses"`
  - `rawStatus`

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/ai/modelRuntimeClient.test.ts
node_modules/.bin/vitest run test/text-translation/model/openAICompatibleClient.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `test/ai/modelRuntimeClient.test.ts`：1 个测试文件、7 个测试通过，覆盖 Chat token 参数、Responses `store:false`、`output_text`、`output[]` fallback、`incomplete` 截断、429 Retry-After 和 API Key 脱敏。
- `test/text-translation/model/openAICompatibleClient.test.ts`：1 个测试文件、8 个旧 Chat wrapper 测试通过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

## 调研来源

- OpenAI Responses create API reference：`https://developers.openai.com/api/reference/resources/responses/methods/create`

## 未完成事项

- 长文本翻译 service 仍通过旧 wrapper 走 Chat path，尚未根据 runtime DTO 选择 `sendModelRuntimeText()`。
- 字幕翻译、名称翻译和设置页 UI 尚未接入 Responses 能力。
- Responses adapter 暂未实现流式输出、工具调用、状态化会话或 provider capability fallback。

## 下一步建议

- 认领 `BE-003`：长文本翻译 service 接入 `sendModelRuntimeText()`，让 `TextTranslationRuntimeModelConfig.apiFormat` 真正决定 Chat/Responses 请求路径，并新增 Responses 长文本 E2E 覆盖。
