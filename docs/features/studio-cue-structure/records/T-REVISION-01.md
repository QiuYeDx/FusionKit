# 实施记录：T-REVISION-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-REVISION-01 |
| 日期 | 2026-10-11 |
| 验证版本 | f869d2e + 本会话未提交改动（studio-cue-structure 工作树） |
| 环境 | Windows 11，Node 20.19.4（vitest 2.1.9），Electron（Playwright 1.58.2） |
| 任务指纹 | 61304d2a5042cb5684f3d36bc10773cda7fc24316066a1541e032e4d1bc90cf7 |

## 实际结果

- `findAdjacentDuplicates`：相邻、开始不倒退且间隔 ≤10 秒、原文重复（规范化后相同或互含 ≥50%）的连续字幕合为一组合并提案；`revisionOperation` 把改字、合并、删除、改时间组成一次编辑（只有改字时仍为 revise）。
- AI 修订对话框新增「检查相邻重复」（无需模型）；结构提案行：序号范围、标签（合并/删除/改时间）、时间范围、合并结果与被替换的原句（删除线）；摘要「建议修改：合并 2 处（共检查 14 条）」；无模型时页脚不显示用量。
- 用户样本中检测到第 9–10 条一处，合并结果与 AC 一致；取消另一组后只合并勾选的组，撤销一次恢复。截图已审阅：screenshots/studio-cue-structure-revision--01、--04。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-REVISION-01-1 | 通过 | file:records/revision-01-unit.log |
| V-REVISION-01-2 | 通过 | file:records/final-electron.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-REVISION-01-1 | 通过 | V-REVISION-01-1, V-REVISION-01-2 |
| AC-REVISION-01-2 | 通过 | V-REVISION-01-2 |
| AC-REVISION-01-3 | 通过 | V-REVISION-01-1 |

## 风险与未执行项

有意重复的台词（如反复的口头禅）也可能被提出，预览中可取消。
