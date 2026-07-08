# 工作包 FE-001：设置页 API 格式 UI 与模型列表 URL 修正

## 基本信息

- 日期：2026-07-08
- 状态：已完成
- 对应执行计划工作包：`FE-001`

## 本次实现内容

- 设置页模型配置弹窗新增 API 格式分段控件：`Responses API` / `Chat Completions`。
- 新建 profile 使用 provider 默认 API 格式：OpenAI 默认 Responses，DeepSeek/Other 默认 Chat Completions。
- 所有 provider 都显示 Base URL 输入与格式相关提示，兼容 base URL、历史 `/chat/completions` endpoint 和 `/responses` endpoint。
- Chat Completions 下新增输出 token 参数选择：`max_tokens` / `max_completion_tokens`。
- 模型 profile 列表显示当前 API 格式 badge。
- OpenAI 远程模型列表拉取改用 `normalizeModelEndpoint().modelsUrl`，不再只替换 `/chat/completions`。
- 补齐 `zh/en/ja/zh-Hant` 四套 `setting` locale key。

## 修改文件

- `src/pages/Setting/components/ModelConfig.tsx`
- `src/locales/zh/setting.json`
- `src/locales/en/setting.json`
- `src/locales/ja/setting.json`
- `src/locales/zh-Hant/setting.json`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_final_design.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 无新增数据结构；本包开始在 UI 保存 `ModelProfile.apiFormat/outputTokenParameter`。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
git diff --check
```

结果：

- `node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，8 个 namespace、4 套语言 key 数一致。
- `git diff --check`：通过。

## 未完成事项

- Agent assignment 对 Responses profile 的能力限制尚未实现。
- 字幕/长文本工具入队路径已携带 API 格式；HomeAgent tool executor 等 assignment 相关路径待 `FE-002` 继续检查。
- 本次未启动 Vite/Electron 做视觉验收。

## 下一步建议

- 认领 `FE-002`：补齐 profile assignment 能力校验与任务入参检查，尤其是在 Agent Responses adapter 完成前阻止 Responses profile 用于 HomeAgent。
