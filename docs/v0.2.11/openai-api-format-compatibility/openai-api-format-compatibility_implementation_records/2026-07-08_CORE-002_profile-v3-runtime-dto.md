# 工作包 CORE-002：ModelProfile v3 持久化迁移与 DTO 校验

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`CORE-002`

## 本次实现内容

- 将 `ModelProfile.apiFormat` 提升为 v3 profile 的必备字段，保留 `outputTokenParameter` 为可选兼容字段。
- `useModelStore` persist version 升级到 v3，新增 profile 规范化与 v1/v2 -> v3 迁移 helper。
- 旧 profile、旧 localStorage key 迁移时固定补 `apiFormat = "chat_completions"`；新建 OpenAI profile 默认 `responses`，DeepSeek/Other 默认 `chat_completions`。
- 扩展长文本翻译 runtime model DTO、IPC 校验、resume/restart/retranslate 校验路径，缺失 `apiFormat` 的旧请求默认按 Chat Completions 处理。
- 长文本任务持久化 manifest 新增非敏感 model ref：`profileId/modelKey/endpointLabel/apiFormat`，继续不写入 `apiKey` 或完整 endpoint。
- 字幕任务类型预留 `apiFormat/outputTokenParameter` 字段，并复用共享模型 API 格式类型。
- 长文本工具页面创建 runtime model 时携带 `apiFormat/outputTokenParameter`。

## 修改文件

- `src/type/model.ts`
- `src/constants/model.ts`
- `src/store/useModelStore.ts`
- `src/store/useModelStore.test.ts`
- `src/type/textTranslation.ts`
- `src/type/textTranslationIpc.ts`
- `src/type/textTranslationIpc.test.ts`
- `src/type/textTranslation.test.ts`
- `src/type/subtitle.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `electron/main/text-translation/ipc.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `electron/main/translation/typing.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- `ModelProfile`：
  - `apiFormat: ModelApiFormat`
  - `outputTokenParameter?: OutputTokenParameter`
- `TextTranslationRuntimeModelConfig`：
  - `apiFormat: ModelApiFormat`
  - `outputTokenParameter?: OutputTokenParameter`
- `TextTranslationPersistedModelRef`：
  - `apiFormat?: ModelApiFormat`
- 新增校验函数：
  - `validateResumeTextTranslationTaskIpcRequest()`
- `fusionkit-model` zustand persist version 从 `2` 升到 `3`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/store/useModelStore.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts src/lib/model-endpoint.test.ts test/ai/modelApiFormatProbe.test.ts
node_modules/.bin/vitest run test/text-translation/service/textTranslationService.e2e.test.ts -t "prepares, translates, persists, and assembles a single TXT task"
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- 核心单测与协议 fixture：5 个测试文件、31 个测试通过。
- 长文本服务 E2E 单用例：1 个测试通过、13 个同文件用例按 `-t` 跳过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- `sendOpenAICompatibleChatCompletion` 仍是旧 Chat Completions 客户端，尚未收口到统一 `ModelRuntimeClient`。
- Responses 非流式文本 adapter 尚未实现，长文本 service 当前仍调用旧 Chat client。
- 设置页 API 格式控件、模型列表 URL normalization、Agent assignment 能力限制仍待后续工作包完成。

## 下一步建议

- 认领 `BE-001`：新增 `ModelRuntimeClient` 与 Chat Completions adapter，保留旧 `sendOpenAICompatibleChatCompletion` export 并委托到新 runtime，确保现有 Chat 行为、错误分类、脱敏、Retry-After、abort 和 token 参数选择不回退。
