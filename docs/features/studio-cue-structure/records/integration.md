# 集成结果（I1–I3）

2026-10-11，基线 f869d2e + 未提交工作树。任务记录见本目录 `T-*.md`。

## 用户能做什么

- **双语字幕导入即识别**：导入像「01某邮局的工作 - ある郵便局のお仕事.lrc」这样的双语 LRC，无论单个、批量还是让 Agent 按路径导入，都直接成为日文原文 + 中文译文；识别错了可「按原样导入」。
- **合并与改时间**：选中相邻字幕 →「合并」/Ctrl+M（首开始、末结束、文字去重，译文同步）；双击时间或按 T 编辑开始/结束；「平移时间…」整体移动所选字幕；全部可撤销，转写文档同样可用。
- **重复修复**：AI 修订对话框「检查相邻重复」不用模型就能找出重复识别并建议合并；向 AI 修订说“合并重复识别的句子、删掉片尾语”时，模型也能提出合并与删除；都在预览中逐条确认后一次应用。
- **Agent**：说“把第 19、20 条合并”“把第 5 条开始改到 00:01:02.300”“找出所有重复识别的片段”，Agent 会在预览中准备好，由你应用。

## 验证摘要（最终代码）

| 范围 | 结果 |
| --- | --- |
| 单元（导入/结构/修订/Agent） | 全部通过：file:records/import-01-unit.log、structure-01-unit.log、revision-01-unit.log、revision-02-unit.log、revision-03-unit.log |
| 全量 vitest | src 1090 通过；test 5549 通过、2 失败 → 两项为本次改动所致（来源审计中 timingRevision 旧规则、边界检查因新测试引入 Agent 模块），修正后 59/59 通过：file:records/full-regression-src.log、full-regression-test.log、full-regression-fixed.log |
| 来源审计 / Studio 边界 / 类型 / i18n | 424 通过 / 0 错误 / 0 错误 / 全部可解析：file:records/import-01-provenance.log、boundaries.log、static-tsc.log、static-i18n.log |
| Electron（最终构建，25 个文件） | 21 通过；6 失败均为既有问题：5 项在未改动的 f869d2e 工作树上以相同位置失败（已另开任务），agent-handoff 滚动条断言为此前已知问题：file:records/final-electron.log |

## 截图索引

| 文件 | 内容 |
| --- | --- |
| screenshots/studio-bilingual-import--01-import-result-1280-light.png | 多文件导入结果注明双语 |
| screenshots/studio-bilingual-import--02-separated-1280-light.png | 导入即为原文 + 译文，提示条与标签 |
| screenshots/studio-bilingual-import--03-separated-786-dark.png | 窄窗口深色 |
| screenshots/studio-bilingual-import--04-revert-confirm-786-dark.png | 按原样导入确认 |
| screenshots/studio-cue-structure--01-selected-repetition-1280-light.png | 选中重复的两条，工具栏合并 |
| screenshots/studio-cue-structure--02-merged-1280-light.png | 合并后 |
| screenshots/studio-cue-structure--03-time-error-1280-light.png | 时间编辑与就地错误 |
| screenshots/studio-cue-structure--04-shift-1280-light.png | 平移时间 |
| screenshots/studio-cue-structure--05-time-editor-786-dark.png | 窄列深色时间编辑 |
| screenshots/studio-cue-structure-revision--01-duplicates-1280-light.png | 相邻重复检查结果 |
| screenshots/studio-cue-structure-revision--02-model-structure-1280-light.png | 模型提出的合并与删除 |
| screenshots/studio-cue-structure-revision--03-agent-prepared-1280-light.png | Agent 准备的合并 |
| screenshots/studio-cue-structure-revision--04-duplicates-786-dark.png | 窄窗口深色 |

## 未覆盖与待用户验收

- 真实模型对结构修复的遵循度、Agent 把说法换算为编号的准确度需试用。
- ja / zh-Hant 界面未截图审阅；拆分字幕未实现（后续批次）。
- 测试期间本机 C 盘一度只剩约 50 MB（导致一次全量测试崩溃）；已清理本次测试产生的临时配置目录。
- 用户验收未签署（spec.json acceptance 为 pending）。
