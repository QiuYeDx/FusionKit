# 工作包 DOC-001：CHANGELOG 发布说明更新

## 基本信息

- 日期：2026-07-08
- 状态：部分完成
- 对应执行计划工作包：`DOC-001`

## 本次实现内容

- 根据已完成的 OpenAI 新旧 API 格式兼容开发内容，更新 `CHANGELOG.md` 的 `0.2.11` 条目。
- 补充模型配置 API 格式选择、Responses API runtime、长文本/字幕/名称翻译接入、HomeAgent Responses 工具循环、endpoint normalization、`store:false` 和 API Key 脱敏等发布说明。
- 更新 v0.2.11 主题入口与执行计划台账，明确 `DOC-001` 当前仅完成发布说明部分，README/隐私说明仍待后续补齐。

## 修改文件

- `CHANGELOG.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/openai-api-format-compatibility/openai-api-format-compatibility_execution_plan.md`

## 接口或数据结构变化

- 无代码接口或持久化结构变化。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
git diff --check
```

结果：

- `node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，zh/en/ja/zh-Hant key 数一致。
- `git diff --check`：通过。

## 未完成事项

- README 尚未补充何时选择 Responses / Chat Completions、Responses 默认 `store:false` 和第三方 OpenAI Compatible 兼容边界。
- 隐私说明尚未单独补充 Responses API 默认无状态意图。

## 下一步建议

- 在 `DOC-001` 后续收尾中补齐 README/隐私说明；如果发布前只要求 CHANGELOG，可继续保持本记录为部分完成。
