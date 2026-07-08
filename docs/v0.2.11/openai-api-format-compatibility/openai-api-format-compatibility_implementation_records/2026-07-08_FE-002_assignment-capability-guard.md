# 工作包 FE-002：Profile assignment 能力校验与任务入参补齐

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`FE-002`

## 本次实现内容

- 新增 Agent API 格式能力 helper，当前仅允许 `chat_completions` 进入 HomeAgent 运行链路；`responses` 会被明确阻止，等待 `AGENT-002` 的 Responses Agent adapter。
- HomeAgent 页面在 Agent profile 使用 Responses API 时显示警告、禁用发送按钮，并保留用户输入，避免启动会话后半途失败。
- Agent orchestrator 增加运行时兜底校验，并把 Chat Completions Agent provider 的 base URL 派生切到 `normalizeModelEndpoint()`，兼容历史 full endpoint。
- 设置页 Agent 模型分配阻止选择 Responses profile；如已有不支持组合，展示明确 warning。任务执行模型仍允许使用 Responses profile。
- HomeAgent 工具执行器创建字幕翻译任务、恢复字幕翻译任务时统一携带 `apiFormat/outputTokenParameter`。
- 补齐 `zh/en/ja/zh-Hant` 的 `home` 和 `setting` locale key。
- 增加 helper 单测，固定 Agent API 格式能力边界和字幕任务模型字段传递。

## 修改文件

- `src/agent/api-format-capability.ts`
- `src/agent/api-format-capability.test.ts`
- `src/agent/task-model-config.ts`
- `src/agent/task-model-config.test.ts`
- `src/agent/orchestrator.ts`
- `src/agent/tool-executor.ts`
- `src/pages/HomeAgent/index.tsx`
- `src/pages/Setting/components/ModelConfig.tsx`
- `src/locales/zh/home.json`
- `src/locales/en/home.json`
- `src/locales/ja/home.json`
- `src/locales/zh-Hant/home.json`
- `src/locales/zh/setting.json`
- `src/locales/en/setting.json`
- `src/locales/ja/setting.json`
- `src/locales/zh-Hant/setting.json`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 无持久化结构变化。
- 新增内部 helper：
  - `isAgentApiFormatSupported()` / `isAgentProfileApiFormatSupported()`
  - `createSubtitleTaskModelFields()`
- Agent 工具入队的 `SubtitleTranslatorTask` 现在会从任务模型 profile 带上 `apiFormat/outputTokenParameter`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/agent/api-format-capability.test.ts src/agent/task-model-config.test.ts src/agent/tool-schemas.test.ts src/agent/queue-batch.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node_modules/.bin/vitest run src/agent
node_modules/.bin/vitest run src/agent src/store/useModelStore.test.ts src/type/textTranslationIpc.test.ts src/type/textTranslation.test.ts src/lib/model-endpoint.test.ts src/services/rename/nameTranslationPlanner.test.ts test/ai/modelApiFormatProbe.test.ts test/ai/modelRuntimeClient.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts
git diff --check
```

结果：

- helper/Agent 初始测试：4 files、17 tests passed。
- `node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，8 个 namespace、4 套语言 key 数一致。
- `node_modules/.bin/vitest run src/agent`：7 files、41 tests passed。
- 关键回归矩阵：18 files、131 tests passed。
- `git diff --check`：通过。

## 未完成事项

- HomeAgent Responses 工具循环仍未实现；Responses profile 目前会被 Agent UI 和 orchestrator 阻止，后续由 `AGENT-001`/`AGENT-002` 完成。
- 当前 Agent 工具集合没有长文本翻译入队工具；长文本翻译页面创建/恢复任务的 runtime model 入参已在 `BE-003` 补齐，本包仅记录该真实边界。
- 本次未启动 Vite/Electron 服务进行视觉验收。

## 下一步建议

- 认领 `AGENT-001`：先把现有 Chat Completions Agent 行为包入稳定 adapter 边界，为 `AGENT-002` 的 Responses 工具循环实现做准备。
