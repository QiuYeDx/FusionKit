# 验收修复：模型预设与上下文窗口校准

## 背景和观察

- 手工测试发现模型配置页的 OpenAI 预设列表偏旧，只到 `gpt-5.2` / `gpt-5` 系列，未包含当前官方页面已有的 `gpt-5.5` 与 `gpt-5.4` 系列。
- 长文本翻译配置面板仍展示固定的 `32,768` token 模型上下文窗口，导致 DeepSeek V4 Flash 等 1M 上下文模型被明显低估。
- `inferContextWindowSize()` 中存在 `key.includes("gpt") -> 272_000` 的过宽兜底，并且在更具体的 `gpt-5` 判断之前命中，容易让 OpenAI 新模型显示旧窗口。

## 官方来源

- OpenAI 官方模型页：
  - `https://developers.openai.com/api/docs/models/gpt-5.5`：`gpt-5.5` 默认上下文窗口 `1,050,000`，文本价格 input `$5.00` / output `$30.00` per 1M tokens。
  - `https://developers.openai.com/api/docs/models/gpt-5.5-pro`：`gpt-5.5-pro` 默认上下文窗口 `1,050,000`，文本价格 input `$30.00` / output `$180.00` per 1M tokens，页面说明该模型面向 Responses API 请求。
  - `https://developers.openai.com/api/docs/models/gpt-5.4`：`gpt-5.4` 默认上下文窗口 `1,050,000`，文本价格 input `$2.50` / output `$15.00` per 1M tokens。
  - `https://developers.openai.com/api/docs/models/gpt-5.4-pro`：`gpt-5.4-pro` 默认上下文窗口 `1,050,000`，文本价格 input `$30.00` / output `$180.00` per 1M tokens，页面说明该模型仅用于 Responses API。
  - `https://developers.openai.com/api/docs/models/gpt-5.4-mini`：默认上下文窗口 `400,000`，文本价格 input `$0.75` / output `$4.50` per 1M tokens。
  - `https://developers.openai.com/api/docs/models/gpt-5.4-nano`：默认上下文窗口 `400,000`，文本价格 input `$0.20` / output `$1.25` per 1M tokens。
  - `https://developers.openai.com/api/docs/models/gpt-5.2`、`gpt-5`、`gpt-5-mini`、`gpt-5-nano`：官方页面存在，默认上下文窗口为 `400,000`。
- DeepSeek 官方模型与价格页：`https://api-docs.deepseek.com/quick_start/pricing`
  - `deepseek-v4-flash`、`deepseek-v4-pro` 默认上下文长度为 `1M`，最大输出为 `384K`。
  - `deepseek-chat` 与 `deepseek-reasoner` 将于 `2026/07/24 15:59 UTC` 废弃，并分别对应 `deepseek-v4-flash` 的 non-thinking / thinking mode 兼容别名。
  - `deepseek-v4-flash` 价格为 cache miss input `$0.14` / output `$0.28` per 1M tokens；`deepseek-v4-pro` 为 cache miss input `$0.435` / output `$0.87` per 1M tokens。

## 根因

- 模型预设列表没有跟随官方模型页更新，且 `OPENAI_MODEL_OPTIONS` 只维护价格，没有维护上下文窗口，导致 UI 列表和上下文推断来自两套不一致的数据。
- 长文本翻译页在预算计算、提示和任务 options 构造中直接使用 `DEFAULT_TEXT_TRANSLATION_MODEL_CONTEXT_TOKEN_LIMIT = 32_768`，没有根据当前任务模型计算。
- `inferContextWindowSize()` 使用宽泛字符串包含判断，OpenAI 新模型被旧兜底覆盖；DeepSeek legacy alias 仍按旧版 128K 处理。

## 预期行为

- OpenAI 预设列表按当前官方模型更新，默认新建 OpenAI profile 仍取列表首项，即 `gpt-5.5`。
- OpenAI / DeepSeek 预设模型都在同一份 metadata 中维护 `contextWindow`，`inferContextWindowSize()` 优先精确匹配预设。
- DeepSeek V4 Flash/Pro 以及 `deepseek-chat` / `deepseek-reasoner` 兼容别名均推断为默认 `1,000,000` token 上下文窗口。
- 长文本翻译预算提示、进度条、预算超限判断和任务创建 options 使用当前模型推断出的上下文窗口；仅在未选择模型时回退到 32K 默认值。

## 影响文件

- `src/constants/model.ts`
- `src/constants/model.test.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/pages/Tools/Text/TextTranslator/components/ConfigPanel.tsx`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_implementation_records/2026-07-08_FIX-001_model-presets-context-windows.md`

## 验证结果

```text
node_modules/.bin/vitest run src/constants/model.test.ts src/type/textTranslation.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

- `node_modules/.bin/vitest run src/constants/model.test.ts src/type/textTranslation.test.ts`：通过，2 个测试文件、13 个测试用例 passed。
- `node_modules/.bin/tsc --noEmit`：通过。
- `git diff --check`：通过。

本次修复不新增用户可见 i18n 文案；模型 label 与既有预设常量一致，未运行 i18n 检查。

## 后续建议

- 后续如要更细地限制 Pro 模型只在 Responses API 中出现，可给模型预设增加 `supportedApiFormats` 并在设置页根据当前 API 格式过滤或提示。
- 真实供应商验收时重点确认 OpenAI Pro 模型请求耗时与 background mode 需求，避免普通前台请求超时被误判为兼容失败。
