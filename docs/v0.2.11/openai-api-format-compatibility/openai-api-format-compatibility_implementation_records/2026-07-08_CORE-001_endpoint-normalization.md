# 工作包 CORE-001：Endpoint normalization 与共享 API 类型

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`CORE-001`

## 本次实现内容

- 新增 `ModelApiFormat` 与 `OutputTokenParameter` 共享类型。
- 在 `ModelProfile` 上预留 `apiFormat` 与 `outputTokenParameter` 字段；本包保持 optional，避免在持久化迁移前破坏现有 profile。
- 新增默认 base URL、默认 API 格式、默认输出 token 参数常量。
- 新增 `normalizeModelEndpoint()`，统一处理 base URL、历史 `/chat/completions` full endpoint、新 `/responses` full endpoint、trailing slash 与空字符串。
- 新增单测固定 URL 派生行为和 provider 默认值。

## 修改文件

- `src/type/model.ts`
- `src/constants/model.ts`
- `src/lib/model-endpoint.ts`
- `src/lib/model-endpoint.test.ts`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`
- `docs/v0.2.11/README.md`

## 接口或数据结构变化

- 新增类型：
  - `ModelApiFormat = "chat_completions" | "responses"`
  - `OutputTokenParameter = "max_tokens" | "max_completion_tokens"`
- `ModelProfile` 新增可选字段：
  - `apiFormat?: ModelApiFormat`
  - `outputTokenParameter?: OutputTokenParameter`
- 新增常量：
  - `DEFAULT_MODEL_BASE_URL_MAP`
  - `DEFAULT_MODEL_API_FORMAT_MAP`
  - `DEFAULT_OUTPUT_TOKEN_PARAMETER_MAP`
- 新增工具：
  - `normalizeModelEndpoint(input: string): NormalizedModelEndpoint`

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/lib/model-endpoint.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
git diff --no-index --check /dev/null src/lib/model-endpoint.ts
git diff --no-index --check /dev/null src/lib/model-endpoint.test.ts
```

结果：

- `node_modules/.bin/vitest run src/lib/model-endpoint.test.ts`：1 个测试文件、7 个测试通过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。
- 新增 endpoint 工具和测试单文件 whitespace 检查：通过。

## 未完成事项

- `ModelProfile` 的 v3 持久化迁移、默认值填充、旧恢复任务兼容还未实现，交由 `CORE-002`。
- 现有设置页、任务 DTO 和业务调用链尚未消费 `apiFormat/outputTokenParameter`，分别由后续 `CORE-002`、`FE-001/FE-002`、`BE-*` 工作包推进。

## 下一步建议

- 认领 `CORE-002`：升级 `useModelStore` persist version，补齐旧 profile 的 `apiFormat/outputTokenParameter`，扩展运行时 DTO 与 IPC 校验，并确保旧恢复任务缺失 `apiFormat` 时默认按 Chat Completions 处理。
