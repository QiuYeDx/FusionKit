# 实施记录：T-WORKSPACE-06

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-06 |
| 日期 | 2026-10-09 |
| 验证版本 | df64e8f + 本会话未提交改动（最终代码重新 `vite build --mode=test` 后运行） |
| 环境 | Windows 11，Electron 41.10.6，隔离 profile；Agent 使用本地受控 Responses 流（合成工具调用），修订使用本地受控 chat completions，不调用付费 API |
| 任务指纹 | 84db1e60092d42ef53a3578cda847d778467f39ca803c33b4a46f4c4c7783c0e |

## 实际结果

`test/agent-dock.electron.test.ts`（`FUSIONKIT_AGENT_DOCK_E2E=1`）：导入 250 行字幕（第 5、120、240 句含“法尔童/法而童”），在工作台页面：

- 入口位于左下 11px、36px，与主题切换对称（像素级断言）；收起时页面上没有 `role=dialog`。
- 打开后输入框获得焦点，标题显示“字幕工作台 · 法厄同.srt”，3 条页面建议；面板左缘 11px、底边高于底部导航（1280×860 与 786×660 均断言）。Esc 收起并聚焦入口，仍在工作台。打开时可继续选择页面中的字幕。
- 发送“文中的‘法尔童’都应为‘法厄同’”：Agent 请求的 instructions 含 Current Page、路由、文档名、选区编号 `[3]`，工具清单含三条页面工具与固定工具；Agent 调用 `studio_prepare_revision`（scope=document，terms=法尔童/法而童）→ 修订预览覆盖在面板之上，跳过规划请求直接按写法查找，只把 3 行送去修订；工具回执 `awaiting_user_review / 3 / 3` 进入下一次 Agent 请求；用户点击前文档未改，点击“应用 3 条修订”后写入。
- 生成中收起：入口显示进行中环；回复到达后显示未读点，打开后清除。
- 窄窗深色截图后点“在首页打开”：入口消失，首页显示同一会话。

截图（已逐张审阅）：`records/i3/screenshots/01-open-empty-1280-light.png`、`02-preview-over-panel.png`、`03-applied-conversation.png`、`04-launcher-busy.png`、`05-launcher-unread.png`、`06-open-786-dark.png`、`07-home-same-conversation.png`。审查发现与修复见 T-WORKSPACE-05 记录。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-06-1 | 通过 | inline:agent-dock.electron.test.ts 1 项通过（11.7s）；file:records/i3/screenshots/；结束后无残留 electron 进程 |
| V-WORKSPACE-06-2 | 通过 | inline:`node scripts/home-agent-qa.mjs` success（24 张截图、17 项检查）；cue-revision-ui 2 项、cue-editing-ui 1 项、tool-navigation（含 Escape 归属）1 项通过。tool-spacing 与 tool-file-drop 两项在本批改动前的基线构建上以相同断言失败（tool-panel-header 内距 6px≠8px；文件拖入定位 0 个元素），与本批无关 |
| V-WORKSPACE-06-3 | 通过 | inline:`vitest run test/subtitle-studio-provenance src/agent src/pages test/subtitle-studio/cue-revision.test.ts` 64 文件 637 项通过、3 项跳过；此前全量运行中 transcription-task-service 与 local-subtitle 若干计时用例在高并发下偶发失败，单独运行全部通过（改动前后一致） |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-03-1 | 通过 | V-WORKSPACE-06-1 |
| AC-WORKSPACE-03-2 | 通过 | V-WORKSPACE-06-1 |
| AC-WORKSPACE-03-3 | 通过 | V-WORKSPACE-06-1 |
| AC-WORKSPACE-03-4 | 通过 | V-WORKSPACE-06-1 |
| AC-WORKSPACE-03-5 | 通过 | V-WORKSPACE-06-1, V-WORKSPACE-06-2 |
| AC-TOOLS-03-4 | 通过 | V-WORKSPACE-06-1 |

## 风险与未执行项

Agent 与修订模型均为合成响应，真实供应商对页面工具的调用质量未验证；仅截取中文界面；macOS 未运行。

## 复核（2026-10-09，体验修复 U1/U5）

AC-WORKSPACE-03-3 按用户反馈修改（见 T-WORKSPACE-05 记录的复核段）。本用例先固定面板再在工作台选择字幕，其余链路不变；重新构建后 agent-dock 与 agent-handoff 用例、`node scripts/home-agent-qa.mjs`（17 项检查）均通过。
