# 工作包 DOC-001：README、i18n、隐私与发布说明

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：DOC-001

## 本次实现内容

- README 新增 0.2.10 版本亮点，介绍长文本翻译 Beta、串行语义记忆、恢复、TXT 输出和 Markdown 结构保护能力。
- README 新增“长文本翻译（Beta）”功能段落，说明单/多 TXT、独立任务队列、有序项目、串行模式、输出模式、恢复和预算提示。
- README 补充隐私与费用提示：
  - Renderer 只传文件路径，不读取整本正文。
  - 正文会发送到用户配置的模型服务。
  - API Key 不写入长文本翻译工作区。
  - 串行语义记忆会增加输入 token 和费用。
- README 项目结构补充 `electron/main/text-translation/`。
- CHANGELOG 新增 0.2.10 条目，记录新增能力、安全隐私边界和当前限制。

## 修改文件

- `README.md`
- `CHANGELOG.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 验证结果

执行命令：

```text
pnpm run i18n:check
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 927 个 key，全量通过。
- `git diff --check`：通过。

## 未完成事项

- 端到端 Markdown 翻译入口仍未开放，README/CHANGELOG 已标注限制。
- 真实模型与跨平台手工验收仍由 QA 工作包覆盖。

## 下一步建议

- 继续认领 `DOC-002：工作区清理与兼容策略收口`。
- DOC-002 应明确 successful workspace 7 天保留、非成功任务审核策略、旧 schema 只读兼容和删除路径安全边界。
