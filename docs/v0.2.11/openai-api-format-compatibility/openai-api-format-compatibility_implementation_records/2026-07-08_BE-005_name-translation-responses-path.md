# 工作包 BE-005：名称翻译 Responses 路径与 JSON fallback

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`BE-005`

## 本次实现内容

- 名称翻译 planner 在 `taskProfile.apiFormat === "responses"` 时走 Responses text JSON path。
- Responses path 使用 renderer-side `fetch` 调用 normalized `/responses`，避免 renderer 直接导入 Electron main runtime。
- Responses 请求发送 `instructions/input/max_output_tokens/store:false`，不依赖 Responses structured output 或 JSON schema。
- Responses 输出解析支持 `output_text` 和 `output[].content[]` fallback，并复用现有 `repairNameTranslationModelJsonText()` 与 zod schema 校验。
- Chat profile 继续保留现有 AI SDK `generateObject()` structured output + `generateText()` text fallback 路径。
- Chat profile 的 AI SDK base URL 改用 `normalizeModelEndpoint().baseUrl`，兼容历史 `/chat/completions` full endpoint。
- Responses HTTP 错误消息会脱敏 API Key，并保留 HTTP 状态供现有限流/非恢复错误分类使用。

## 修改文件

- `src/services/rename/nameTranslationPlanner.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 新增导出 helper：
  - `translateBatchWithResponsesProfile(profile, system, prompt, maxOutputTokens)`
- 名称翻译默认模型调用现在消费 `ModelProfile.apiFormat`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/services/rename/nameTranslationPlanner.test.ts
node_modules/.bin/vitest run src/services/rename/nameTranslationPlanner.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `src/services/rename/nameTranslationPlanner.test.ts`：1 个测试文件、27 个测试通过。
- 组合回归：3 个测试文件、42 个测试通过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- Responses 名称翻译当前使用 renderer `fetch`，不经过主进程代理设置；如需要统一代理，可在后续补主进程 IPC/facade。
- 设置页 API 格式 UI、模型列表 URL normalization 和 Agent assignment 能力限制尚未完成。

## 下一步建议

- 认领 `FE-001`：设置页增加 API 格式控件、Chat token 参数高级项，并让模型列表拉取使用 `normalizeModelEndpoint().modelsUrl`。
