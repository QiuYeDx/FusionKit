# 字幕结构编辑与双语导入

2026-10-10，基线 `f869d2e`（分支 v0.4.0）。

起因是用户试用时发现两类问题：

1. 转写得到的字幕常有瑕疵，例如相邻两个时间点重复识别了同一句（「像前辈这样一大早就犯困的」出现两次），本应合并为一条（开始取前一条、结束取后一条、文字去重）；但字幕工作台只能删除字幕，不能合并、不能改时间，AI 修订和 Agent 也只能改文字。
2. 导入双语 LRC（同一时间戳下一行日文、一行中文）时，全部平铺成原文，而不是识别为原文 + 译文。

## 文档

- [业务范围与路线图](brd.md)：问题与根因、目标、跨批次原则、BR-01..03 与 I1..I3。
- 模块需求、设计与任务：
  - [module-import](modules/module-import/requirements.md)：导入时识别双语、撤销识别（I1）。
  - [module-structure](modules/module-structure/requirements.md)：合并相邻字幕、调整时间、结构编辑的撤销与导出（I2）。
  - [module-revision](modules/module-revision/requirements.md)：相邻重复检测、AI 修订提出合并与删除、Agent 准备结构修复（I3）。
- `spec.json`：批次、批准与决策。

## 批次

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| I1 | 双语字幕导入即识别 | 已实现，待用户验收 |
| I2 | 合并、调整时间（含撤销与导出） | 已实现，待用户验收 |
| I3 | 重复检测、AI 修订与 Agent 结构修复 | 已实现，待用户验收 |

实施与验证证据见 [records/integration.md](records/integration.md)（各任务记录 `records/T-*.md`，截图在 `records/screenshots/`），任务总览见 [task-list-overall.md](task-list-overall.md)。

## 恢复工作

读 spec.json 的 `current_increment` 与批准，再读对应模块的 requirements → design → tasks；证据放在 `records/`。

```bash
python <spec-driven-ai-coding>/scripts/check_spec.py docs/features/studio-cue-structure --stage ready
```
