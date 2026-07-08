# OpenAI 新旧 API 格式兼容 Final Design

> 日期：2026-07-08
> Feature Slug：`openai-api-format-compatibility`
> 版本：`v0.2.11`
> 状态：设计已收敛，Execution Plan 已建立；`PRE-001`、`CORE-001`、`CORE-002`、`BE-001`、`BE-002`、`BE-003`、`BE-004`、`BE-005`、`FE-001`、`FE-002`、`AGENT-001`、`AGENT-002` 已完成
> 范围：让 FusionKit 的 AI 模型配置和所有模型调用链支持新版 OpenAI Responses API 格式，同时保留现有 Chat Completions / OpenAI Compatible 行为。

---

## 1. 评审结论

### 1.1 最终方向

本需求不能只在某一个请求函数里把 URL 从 `/chat/completions` 改成 `/responses`。当前项目的 AI 使用面已经分散在字幕翻译、长文本翻译、名称翻译和 HomeAgent 中，而且配置层只保存 `provider/apiKey/baseUrl/modelKey/pricing`，没有记录“这个 profile 使用哪种 API 协议”。如果继续靠字符串替换推断端点，后续会持续出现同一 profile 在不同模块中行为不一致的问题。

最终设计采用：

1. 给 `ModelProfile` 增加 API 格式字段，明确区分 `chat_completions` 与 `responses`。
2. 把“用户输入的 baseUrl 可能是 base URL，也可能是历史 full endpoint”收敛到统一的 endpoint normalization 工具。
3. 在主进程建立统一 `ModelRuntimeClient`，内部用 Chat Completions adapter 与 Responses adapter 处理请求/响应差异。
4. 所有任务型调用先迁移到统一 runtime client；AI SDK 仍可作为 Chat Completions 工具循环的实现细节，但不得再让业务模块自己拼 OpenAI 请求。
5. 既有 profile 迁移后默认保持 `chat_completions`，保证升级不改变用户已有任务行为；新建 OpenAI profile 默认推荐 `responses`，DeepSeek 和 Other 默认仍为 `chat_completions`。

### 1.2 关键约束

- 不移除现有 OpenAI Compatible Chat Completions 支持；DeepSeek 和大量第三方兼容服务仍以 `/v1/chat/completions` 为主。
- 不把 Responses API 的结构化输出、内置工具、状态化会话作为首个实现闭环的硬依赖。翻译和命名仍应有纯文本协议 fallback。
- 不在恢复 manifest、任务记录、事件日志中持久化 API Key、Authorization header 或完整 profile。
- 不依赖某个供应商私有字段。`reasoning_content`、`<think>`、usage 明细等只能作为可选兼容解析。
- 不使用当前环境默认的新 pnpm 改写 `pnpm-lock.yaml`。本仓库 lockfile 为 v6，依赖变更需要使用项目兼容的 pnpm 8.x 流程。

## 2. 背景

FusionKit README 中已经声明支持 DeepSeek / OpenAI / 任意 OpenAI 兼容 API，但当前代码实际上把“兼容”主要理解为旧版 Chat Completions 形态：

```text
POST /v1/chat/completions
{
  "model": "...",
  "messages": [{ "role": "user", "content": "..." }],
  "max_tokens": ...
}
```

OpenAI 当前推荐的新统一接口是 Responses API：

```text
POST /v1/responses
{
  "model": "...",
  "instructions": "...",
  "input": "...",
  "max_output_tokens": ...
}
```

二者不只是 URL 不同，还包括请求字段、输出文本位置、usage 字段、截断状态、工具调用协议和流式事件模型差异。FusionKit 需要把这些差异封装在模型运行时层，而不是扩散到每一个工具页面和业务 service。

## 3. 调研来源

本设计参考以下官方资料和项目现状：

- OpenAI Responses API reference：`https://developers.openai.com/api/reference/resources/responses/methods/create`
- OpenAI Chat Completions API reference：`https://developers.openai.com/api/reference/resources/chat/methods/create`
- OpenAI Models API reference：`https://developers.openai.com/api/reference/resources/models/methods/list`
- OpenAI Responses vs Chat Completions / migration guide：`https://platform.openai.com/docs/guides/responses-vs-chat-completions`
- 项目现有长文本翻译协议设计：`docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- 项目现有模型配置与调用代码：`src/type/model.ts`、`src/store/useModelStore.ts`、`electron/main/ai/openai-compatible-client.ts`、`electron/main/translation/class/base-translator.ts`、`src/agent/orchestrator.ts`、`src/services/rename/nameTranslationPlanner.ts`

## 4. 目标与非目标

### 4.1 目标

1. 模型配置支持选择 API 格式：Chat Completions 或 Responses。
2. OpenAI profile 支持新版 Responses API 的请求、响应、usage 和错误解析。
3. 现有 Chat Completions 兼容服务继续可用，旧配置升级后行为不变。
4. 字幕翻译、长文本翻译、名称翻译和 HomeAgent 的模型调用都通过统一 runtime abstraction 获取协议能力。
5. 统一处理 endpoint normalization、Authorization、代理、超时、AbortSignal、Retry-After、错误分类和 API Key 脱敏。
6. 配置页模型拉取统一从规范化 base URL 派生 `/models`，不再依赖 `replace("/chat/completions", "/models")`。
7. 提供 fake server 与自动化测试，覆盖两种 API 格式的成功、空响应、截断、限流、鉴权失败、usage 缺失和 think 清理。

### 4.2 非目标

1. 不在本需求内升级或重排 OpenAI 模型价格表。
2. 不强制把 DeepSeek 或第三方服务迁到 Responses。
3. 不把 OpenAI Responses 的内置 web/file/computer 工具接入 FusionKit 工具系统。
4. 不引入云端会话持久化。除非用户显式选择，否则请求应尽量使用无状态模式，并对 OpenAI Responses 发送 `store: false`。
5. 不改变翻译 prompt、分片策略、恢复工作区格式的业务语义；只扩展模型请求协议。

## 5. 当前项目状态

### 5.1 配置层

相关文件：

- `src/type/model.ts`
- `src/constants/model.ts`
- `src/store/useModelStore.ts`
- `src/pages/Setting/components/ModelConfig.tsx`

当前 `ModelProfile`：

```ts
export interface ModelProfile {
  id: string;
  name: string;
  provider: Model;
  apiKey: string;
  baseUrl: string;
  modelKey: string;
  tokenPricing: TokenPricing;
}
```

问题：

- `baseUrl` 语义不稳定。默认值是 `https://api.openai.com/v1/chat/completions`，但 AI SDK 调用会先 strip `/chat/completions`，长文本客户端会把非 `/chat/completions` 的 endpoint 自动追加 `/chat/completions`。
- 配置没有 API 格式字段，无法表达 Responses。
- `fetchOpenAIModels` 通过字符串替换 `/chat/completions` 得到 `/models`，不能覆盖 `/responses` 或纯 base URL 的所有输入。

### 5.2 字幕翻译

相关文件：

- `electron/main/translation/translation-service.ts`
- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/class/lrc-translator.ts`
- `electron/main/translation/class/srt-translator.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`

现状：

- `BaseTranslator.translateFragment()` 直接使用 `axios.post(this.getApiEndpoint(), { model, messages, max_tokens, stream:false })`。
- 响应解析由 LRC/SRT 子类直接读取 `response.choices[0].message.content`。
- 错误分类、Retry-After、usage 映射、API Key 脱敏与长文本客户端不一致。

### 5.3 长文本翻译

相关文件：

- `electron/main/ai/openai-compatible-client.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `src/type/textTranslation.ts`
- `test/text-translation/model/openAICompatibleClient.test.ts`
- `test/text-translation/protocol/fakeOpenAICompatibleServer.ts`

现状：

- 已有通用 Chat Completions 客户端，负责重试、错误分类、think 清理和 usage 映射。
- 请求固定为 Chat Completions：`messages`、`max_tokens`、`choices[0].message.content`。
- `TextTranslationRuntimeModelConfig` 只包含 `profileId/apiKey/modelKey/endpoint`，没有 API 格式。

### 5.4 名称翻译

相关文件：

- `src/services/rename/nameTranslationPlanner.ts`

现状：

- 使用 `@ai-sdk/openai-compatible` + `ai` 的 `generateObject` / `generateText`。
- `createModel(profile)` 仍通过 strip `/chat/completions` 构造 Chat Completions compatible provider。
- 结构化输出失败后有纯文本 JSON fallback，这是可保留的降级策略。

### 5.5 HomeAgent

相关文件：

- `src/agent/orchestrator.ts`
- `src/agent/tool-executor.ts`
- `src/store/agent/useAgentStore.ts`

现状：

- 使用 AI SDK `streamText` + `createOpenAICompatible` 驱动工具循环。
- 模型消息已转换为 AI SDK `ModelMessage[]`，工具调用、工具结果和流式事件均依赖 AI SDK provider。
- Responses 的 tool call/item/stream event 模型与当前 Chat Completions provider 不同，需要单独 adapter，不应在翻译最小闭环中顺手硬改。

## 6. 用户可见行为

### 6.1 模型配置页

Profile 编辑弹窗新增“API 格式”控件：

```text
API 格式
[Responses API] [Chat Completions]
```

默认值：

- 新建 OpenAI profile：`responses`
- 新建 DeepSeek profile：`chat_completions`
- 新建 Other profile：`chat_completions`
- 迁移已有 profile：`chat_completions`

Base URL 输入框文案调整为推荐填写 base URL：

```text
https://api.openai.com/v1
```

兼容历史输入：

- `https://api.openai.com/v1/chat/completions`
- `https://api.openai.com/v1/responses`

保存时不强制改写用户输入展示值，但运行时通过 normalization 派生实际 endpoint。后续如要清理 UI，可在保存时把 full endpoint 转为 base URL，并显示一次非阻塞提示。

### 6.2 模型列表拉取

“拉取模型列表”统一调用：

```text
GET <normalizedBaseUrl>/models
Authorization: Bearer <apiKey>
```

不再从当前字符串中只替换 `/chat/completions`。

### 6.3 调用失败提示

用户仍看到业务语义错误：

- API Key 无效或无权限。
- endpoint 不支持所选 API 格式。
- 模型不存在或不可用于所选格式。
- 模型输出为空。
- 输出达到上限被截断，请调高输出 token 或降低分片大小。
- 当前模块暂不支持 Responses profile 的某项能力。

错误消息不能泄露 API Key。

### 6.4 Agent 分配限制

最终目标是 Agent 也支持 Responses，但实施上必须分阶段：

1. 任务型能力先支持 Responses：字幕翻译、长文本翻译、名称翻译。
2. HomeAgent 后续通过 `ResponsesAgentAdapter` 支持工具循环、流式输出和 tool result item。

在 Agent adapter 完成前，如果用户把 Responses profile 分配给 Agent，UI 必须明确提示“当前 Agent 暂不支持该 API 格式”，并阻止启动会话，而不是运行到半途失败。

当前 `AGENT-002` 已完成，HomeAgent 已具备 Chat Completions 与 Responses 两条 adapter 路径；上述阻止策略仅作为 adapter 完成前的过渡约束保留在历史设计说明中。

## 7. 数据模型设计

### 7.1 ModelProfile v3

```ts
export type ModelApiFormat = "chat_completions" | "responses";

export type OutputTokenParameter = "max_tokens" | "max_completion_tokens";

export interface ModelProfile {
  id: string;
  name: string;
  provider: Model;
  apiKey: string;
  baseUrl: string;
  modelKey: string;
  tokenPricing: TokenPricing;
  apiFormat: ModelApiFormat;
  outputTokenParameter?: OutputTokenParameter;
}
```

字段说明：

- `apiFormat` 是主开关。
- `baseUrl` 继续沿用字段名以减少迁移面，但新语义是“用户配置的 API base URL 或历史 full endpoint”。
- `outputTokenParameter` 仅对 `chat_completions` 生效。OpenAI 新模型应使用 `max_completion_tokens`；多数旧兼容服务仍使用 `max_tokens`。为空时按 provider 推断。

迁移规则：

```text
version < 3:
  profiles[].apiFormat = "chat_completions"
  profiles[].outputTokenParameter = infer by provider:
    OpenAI -> "max_completion_tokens"
    DeepSeek/Other -> "max_tokens"
```

迁移不改变 `baseUrl` 字符串，以免破坏用户对旧兼容服务的配置。

### 7.2 Runtime model config

任务 DTO 扩展：

```ts
export interface RuntimeModelConfig {
  profileId?: string;
  apiKey: string;
  modelKey: string;
  endpoint: string;
  apiFormat: ModelApiFormat;
  outputTokenParameter?: OutputTokenParameter;
}
```

适用范围：

- `TextTranslationRuntimeModelConfig`
- `SubtitleTranslatorTask`
- HomeAgent tool executor 入队字幕/文本任务时携带的模型配置
- 名称翻译 planner 的 task profile runtime snapshot

持久化策略：

- 恢复 manifest 只保存 `profileId/modelKey/endpointLabel/apiFormat`，不保存 `apiKey` 和完整 endpoint。
- 运行时继续由 Renderer 从当前 profile 重新注入 API Key。

## 8. Endpoint Normalization

新增共享工具，建议路径：

```text
src/lib/model-endpoint.ts
```

核心接口：

```ts
export interface NormalizedModelEndpoint {
  baseUrl: string;
  chatCompletionsUrl: string;
  responsesUrl: string;
  modelsUrl: string;
  originalInput: string;
  detectedInputKind: "base_url" | "chat_completions_endpoint" | "responses_endpoint";
}

export function normalizeModelEndpoint(input: string): NormalizedModelEndpoint;
```

规则：

1. 去除末尾 `/`。
2. 如果以 `/chat/completions` 结尾，base URL 为去掉该后缀后的路径。
3. 如果以 `/responses` 结尾，base URL 为去掉该后缀后的路径。
4. 否则把输入视为 base URL。
5. 派生：
   - `chatCompletionsUrl = baseUrl + "/chat/completions"`
   - `responsesUrl = baseUrl + "/responses"`
   - `modelsUrl = baseUrl + "/models"`

示例：

| 输入 | baseUrl | chatCompletionsUrl | responsesUrl |
| --- | --- | --- | --- |
| `https://api.openai.com/v1` | `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` | `https://api.openai.com/v1/responses` |
| `https://api.openai.com/v1/chat/completions` | `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` | `https://api.openai.com/v1/responses` |
| `https://api.openai.com/v1/responses` | `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` | `https://api.openai.com/v1/responses` |

## 9. 运行时架构

建议新增：

```text
electron/main/ai/model-runtime-client.ts
electron/main/ai/adapters/chat-completions-adapter.ts
electron/main/ai/adapters/responses-adapter.ts
electron/main/ai/model-runtime-errors.ts
electron/main/ai/model-response-normalizers.ts
test/ai/modelRuntimeClient.test.ts
test/ai/fakeModelApiServer.ts
```

旧文件迁移：

- `electron/main/ai/openai-compatible-client.ts` 暂时保留 export，内部委托到 `ModelRuntimeClient` 的 Chat Completions adapter。
- 长文本翻译先改调用新 client，确认稳定后再删除旧命名或保留兼容 wrapper。

### 9.1 统一请求接口

```ts
export interface ModelRuntimeTextRequest {
  model: RuntimeModelConfig;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: "text" | "json_object";
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: Partial<ModelRuntimeRetryOptions>;
}

export interface ModelRuntimeTextResult {
  content: string;
  reasoningContent?: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  responseId?: string;
  model?: string;
  apiFormat: ModelApiFormat;
  rawStatus?: string;
}
```

### 9.2 Chat Completions adapter

请求：

```json
{
  "model": "<modelKey>",
  "messages": [],
  "temperature": 0.3,
  "max_completion_tokens": 4096
}
```

兼容策略：

- `outputTokenParameter === "max_tokens"` 时发送 `max_tokens`。
- `outputTokenParameter === "max_completion_tokens"` 时发送 `max_completion_tokens`。
- 不同时发送两个字段，避免第三方兼容服务拒绝未知字段。
- `stream:false` 只在已有调用需要时保留；通用非流式请求不必强制发送。

响应解析：

- 主文本：`choices[0].message.content`
- 多 part content：兼容数组 part 的 `text` / `content`
- finish reason：`choices[0].finish_reason`
- 截断：`finish_reason === "length"` 映射为 `length_truncated`
- usage：
  - `prompt_tokens -> inputTokens`
  - `completion_tokens -> outputTokens`
  - `total_tokens -> totalTokens`
  - `completion_tokens_details.reasoning_tokens -> reasoningTokens`

### 9.3 Responses adapter

请求：

```json
{
  "model": "<modelKey>",
  "instructions": "<system messages joined>",
  "input": "<user prompt or normalized conversation>",
  "temperature": 0.3,
  "max_output_tokens": 4096,
  "store": false
}
```

消息映射：

- 单轮任务：system/developer 内容合并到 `instructions`，user 内容合并为 `input` 字符串。
- 多轮任务：映射为 `input` message item 数组，保留 `role` 与文本 content block。
- assistant 历史只在 Agent adapter 中完整支持；任务型调用通常不需要 assistant 历史。

响应解析：

- 首选 `output_text`。
- 如果无 `output_text`，遍历 `output[]` 中的 message content，收集 `type === "output_text"` 或兼容 text 字段。
- 如果存在 refusal 且无可用文本，映射为 `invalid_response` 或业务错误。
- `status === "incomplete"` 且 `incomplete_details.reason === "max_output_tokens"` 映射为 `length_truncated`。
- usage：
  - `input_tokens -> inputTokens`
  - `output_tokens -> outputTokens`
  - `total_tokens -> totalTokens`
  - `output_tokens_details.reasoning_tokens -> reasoningTokens`

隐私策略：

- OpenAI Responses adapter 默认发送 `store:false`。
- 对 Other provider 的 Responses 兼容服务，如测试发现拒绝 `store` 字段，可通过 profile capability 或 adapter probe 配置 `omitStoreField`。

### 9.4 错误模型

统一错误码：

```ts
export type ModelRuntimeErrorCode =
  | "aborted"
  | "network_error"
  | "request_timeout"
  | "http_rate_limited"
  | "http_retryable"
  | "http_unauthorized"
  | "http_forbidden"
  | "http_non_retryable"
  | "unsupported_api_format"
  | "empty_response"
  | "length_truncated"
  | "invalid_response";
```

HTTP 分类：

- `401`：鉴权失败，不重试。
- `403`：权限不足，不重试。
- `404`：通常为 endpoint 或 model 错误，不重试，并提示检查 API 格式。
- `408`、`429`、`5xx`：可重试，尊重 `Retry-After`。
- abort：不重试。

所有错误消息必须经过 API Key 脱敏。

## 10. 各模块接入设计

### 10.1 字幕翻译

改造方向：

- `BaseTranslator.translateFragment()` 不再直接 `axios.post`。
- 构造 `ModelRuntimeTextRequest`，调用 `sendModelRuntimeText()`。
- LRC/SRT 子类的 `parseResponse(responseData)` 改为处理纯文本 result，或者新增 `postProcessModelText(content, usage)`。

收益：

- 字幕翻译获得 Responses 支持。
- 和长文本翻译共享重试、错误分类、think 清理、usage 映射。
- 旧测试 `test/translation/base-translator.test.ts` 需要从 mock axios 改成 fake runtime client 或 fake model server。

### 10.2 长文本翻译

改造方向：

- `TextTranslationRuntimeModelConfig` 增加 `apiFormat/outputTokenParameter`。
- `text-translation-service.ts` 调用新 `ModelRuntimeClient`。
- 继续使用现有 marker text 协议和 `translation-response-protocol.ts`，不要依赖 Responses structured output。

兼容点：

- 现有 fake server 扩展为同时支持 `/v1/chat/completions` 和 `/v1/responses`。
- 现有 `openAICompatibleClient.test.ts` 可迁移到新 client 的 Chat adapter 回归测试。

### 10.3 名称翻译

改造方向：

- 首步不要直接删除 AI SDK 结构化输出路径。
- 当 `apiFormat === "chat_completions"` 时，可继续使用 AI SDK provider，但应通过统一 endpoint normalization。
- 当 `apiFormat === "responses"` 时，走 `ModelRuntimeClient` 文本 JSON 路径：
  1. prompt 明确要求 JSON。
  2. 可选使用 Responses `text.format` JSON schema，但必须经过 capability probe 或失败 fallback。
  3. 复用现有 `repairNameTranslationModelJsonText()` 与 zod schema 校验。

后续收敛：

- 如果 Responses JSON schema 在 OpenAI 官方和目标兼容服务上验证稳定，可把 structured path 抽象为 `sendModelRuntimeJson()`。

### 10.4 HomeAgent

HomeAgent 的复杂度来自工具循环和流式事件，不建议和翻译最小闭环混在一个工作包内。

最终设计：

```text
AgentRuntime
  ChatCompletionsAgentAdapter  -> AI SDK streamText + openai-compatible provider
  ResponsesAgentAdapter        -> direct Responses stream/tool loop adapter
```

ResponsesAgentAdapter 需要处理：

- session messages -> Responses input items。
- FusionKit tools -> Responses function tools。
- function call output -> subsequent response input。
- streaming text delta -> `useAgentStore.appendStreamingText()`。
- tool call start/result -> 当前 AgentMessage/toolResult 结构。
- abort、step limit、token usage、错误日志。

实施边界：

- `AGENT-002` 完成后，设置页允许将 Responses profile 分配给 Agent，启动会话时按 `apiFormat` 选择 Chat 或 Responses adapter。
- Agent 不得静默 fallback 到 Chat Completions，因为用户选择 Responses 往往意味着 endpoint 只有 `/responses` 可用。

## 11. Frontend 设计

### 11.1 ModelConfig

修改文件：

- `src/pages/Setting/components/ModelConfig.tsx`
- `src/locales/*/setting.json`

控件：

- API 格式 segmented control。
- Base URL 输入框 help text 根据格式变化。
- 高级项 `outputTokenParameter` 仅在 Chat Completions 下显示，默认折叠。

状态：

- loading：模型列表刷新按钮沿用现状。
- error：模型列表刷新失败时显示当前格式和派生 URL，便于用户定位。
- warning：
  - Responses profile 分配给暂未支持的 Agent 时展示限制。
  - 用户输入 full endpoint 时提示“已兼容历史 endpoint，推荐填写 base URL”。

### 11.2 i18n

新增 key 应覆盖：

- API 格式标签。
- Responses API / Chat Completions 文案。
- output token 参数高级选项。
- endpoint normalization 提示。
- unsupported API format 错误。
- Agent 暂不支持 Responses 的提示。

变更用户可见文案后必须运行：

```text
pnpm run i18n:check
```

执行时注意项目 pnpm 版本约束。

## 12. 后端 / 主进程设计

### 12.1 请求路径

任务型调用统一为：

```text
Renderer profile
  -> runtime DTO with apiFormat
  -> Electron IPC validation
  -> ModelRuntimeClient
  -> Adapter by apiFormat
  -> normalized text result
  -> business parser/post processor
```

### 12.2 代理与网络

- Chat 和 Responses adapter 均复用 `getAxiosProxyConfig()`。
- `fetchOpenAIModels` 当前在 Renderer 使用 `fetch`，如要遵守全局代理，后续可改为主进程 IPC；本需求首版可先只修正 URL normalization。

### 12.3 安全与持久化

- `apiKey` 只存在于 Renderer store 和运行时 DTO。
- checkpoint、workspace manifest、event log 不写入 `apiKey`、`Authorization`、完整 request body。
- error log 可记录 status、error code、endpoint label，不记录完整 Authorization。
- Responses 默认 `store:false`，并在设计文档/隐私说明中记录。

## 13. 兼容规则

### 13.1 旧 profile

旧 profile 升级后：

- `apiFormat = "chat_completions"`
- `baseUrl` 保持原值。
- 所有已有任务行为保持不变。

### 13.2 旧任务恢复

恢复任务如果 manifest 没有 `apiFormat`：

- 按 `chat_completions` 处理。
- UI 可提示这是旧任务，沿用旧 API 格式恢复。

### 13.3 第三方兼容服务

Other provider 默认：

- `apiFormat = "chat_completions"`
- `outputTokenParameter = "max_tokens"`

如果用户手动选择 Responses：

- 请求 `/responses`。
- 如果 404 或 invalid endpoint，错误提示应明确建议切换回 Chat Completions 或检查服务是否支持 Responses。

## 14. 测试与验证策略

### 14.1 单元测试

新增/更新：

- endpoint normalization：
  - base URL
  - `/chat/completions`
  - `/responses`
  - trailing slash
- ModelProfile migration v2 -> v3。
- DTO validation：缺失/非法 `apiFormat`。
- Chat adapter 请求字段和响应解析。
- Responses adapter 请求字段和响应解析。
- API Key 脱敏。
- `max_tokens` / `max_completion_tokens` 选择。

### 14.2 Fake server 集成测试

fake server 支持：

```text
POST /v1/chat/completions
POST /v1/responses
GET  /v1/models
```

覆盖场景：

- 成功返回文本。
- usage 缺失。
- reasoning tokens。
- 空文本重试。
- Chat `finish_reason=length`。
- Responses `status=incomplete` + `max_output_tokens`。
- 401/403/404/429/5xx。
- Retry-After。
- abort。

### 14.3 业务回归

建议命令：

```text
pnpm exec vitest run test/ai test/text-translation/model test/text-translation/service test/translation src/type/textTranslationIpc.test.ts
pnpm exec tsc --noEmit
pnpm run i18n:check
git diff --check
```

如果实现涉及 UI：

```text
pnpm build
```

如启动 Vite/Electron 做手工验证，结束前必须关闭本次启动的前端服务进程，并按项目避坑要求确认无遗留。

## 15. 风险与边界

### 15.1 Responses 兼容生态不如 Chat Completions 稳定

很多“OpenAI compatible”服务只兼容 Chat Completions。设计上必须让 Chat Completions 继续是一等能力，而不是把 Responses 当成全局替换。

### 15.2 结构化输出差异

现有长文本设计已验证部分兼容服务会拒绝 `response_format`。Responses 的 JSON schema 也不能假定所有兼容服务都支持。名称翻译和协议解析必须保留纯文本 JSON repair fallback。

### 15.3 Agent 工具循环复杂

AI SDK 当前 Chat Completions provider 已承载工具循环。Responses Agent adapter 是独立工作包，不应阻塞任务型调用支持 Responses，但 UI 必须阻止不支持的组合。

### 15.4 输出 token 参数兼容

OpenAI 新模型倾向 `max_completion_tokens`，旧兼容服务多使用 `max_tokens`。该字段必须 profile 化或按 provider 推断，不能简单全局替换。

### 15.5 隐私默认值

Responses 支持状态化/存储相关能力。FusionKit 是本地工具，默认请求应偏无状态，并通过 `store:false` 表达隐私意图；如果兼容服务拒绝该字段，需要能力配置或 fallback。

## 16. 推荐实施拆分

后续进入执行计划时建议按以下工作包拆分：

| ID | 标题 | 目标 |
| --- | --- | --- |
| PRE-001 | 官方 API 格式与 fake server 验证 | 固定 Chat/Responses request/response/usage/error fixture |
| CORE-001 | Profile v3 与 endpoint normalization | 增加 `apiFormat`、迁移、URL 派生、设置页模型拉取 |
| BE-001 | ModelRuntimeClient 与 Chat adapter | 保持现有长文本测试通过，替代旧 client |
| BE-002 | Responses adapter | 支持非流式文本生成、usage、截断和错误分类 |
| BE-003 | 长文本翻译接入 | `TextTranslationRuntimeModelConfig` 扩展并跑 service 回归 |
| BE-004 | 字幕翻译接入 | 移除手写 axios 请求，统一错误和响应解析 |
| BE-005 | 名称翻译 Responses 路径 | JSON text fallback 支持 Responses |
| FE-001 | 设置页 API 格式 UI 与 i18n | 新增控件、提示、assignment 能力校验 |
| AGENT-001 | Agent Chat adapter 收口 | 把当前 AI SDK 调用包进 AgentRuntime |
| AGENT-002 | Responses Agent adapter | 支持 Responses 工具循环和流式事件 |
| QA-001 | 双格式端到端验收 | fake server + 真实 OpenAI/兼容服务手工验证 |

优先级：

1. 先关闭任务型非流式调用的最小闭环。
2. 再迁移字幕和名称翻译，消除重复请求实现。
3. 最后做 Agent Responses 工具循环。

## 17. 明确排除

- 本设计不承诺所有第三方 OpenAI compatible 服务都支持 Responses。
- 本设计不要求用户已有 profile 自动切到 Responses。
- 本设计不在没有验证的情况下引入新的 AI SDK provider major upgrade。
- 本设计不改变已有翻译输出格式、命名规则、队列策略和恢复策略。
