# 工作包 AGENT-002：HomeAgent Responses 工具循环 adapter

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`AGENT-002`

## 本次实现内容

- 新增 `ResponsesAgentAdapter`，在 HomeAgent 中支持 Responses API 的流式文本、function call 参数聚合、tool execution、`function_call_output` 回填和多步工具循环。
- 新增 Agent runtime 内部 stream part 类型，让 Chat Completions adapter 和 Responses adapter 都返回统一 `fullStream` / `usage` 形态；Chat Completions path 仍继续使用 AI SDK `streamText` 与 `@ai-sdk/openai-compatible`。
- `orchestrator` 按 `ModelProfile.apiFormat` 分流：`chat_completions` 走 AI SDK Chat adapter，`responses` 走 direct Responses adapter；后续 UI 状态机、工具结果提交和 usage 统计保持统一消费逻辑。
- Responses 工具参数通过 AI SDK schema helper 转为 JSON Schema，执行前再经过 schema 校验，保留 zod 默认值与约束。
- Agent API 格式能力检查解除 Responses 临时阻止，设置页和 HomeAgent 的既有能力门禁随之允许 Responses profile。
- 增加 Responses Agent adapter 单测，覆盖 endpoint normalization、历史函数调用输入重建、普通文本流、函数调用、tool result 回填下一轮和 usage。

## 修改文件

- `src/agent/runtime/responses-agent-adapter.ts`
- `src/agent/runtime/responses-agent-adapter.test.ts`
- `src/agent/runtime/types.ts`
- `src/agent/runtime/chat-completions-agent-adapter.ts`
- `src/agent/orchestrator.ts`
- `src/agent/types.ts`
- `src/agent/api-format-capability.ts`
- `src/agent/api-format-capability.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 新增内部类型：
  - `AgentRuntimeStreamPart`
  - `AgentRuntimeTurnResult`
  - `AgentRuntimeUsage`
- 新增内部 adapter：
  - `ResponsesAgentAdapter.streamTurn()`
  - `resolveResponsesAgentUrl()`
  - `buildResponsesInput()`
- `AgentToolCall` 增加可选 `responseItemId`，用于 Responses 历史上下文重建；该字段不包含 API Key、endpoint 或请求体敏感信息。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/agent/runtime
node_modules/.bin/vitest run src/agent
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run src/agent src/store/useModelStore.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts src/lib/model-endpoint.test.ts src/services/rename/nameTranslationPlanner.test.ts test/ai/modelApiFormatProbe.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts
node scripts/check-i18n.mjs
git diff --check
```

结果：

- `node_modules/.bin/vitest run src/agent/runtime`：2 files、10 tests passed。
- `node_modules/.bin/vitest run src/agent`：9 files、51 tests passed。
- `node_modules/.bin/tsc --noEmit`：通过。
- 回归矩阵：20 files、141 tests passed。
- `node scripts/check-i18n.mjs`：通过，zh/en/ja/zh-Hant key 数一致。
- `git diff --check`：通过。

## 未完成事项

- 本次未启动 Vite/Electron 服务，也未做真实 OpenAI Responses profile 的 Electron 手工验收。
- Responses Agent 当前使用 renderer-side `fetch`，与既有 HomeAgent Chat path 的 renderer-side AI SDK 调用保持一致；如后续要统一代理能力，可新增主进程 Agent runtime IPC facade。

## 下一步建议

- 认领 `QA-001`：收口双格式自动化回归矩阵，确认 Chat/Responses 在 Agent、任务型翻译、字幕、名称翻译上的关键成功/失败路径。
- 后续 `QA-002` 使用真实 OpenAI Responses、OpenAI Chat、DeepSeek Chat 和一个 Other Chat endpoint 做 Electron 手工验收，验收记录不得包含 API Key。
