# 工作包 PRE-001：API 格式 fixture 与 fake server 验证

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`PRE-001`

## 本次实现内容

- 新增可复用 fake model API server，支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`。
- 新增 Chat Completions fixture，覆盖 OpenAI 风格 `choices`、`finish_reason`、usage 与 `reasoning_content` 兼容字段。
- 新增 Responses fixture，覆盖 `output_text`、`output[]` fallback、`status=incomplete` + `incomplete_details.reason=max_output_tokens`、usage 与 `store:false` 请求捕获。
- 新增模型列表 fixture 与 OpenAI 风格错误响应 fixture，覆盖 unexpected route、HTTP 429 和 `Retry-After`。

## 修改文件

- `test/ai/fakeModelApiServer.ts`
- `test/ai/modelApiFormatProbe.test.ts`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`
- `docs/v0.2.11/README.md`

## 接口或数据结构变化

- 未修改生产代码接口。
- 新增测试工具导出：
  - `startFakeModelApiServer()`
  - `createChatCompletionBody()`
  - `createResponsesBody()`
  - `createModelsBody()`
  - `createErrorBody()`

## 验证结果

执行命令：

```text
pnpm --version
node_modules/.bin/vitest run test/ai/modelApiFormatProbe.test.ts
git diff --check
git diff --no-index --check /dev/null test/ai/fakeModelApiServer.ts
git diff --no-index --check /dev/null test/ai/modelApiFormatProbe.test.ts
```

结果：

- `pnpm --version` 输出 `11.7.0`，高于项目常用 8.x，因此未使用 `pnpm exec`，改用本地 `node_modules/.bin/vitest`，避免 lockfile v6 被新 pnpm 触碰。
- `node_modules/.bin/vitest run test/ai/modelApiFormatProbe.test.ts`：1 个测试文件、7 个测试通过。
- `git diff --check`：通过。
- 新增测试工具单文件 whitespace 检查：通过。

## 未完成事项

- 旧 `test/text-translation/protocol/fakeOpenAICompatibleServer.ts` 暂未迁移，本包只新增双格式 fake server，避免影响长文本既有 PRE-003 测试。
- 生产 runtime client 尚未实现，由后续 `BE-001`、`BE-002` 工作包完成。

## 下一步建议

- 认领 `CORE-001`：新增 `ModelApiFormat` / `OutputTokenParameter` 类型与 `normalizeModelEndpoint()`，并用单测固定 base URL、`/chat/completions`、`/responses` 和 trailing slash 行为。
