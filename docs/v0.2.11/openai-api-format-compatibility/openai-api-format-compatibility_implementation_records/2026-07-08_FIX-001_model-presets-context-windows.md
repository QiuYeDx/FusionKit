# 工作包 FIX-001：模型预设与上下文窗口校准

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`FIX-001`

## 本次实现内容

- 根据 OpenAI 官方模型页更新 OpenAI 预设列表，新增 `gpt-5.5`、`gpt-5.5-pro`、`gpt-5.4`、`gpt-5.4-pro`、`gpt-5.4-mini`、`gpt-5.4-nano`，并保留 `gpt-5.2` 与 `gpt-5` 系列。
- 为 OpenAI / DeepSeek 预设统一维护 `contextWindow`，让 `inferContextWindowSize()` 优先使用精确预设匹配。
- 根据 DeepSeek 官方模型与价格页校准 V4 Flash/Pro、`deepseek-chat`、`deepseek-reasoner` 的默认 1M 上下文窗口，并更新 V4 Pro 与兼容别名价格。
- 修复长文本翻译配置页固定使用 32K 上下文窗口的问题，使预算计算、进度条、超限判断和任务 options 跟随当前模型。
- 新增验收修复文档，记录官方来源、根因、预期行为和验证计划。

## 修改文件

- `src/constants/model.ts`
- `src/constants/model.test.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/pages/Tools/Text/TextTranslator/components/ConfigPanel.tsx`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`
- `docs/v0.2.11/openai-api-format-compatibility/fix/2026-07-08_openai-api-format-compatibility_model-presets-context-windows.md`

## 接口或数据结构变化

- `OPENAI_MODEL_OPTIONS` 与 `DEEPSEEK_MODEL_OPTIONS` 的预设项新增 `contextWindow` 字段。
- 未改变 `ModelProfile` 持久化结构、IPC DTO 或模型运行时请求格式。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/constants/model.test.ts src/type/textTranslation.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

结果：

- `node_modules/.bin/vitest run src/constants/model.test.ts src/type/textTranslation.test.ts`：通过，2 个测试文件、13 个测试用例 passed。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。
- 本次没有启动 Vite、Electron 或其他前端服务。

## 未完成事项

- 无。

## 下一步建议

- 若后续要避免用户把 OpenAI Pro 模型用于 Chat Completions，可给预设项继续增加 `supportedApiFormats` 并在设置页展示明确提示。
