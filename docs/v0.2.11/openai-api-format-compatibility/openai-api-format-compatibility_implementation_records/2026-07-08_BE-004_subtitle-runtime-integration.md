# 工作包 BE-004：字幕翻译迁移到 ModelRuntimeClient

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`BE-004`

## 本次实现内容

- `BaseTranslator.translateFragment()` 从手写 `axios.post` Chat Completions 请求迁移为 `sendModelRuntimeText()`。
- 字幕 task 运行时模型配置现在使用 `apiKey/apiModel/endPoint/apiFormat/outputTokenParameter` 构造统一 runtime model。
- BaseTranslator 外层分片重试、空结果重试、AbortSignal 取消、checkpoint resolved/failed 标记和 recovery artifact 刷新行为保留。
- runtime 返回的不可重试错误会立即停止外层重试；可重试错误继续走字幕模块原有分片重试，并尊重 runtime error 的 `Retry-After` 延迟。
- LRC/SRT 子类的 `parseResponse()` 改为处理统一 `ModelRuntimeTextResult.content/usage`。
- 字幕普通任务创建与恢复导入任务均携带 `apiFormat/outputTokenParameter`。
- 新增不 mock runtime 的字幕 Responses fake server 测试，验证 `/v1/responses`、`store:false` 和输出文件写入。

## 修改文件

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/class/lrc-translator.ts`
- `electron/main/translation/class/srt-translator.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/pages/Tools/Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx`
- `test/translation/base-translator.test.ts`
- `test/translation/base-translator-runtime.test.ts`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 字幕翻译 task 运行时开始消费：
  - `apiFormat?: "chat_completions" | "responses"`
  - `outputTokenParameter?: "max_tokens" | "max_completion_tokens"`
- `BaseTranslator.parseResponse()` 子类契约从 Chat Completions raw response 改为 `ModelRuntimeTextResult`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts
node_modules/.bin/vitest run test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/service/textTranslationService.e2e.test.ts -t "BaseTranslator|ModelRuntimeClient|OpenAI Compatible client|Responses runtime adapter"
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- 字幕 BaseTranslator 测试：2 个测试文件、2 个测试通过。
- 组合回归：5 个测试文件、18 个测试通过、14 个同文件用例按 `-t` 跳过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- 字幕完整 LRC/SRT Chat/Responses 矩阵尚未全面展开，留给 `QA-001` 或手工验收补充。
- 名称翻译仍未接入 Responses path。
- 设置页 API 格式 UI 和 Agent assignment 能力限制尚未完成。

## 下一步建议

- 认领 `BE-005`：名称翻译在 `responses` profile 下走 runtime text JSON path，继续保留 Chat profile 的 AI SDK structured output 与纯文本 JSON repair fallback。
