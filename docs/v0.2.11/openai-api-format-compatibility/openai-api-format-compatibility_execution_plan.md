# OpenAI 新旧 API 格式兼容 Execution Plan

> 日期：2026-07-08
> Feature Slug：`openai-api-format-compatibility`
> 对应设计文档：`docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
> 当前状态：`PRE-001`、`CORE-001`、`CORE-002`、`BE-001`、`BE-002`、`BE-003`、`BE-004`、`BE-005`、`FE-001`、`FE-002`、`AGENT-001`、`AGENT-002`、`FIX-001` 已完成；`DOC-001` 发布说明部分完成；下一步建议认领 `QA-001`，并补齐 `DOC-001` README/隐私说明

---

## 1. 每次开发会话的使用方式

每次实现会话开始前，Agent 必须：

1. 阅读 `docs/v0.2.11/README.md`。
2. 阅读 `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`。
3. 阅读本执行计划。
4. 检查第 5 节进度台账，认领一个最小可闭环工作包。
5. 检查 `git status --short`，保留用户已有改动。
6. 如果要运行 `pnpm`，先确认版本为项目兼容的 8.x；不要用当前环境过新的 pnpm 改写 lockfile v6。
7. 如果需要启动 Vite、Electron 或其他前端服务，记录进程，并在最终回复前关闭。

每次实现会话结束前必须：

1. 运行该工作包列出的验证，或准确记录无法运行的原因。
2. 更新第 5 节进度台账。
3. 在 `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/` 新增实施记录。
4. 只有代码、测试、文档、台账和验证均闭环时，才把工作包标为 `已完成`。
5. 如实现证明 Final Design 假设不成立，先更新 Final Design 或补充 `feat/` / `fix/` 文档，不能静默偏离。
6. 回答用户前关闭本次启动的全部前端服务进程，并检查无遗留。

## 2. 状态规则

工作包状态只允许使用：

- `未开始`
- `进行中`
- `已完成`
- `阻塞`
- `废弃`

状态解释：

- `未开始`：尚未认领，或只做过不改变代码/文档契约的阅读。
- `进行中`：已有实现或验证工作，但尚未满足完整验收口径。
- `已完成`：实现、测试、文档、台账和实施记录均闭环。
- `阻塞`：存在明确外部阻塞，当前会话无法继续推进。
- `废弃`：设计更新后明确不再实施，必须记录替代方案或原因。

## 3. 推进原则

### 3.1 依赖优先级

按以下顺序推进：

1. 先固定 API 格式 fixture、fake server 和 endpoint normalization，避免后续业务模块重复踩协议差异。
2. 再关闭 Chat Completions adapter 的兼容回归，保证旧 profile 行为不变。
3. 再实现 Responses 非流式文本最小闭环，优先服务翻译和命名。
4. 再逐个迁移长文本、字幕、名称翻译调用面。
5. 再做设置页 API 格式 UI、assignment 能力提示和 i18n。
6. 最后处理 HomeAgent 的 Responses 工具循环和跨模块 QA。

### 3.2 最小端到端路径

第一个可运行垂直切片必须具备：

```text
OpenAI profile 选择 Responses API
  -> normalize base URL 到 /v1/responses
  -> 任务型非流式请求发送 input/instructions/max_output_tokens/store:false
  -> 解析 output_text / output[] 文本
  -> 映射 usage、空响应、截断和 HTTP 错误
  -> 保持旧 Chat Completions profile 测试通过
```

该闭环不要求先完成：

- HomeAgent Responses 工具循环。
- OpenAI Responses structured output / JSON schema。
- 真实供应商手工验收。
- 所有 UI 文案和发布说明。

### 3.3 不得违反的设计约束

- 旧 profile 升级后默认 `apiFormat = "chat_completions"`，不得自动切到 Responses。
- DeepSeek 和 Other 默认仍使用 Chat Completions。
- Chat Completions 和 Responses 都是一等路径，不允许把 Responses 写成全局替换。
- API Key、Authorization header、完整 request body 不得写入 checkpoint、workspace manifest 或 event log。
- Responses adapter 默认发送 `store:false`；如兼容服务拒绝，必须以 capability/fallback 处理。
- 不依赖 `response_format`、Responses JSON schema 或厂商私有字段作为首版任务型能力的必要条件。
- `max_tokens` 与 `max_completion_tokens` 不得同时发送。
- HomeAgent 在 Responses adapter 完成前必须阻止不支持的 profile 组合，不能半途失败或静默 fallback。
- 如改用户可见文案，必须同步 `src/locales/*` 并运行 i18n 检查。
- 如改依赖或 lockfile，必须使用项目兼容 pnpm 8.x 流程。

## 4. 阶段与里程碑

| 里程碑 | 达成条件 |
| --- | --- |
| M0 协议基线冻结 | `PRE-001`、`CORE-001` 完成，fake server 与 endpoint normalization 可复用 |
| M1 运行时双格式闭环 | `CORE-002`、`BE-001`、`BE-002` 完成，Chat 回归与 Responses 非流式请求均通过 |
| M2 任务型模块接入 | `BE-003`、`BE-004`、`BE-005` 完成，长文本/字幕/名称翻译均支持 Responses 或明确 fallback |
| M3 配置体验闭环 | `FE-001`、`FE-002` 完成，设置页可选择 API 格式并阻止不支持组合 |
| M4 Agent 能力闭环 | `AGENT-001`、`AGENT-002` 完成，HomeAgent 支持 Chat/Responses 两种 adapter |
| M5 发布候选 | `QA-001`、`QA-002`、`DOC-001` 完成，自动化、手工验收和文档同步闭环 |

## 5. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PRE-001 | 已完成 | 2026-07-08 | API 格式 fixture 与 fake server 验证 | `test/ai/fakeModelApiServer.ts`、`test/ai/modelApiFormatProbe.test.ts` | `node_modules/.bin/vitest run test/ai/modelApiFormatProbe.test.ts`（7 tests passed）；`git diff --check`；单文件 whitespace 检查 | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_PRE-001_api-format-fixtures.md` | 当前环境 `pnpm --version` 为 11.7.0，验证使用本地 vitest 以避免新 pnpm 改写 lockfile；旧 `test/text-translation/protocol/fakeOpenAICompatibleServer.ts` 暂未迁移 |
| CORE-001 | 已完成 | 2026-07-08 | Endpoint normalization 与共享 API 类型 | `src/type/model.ts`、`src/constants/model.ts`、`src/lib/model-endpoint.ts`、`src/lib/model-endpoint.test.ts` | `node_modules/.bin/vitest run src/lib/model-endpoint.test.ts`（7 tests passed）；`node_modules/.bin/tsc --noEmit`；`git diff --check`；单文件 whitespace 检查 | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_CORE-001_endpoint-normalization.md` | 当前环境 `pnpm --version` 为 11.7.0，验证使用本地 `node_modules/.bin/*`；`ModelProfile.apiFormat/outputTokenParameter` 在本包中先保持 optional，完整 v3 持久化迁移由 `CORE-002` 完成 |
| CORE-002 | 已完成 | 2026-07-08 | ModelProfile v3 持久化迁移与 DTO 校验 | `src/store/useModelStore.ts`、`src/type/textTranslation.ts`、`src/type/textTranslationIpc.ts`、`electron/main/text-translation/ipc.ts`、`electron/main/text-translation/text-translation-service.ts`、`electron/main/translation/typing.ts`、`src/type/subtitle.ts`、`src/pages/Tools/Text/TextTranslator/index.tsx`、相关测试 | `node_modules/.bin/vitest run src/store/useModelStore.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts src/lib/model-endpoint.test.ts test/ai/modelApiFormatProbe.test.ts`（31 tests passed）；`node_modules/.bin/vitest run test/text-translation/service/textTranslationService.e2e.test.ts -t "prepares, translates, persists, and assembles a single TXT task"`（1 test passed, 13 skipped）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_CORE-002_profile-v3-runtime-dto.md` | 当前环境 `pnpm --version` 为 11.7.0，验证使用本地 `node_modules/.bin/*`；业务 runtime adapter 尚未接入双格式，交由 `BE-001`/`BE-002` |
| BE-001 | 已完成 | 2026-07-08 | ModelRuntimeClient 与 Chat Completions adapter | `electron/main/ai/model-runtime-client.ts`、`electron/main/ai/adapters/chat-completions-adapter.ts`、`electron/main/ai/model-runtime-errors.ts`、`electron/main/ai/openai-compatible-client.ts`、`test/ai/modelRuntimeClient.test.ts`、`test/text-translation/model/openAICompatibleClient.test.ts` | `node_modules/.bin/vitest run test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts`（12 tests passed）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_BE-001_model-runtime-chat-adapter.md` | Responses adapter 尚未实现，`sendModelRuntimeText()` 对 `responses` 明确返回 `unsupported_api_format`，交由 `BE-002` |
| BE-002 | 已完成 | 2026-07-08 | Responses 非流式文本 adapter | `electron/main/ai/adapters/responses-adapter.ts`、`electron/main/ai/model-runtime-client.ts`、`test/ai/modelRuntimeClient.test.ts`、`test/ai/fakeModelApiServer.ts` | `node_modules/.bin/vitest run test/ai/modelRuntimeClient.test.ts`（7 tests passed）；`node_modules/.bin/vitest run test/text-translation/model/openAICompatibleClient.test.ts`（8 tests passed）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_BE-002_responses-text-adapter.md` | 已验证 `output_text`、`output[]`、`status=incomplete`、usage、`store:false` 和 429 Retry-After；业务模块接入交由 `BE-003` 起推进 |
| BE-003 | 已完成 | 2026-07-08 | 长文本翻译接入双格式 runtime | `electron/main/text-translation/text-translation-service.ts`、`test/text-translation/service/textTranslationService.e2e.test.ts`、`src/type/textTranslation.ts`、`src/type/textTranslationIpc.ts`、`src/pages/Tools/Text/TextTranslator/index.tsx` | `node_modules/.bin/vitest run test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts test/text-translation/service/textTranslationService.e2e.test.ts -t "Responses runtime adapter|ModelRuntimeClient|OpenAI Compatible client|text translation IPC contract|text translation domain contract"`（31 tests passed, 14 skipped）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_BE-003_text-translation-runtime-integration.md` | 已覆盖 TXT parallel target-only Responses E2E；Markdown/顺序模式已切 runtime 但只保留现有 protocol parser 回归，后续 QA 可扩展完整矩阵 |
| BE-004 | 已完成 | 2026-07-08 | 字幕翻译迁移到 ModelRuntimeClient | `electron/main/translation/class/base-translator.ts`、`electron/main/translation/class/lrc-translator.ts`、`electron/main/translation/class/srt-translator.ts`、`src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`、`src/pages/Tools/Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx`、`test/translation/base-translator.test.ts`、`test/translation/base-translator-runtime.test.ts` | `node_modules/.bin/vitest run test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts`（2 tests passed）；`node_modules/.bin/vitest run test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/service/textTranslationService.e2e.test.ts -t "BaseTranslator|ModelRuntimeClient|OpenAI Compatible client|Responses runtime adapter"`（18 tests passed, 14 skipped）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_BE-004_subtitle-runtime-integration.md` | 字幕已移除手写 axios 请求并走 runtime；完整 LRC/SRT 真实矩阵留给后续 QA/手工验收 |
| BE-005 | 已完成 | 2026-07-08 | 名称翻译 Responses 路径与 JSON fallback | `src/services/rename/nameTranslationPlanner.ts`、`src/services/rename/nameTranslationPlanner.test.ts` | `node_modules/.bin/vitest run src/services/rename/nameTranslationPlanner.test.ts`（27 tests passed）；`node_modules/.bin/vitest run src/services/rename/nameTranslationPlanner.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts`（42 tests passed）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_BE-005_name-translation-responses-path.md` | Responses profile 走 renderer-side `/responses` text JSON path，避免 renderer 直接导入 Electron main runtime；后续如需统一代理可加主进程 IPC facade |
| FE-001 | 已完成 | 2026-07-08 | 设置页 API 格式 UI 与模型列表 URL 修正 | `src/pages/Setting/components/ModelConfig.tsx`、`src/locales/*/setting.json` | `node_modules/.bin/tsc --noEmit`；`node scripts/check-i18n.mjs`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_FE-001_model-config-api-format-ui.md` | 已覆盖 API 格式控件、Base URL 提示、Chat 输出 token 参数、`/models` normalization；Agent assignment 能力限制交由 `FE-002` |
| FE-002 | 已完成 | 2026-07-08 | Profile assignment 能力校验与任务入参补齐 | `src/agent/api-format-capability.ts`、`src/agent/task-model-config.ts`、`src/agent/orchestrator.ts`、`src/agent/tool-executor.ts`、`src/pages/HomeAgent/index.tsx`、`src/pages/Setting/components/ModelConfig.tsx`、`src/locales/*/{home,setting}.json` | `node_modules/.bin/vitest run src/agent`（41 tests passed）；`node_modules/.bin/vitest run src/agent src/store/useModelStore.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts src/lib/model-endpoint.test.ts src/services/rename/nameTranslationPlanner.test.ts test/ai/modelApiFormatProbe.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts`（131 tests passed）；`node_modules/.bin/tsc --noEmit`；`node scripts/check-i18n.mjs`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_FE-002_assignment-capability-guard.md` | `AGENT-002` 已解除 Responses Agent 临时限制；当前 Agent 工具集合没有长文本翻译入队工具，长文本页面路径已在 `BE-003` 补齐 |
| AGENT-001 | 已完成 | 2026-07-08 | AgentRuntime Chat adapter 收口 | `src/agent/runtime/chat-completions-agent-adapter.ts`、`src/agent/runtime/chat-completions-agent-adapter.test.ts`、`src/agent/orchestrator.ts` | `node_modules/.bin/vitest run src/agent/runtime/chat-completions-agent-adapter.test.ts src/agent`（44 tests passed）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_AGENT-001_chat-agent-adapter.md` | 已保持现有 AI SDK Chat path 行为；Responses 工具循环 adapter 已由 `AGENT-002` 完成 |
| AGENT-002 | 已完成 | 2026-07-08 | HomeAgent Responses 工具循环 adapter | `src/agent/runtime/responses-agent-adapter.ts`、`src/agent/runtime/types.ts`、`src/agent/runtime/responses-agent-adapter.test.ts`、`src/agent/runtime/chat-completions-agent-adapter.ts`、`src/agent/orchestrator.ts`、`src/agent/types.ts`、`src/agent/api-format-capability.ts` | `node_modules/.bin/vitest run src/agent/runtime`（10 tests passed）；`node_modules/.bin/vitest run src/agent`（51 tests passed）；`node_modules/.bin/vitest run src/agent src/store/useModelStore.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts src/lib/model-endpoint.test.ts src/services/rename/nameTranslationPlanner.test.ts test/ai/modelApiFormatProbe.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts`（141 tests passed）；`node_modules/.bin/tsc --noEmit`；`node scripts/check-i18n.mjs`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_AGENT-002_responses-agent-adapter.md` | 已覆盖 Responses 普通流式文本、function call 参数聚合、zod 默认值校验、tool result 回填下一轮、usage 和 step limit；未启动 Electron 做真实 UI 手工验收，交由 `QA-002` |
| FIX-001 | 已完成 | 2026-07-08 | 模型预设与上下文窗口校准 | `src/constants/model.ts`、`src/constants/model.test.ts`、`src/pages/Tools/Text/TextTranslator/index.tsx`、`src/pages/Tools/Text/TextTranslator/components/ConfigPanel.tsx`、`docs/v0.2.11/openai-api-format-compatibility/fix/2026-07-08_openai-api-format-compatibility_model-presets-context-windows.md` | `node_modules/.bin/vitest run src/constants/model.test.ts src/type/textTranslation.test.ts`（13 tests passed）；`node_modules/.bin/tsc --noEmit`；`git diff --check` | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_FIX-001_model-presets-context-windows.md` | 验收修复：更新 OpenAI/DeepSeek 官方预设、价格和默认上下文窗口，并让长文本翻译预算跟随当前模型；未启动前端服务 |
| QA-001 | 未开始 | — | 双格式自动化回归矩阵 | `test/ai/*`、`test/text-translation/*`、`test/translation/*`、`src/type/*test*` | `pnpm exec vitest run test/ai test/text-translation/model test/text-translation/service test/translation src/type/textTranslationIpc.test.ts`；`pnpm exec tsc --noEmit`；`git diff --check` | — | 需覆盖 Chat/Responses 成功、失败、截断、限流、恢复 |
| QA-002 | 未开始 | — | 真实供应商与 Electron 手工验收 | 验收记录、必要时补 `docs/v0.2.11/openai-api-format-compatibility/fix/*` | OpenAI Responses、OpenAI Chat、DeepSeek Chat、一个 Other Chat endpoint 手工验证；如启动服务需结束前清理 | — | 真实 API Key 不得写入日志或文档 |
| DOC-001 | 进行中 | — | README、隐私说明与发布文档同步 | `CHANGELOG.md`、`docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md` | `git diff --check`；提交前最终验证见实施记录 | `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_DOC-001_changelog-release-note.md` | 已补 0.2.11 CHANGELOG 发布说明；README/隐私说明仍需后续补齐 Responses 默认 `store:false` 和第三方兼容边界 |

## 6. 工作包详情

### PRE-001：API 格式 fixture 与 fake server 验证

目标：在正式改业务代码前，把 Chat Completions 与 Responses 的最小请求/响应差异固定成测试 fixture。

实施范围：

- 建立或扩展 fake model API server，支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`。
- 固定 Chat 成功、空响应、`finish_reason=length`、usage 明细、401/403/404/429/5xx、Retry-After。
- 固定 Responses 成功 `output_text`、`output[]` fallback、`status=incomplete`、usage 明细、401/403/404/429/5xx、Retry-After。
- 记录 Responses `store:false` 字段是否进入请求体。

验收口径：

- fake server 不访问真实网络。
- 后续 adapter 测试可直接复用 fake server。
- fixture 只覆盖稳定官方字段和已知兼容字段，不把厂商私有字段变成硬依赖。

### CORE-001：Endpoint normalization 与共享 API 类型

目标：统一 base URL / full endpoint 解析，消除各模块手写字符串替换。

实施范围：

- 新增 `ModelApiFormat`、`OutputTokenParameter` 类型。
- 新增 `normalizeModelEndpoint()`。
- 覆盖 base URL、`/chat/completions`、`/responses`、trailing slash 测试。
- 调整默认 OpenAI base URL 的设计口径，保持旧值迁移不被强改。

验收口径：

- 所有派生 URL 稳定。
- 不改变旧 profile 的实际请求 endpoint。
- 类型可被 Renderer、Electron main 和测试共同引用。

### CORE-002：ModelProfile v3 持久化迁移与 DTO 校验

目标：让运行时和恢复任务都能携带 API 格式信息。

实施范围：

- `useModelStore` persist version 升到 v3。
- 旧 profile 自动补 `apiFormat = "chat_completions"`。
- OpenAI 新建 profile 默认 `responses`，DeepSeek/Other 默认 `chat_completions`。
- `TextTranslationRuntimeModelConfig`、字幕 task 类型、IPC 校验补齐 `apiFormat/outputTokenParameter`。
- 旧恢复任务缺失 `apiFormat` 时按 Chat Completions 处理。

验收口径：

- 旧 localStorage 数据迁移后 assignment 不丢失。
- 旧恢复任务仍可继续。
- API Key 不进入恢复持久化结构。

### BE-001：ModelRuntimeClient 与 Chat Completions adapter

目标：把现有 Chat Completions 客户端收敛为统一 runtime 的一个 adapter，并保持旧测试通过。

实施范围：

- 新增 `sendModelRuntimeText()`。
- Chat adapter 复用现有重试、错误分类、think 清理、usage 映射。
- `openai-compatible-client.ts` 保留旧 export，内部委托新 runtime。
- 支持 `max_tokens` / `max_completion_tokens` 二选一。

验收口径：

- 现有 `openAICompatibleClient.test.ts` 行为不回退。
- API Key 脱敏仍通过。
- 空响应、截断、429 retry 和 abort 行为保持一致。

### BE-002：Responses 非流式文本 adapter

目标：支持任务型非流式 Responses 文本请求。

实施范围：

- `messages` 映射为 Responses `instructions` + `input`。
- 发送 `max_output_tokens` 和 `store:false`。
- 解析 `output_text` 和 `output[]`。
- 映射 Responses usage、incomplete 截断、HTTP 错误。
- 如兼容服务拒绝 `store` 字段，记录 follow-up capability 方案，不在本包内扩大 scope。

验收口径：

- Responses 成功结果返回统一 `ModelRuntimeTextResult.content`。
- 截断映射为不可重试 `length_truncated`。
- usage 映射到统一 token 字段。
- 错误消息不泄露 API Key。

### BE-003：长文本翻译接入双格式 runtime

目标：让长文本翻译任务型调用支持 Responses，并保持 Chat 行为。

实施范围：

- Renderer 创建 runtime model 时携带 `apiFormat/outputTokenParameter`。
- IPC 校验通过后主进程 service 调用 `sendModelRuntimeText()`。
- 现有 marker text 协议、memory patch、Markdown response protocol 不变。
- 更新 service E2E fake server 用例。

验收口径：

- Chat Completions 既有 E2E 通过。
- Responses E2E 覆盖至少 TXT parallel target-only。
- API Key 不进入 workspace。

### BE-004：字幕翻译迁移到 ModelRuntimeClient

目标：消除字幕模块手写 axios 请求，让字幕获得双格式支持和统一错误行为。

实施范围：

- `BaseTranslator.translateFragment()` 改为调用 runtime client。
- LRC/SRT 子类改为处理统一文本结果和 usage。
- 保留取消、并发分片、串行上下文、空译文重试和 checkpoint 行为。
- 更新 `test/translation/base-translator.test.ts`。

验收口径：

- LRC/SRT Chat 路径回归通过。
- Responses fake server 路径至少覆盖一个 LRC 或 SRT 成功用例。
- 空响应仍会重试。

### BE-005：名称翻译 Responses 路径与 JSON fallback

目标：让批量命名规划可在 Responses profile 下运行。

实施范围：

- Chat profile 保留现有 AI SDK structured output + text fallback。
- Responses profile 使用 runtime text JSON 路径或 IPC facade。
- 复用 `repairNameTranslationModelJsonText()` 与 zod schema 校验。
- 不把 Responses JSON schema 当成必要能力。

验收口径：

- Chat path 行为不变。
- Responses path 可从纯文本 JSON 解析出计划项。
- structured output 失败仍能 fallback。

### FE-001：设置页 API 格式 UI 与模型列表 URL 修正

目标：用户能显式配置 API 格式，模型列表拉取使用规范化 `/models`。

实施范围：

- Profile 编辑弹窗新增 API 格式 segmented control。
- Base URL placeholder/help text 更新。
- Chat Completions 高级项提供 output token 参数选择。
- `fetchOpenAIModels` 使用 `normalizeModelEndpoint().modelsUrl`。
- 补齐中英日繁 locale。

验收口径：

- 新建 OpenAI 默认 Responses，新建 DeepSeek/Other 默认 Chat。
- 旧 full endpoint 输入仍能拉取 `/models`。
- i18n 检查通过。

### FE-002：Profile assignment 能力校验与任务入参补齐

目标：UI 和工具入队时携带 API 格式，并阻止暂不支持的组合。

实施范围：

- 字幕、长文本页面创建任务时携带 `apiFormat/outputTokenParameter`。
- HomeAgent tool executor 入队字幕/文本任务时携带 API 格式。
- Agent adapter 完成前，Responses profile 分配给 Agent 时显示明确提示并阻止启动。
- 错误 toast 使用用户可理解的 API 格式文案。

验收口径：

- 任务 DTO 中不再丢失 API 格式。
- Agent 不会用未实现的 Responses path 半途失败。
- i18n 检查通过。

### AGENT-001：AgentRuntime Chat adapter 收口

目标：先把现有 Chat Completions Agent 行为包进 adapter，为 Responses adapter 留出稳定边界。

实施范围：

- 抽出 `ChatCompletionsAgentAdapter`。
- 保持 AI SDK `streamText`、tool loop、message conversion 和 usage 行为不变。
- 增加最小 agent adapter 单测或现有测试覆盖。

验收口径：

- 现有 HomeAgent Chat 行为不变。
- adapter 边界可承载未来 Responses implementation。

### AGENT-002：HomeAgent Responses 工具循环 adapter

目标：让 HomeAgent 支持 Responses profile。

实施范围：

- session messages 映射为 Responses input items。
- FusionKit tools 映射为 Responses function tools。
- function call output 回填下一轮 Responses input。
- streaming text delta 更新当前 `useAgentStore`。
- 支持 abort、step limit、usage、错误日志。

验收口径：

- Responses profile 可完成普通对话。
- Responses profile 可触发至少一个无破坏性工具预览流程。
- 取消和错误路径不会留下 streaming 状态。

### QA-001：双格式自动化回归矩阵

目标：在发布候选前收口自动化覆盖。

实施范围：

- 合并 Chat/Responses adapter、长文本、字幕、名称翻译关键测试。
- 覆盖失败分类、截断、限流、恢复、API Key 脱敏。
- 记录无法自动化的真实供应商项目。

验收口径：

- 指定回归命令通过。
- 失败 fixture 不访问真实网络。
- 台账和实施记录写明覆盖矩阵。

### QA-002：真实供应商与 Electron 手工验收

目标：确认真实服务与 UI 链路可用。

实施范围：

- OpenAI Responses：至少一个任务型文本调用。
- OpenAI Chat：旧格式回归。
- DeepSeek Chat：旧兼容服务回归。
- Other Chat endpoint：第三方兼容边界回归。
- Electron 设置页和工具页手工冒烟。

验收口径：

- 验收记录不包含 API Key。
- 如启动 Vite/Electron，结束前确认进程清理。
- 真实供应商不支持的能力要写清楚 fallback。

### DOC-001：README、隐私说明与发布文档同步

目标：把最终行为和隐私边界同步到用户文档。

实施范围：

- README 模型配置说明更新。
- 隐私说明补充 Responses 默认 `store:false`。
- 发布文档列出 Chat/Responses 支持范围和已知限制。
- 如实现变更设计契约，同步 Final Design 和本计划。

验收口径：

- 用户能理解何时选 Responses、何时选 Chat Completions。
- 第三方 OpenAI compatible 不保证支持 Responses 的边界明确。

## 7. 实施记录模板

````markdown
# 工作包 <ID>：<标题>

## 基本信息

- 日期：
- 状态：已完成 / 部分完成 / 阻塞
- 对应执行计划工作包：

## 本次实现内容

-

## 修改文件

-

## 接口或数据结构变化

-

## 验证结果

执行命令：

```text

```

结果：

-

## 未完成事项

-

## 下一步建议

-
````
