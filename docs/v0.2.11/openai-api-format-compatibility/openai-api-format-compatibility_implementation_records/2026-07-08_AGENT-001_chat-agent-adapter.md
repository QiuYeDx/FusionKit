# 工作包 AGENT-001：AgentRuntime Chat adapter 收口

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`AGENT-001`

## 本次实现内容

- 新增 `ChatCompletionsAgentAdapter`，把 HomeAgent 当前基于 AI SDK `streamText` + `@ai-sdk/openai-compatible` 的 Chat Completions 路径收口到独立 adapter。
- `orchestrator` 改为调用 adapter 的 `streamTurn()`，保留原有 system prompt、工具集合、step limit、温度、输出 token 上限、abort signal 和 fullStream 事件处理逻辑。
- adapter 内部通过 `normalizeModelEndpoint()` 派生 AI SDK provider 的 base URL，兼容 base URL、历史 `/chat/completions` endpoint 和 `/responses` endpoint 输入。
- 增加 adapter endpoint normalization 单测，为后续 `ResponsesAgentAdapter` 留出稳定对照边界。

## 修改文件

- `src/agent/runtime/chat-completions-agent-adapter.ts`
- `src/agent/runtime/chat-completions-agent-adapter.test.ts`
- `src/agent/orchestrator.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 无持久化结构变化。
- 新增内部 adapter：
  - `ChatCompletionsAgentAdapter.streamTurn()`
  - `resolveChatCompletionsAgentBaseUrl()`

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/agent/runtime/chat-completions-agent-adapter.test.ts src/agent
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `node_modules/.bin/vitest run src/agent/runtime/chat-completions-agent-adapter.test.ts src/agent`：8 files、44 tests passed。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- `AGENT-001` 只收口 Chat Completions path，不实现 Responses function call、tool result、streaming delta、usage 和 step loop。
- HomeAgent 使用 Responses profile 的启动限制仍保留，直到 `AGENT-002` 完成。
- 本次未启动 Vite/Electron 服务进行视觉验收。

## 下一步建议

- 认领 `AGENT-002`：实现 `ResponsesAgentAdapter`，覆盖普通对话、至少一个无破坏性工具预览流程、取消和错误路径。
