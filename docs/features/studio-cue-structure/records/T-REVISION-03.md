# 实施记录：T-REVISION-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-REVISION-03 |
| 日期 | 2026-10-11 |
| 验证版本 | f869d2e + 本会话未提交改动（studio-cue-structure 工作树） |
| 环境 | Windows 11，Node 20.19.4（vitest 2.1.9），Electron（Playwright 1.58.2） |
| 任务指纹 | 321a82af7b4ce4a389a8349f49e574ae6300df8be80bf78943ed32f0463857bf |

## 实际结果

- 新页面工具 `studio_prepare_cue_edits`（合并 from–to、删除编号、改某条开始/结束；不调用模型，读取所需页面后在预览中显示「这些修改由 Agent 按你的要求准备」）与 `studio_find_duplicates`（所选或整篇）；稳定错误码与四语言提示；工具行名称。
- `revision_applied` 事件值增加 merged/deleted/retimed；不需要回应时静默记入对话，Agent 下一轮可见（此前会被丢弃）。页面说明补充何时使用这两个工具。
- Electron：脚本模型调用 `studio_prepare_cue_edits` 合并第 9–10 条，预览显示「已准备：合并 1 处」，不发出修订请求；应用后下一轮请求中带有「1 merge(s)」。截图已审阅：screenshots/studio-cue-structure-revision--03。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-REVISION-03-1 | 通过 | file:records/revision-03-unit.log |
| V-REVISION-03-2 | 通过 | file:records/final-electron.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-REVISION-03-1 | 通过 | V-REVISION-03-1, V-REVISION-03-2 |
| AC-REVISION-03-2 | 通过 | V-REVISION-03-1 |
| AC-REVISION-03-3 | 通过 | V-REVISION-03-1 |

## 风险与未执行项

真实模型能否把用户说法正确换算为字幕编号需试用（建议先 studio_read_cues）。
