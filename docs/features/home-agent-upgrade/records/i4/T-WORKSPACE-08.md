# 实施记录：T-WORKSPACE-08

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-08 |
| 日期 | 2026-10-09 |
| 验证版本 | df64e8f + 本会话未提交改动（最终代码重新 `vite build --mode=test` 后运行） |
| 环境 | Windows 11，Electron 41.10.6，隔离 profile；Agent 使用本地受控 Responses 流（合成工具调用），不调用付费 API |
| 任务指纹 | 5be12cf156868b7a9810f17265ff96034e583a964b6991a5becef8e5f551b748 |

## 实际结果

`test/agent-handoff.electron.test.ts`（`FUSIONKIT_AGENT_DOCK_E2E=1`），中文界面，按顺序：

1. **首页 → 字幕翻译页（1280×860 浅色，Agent 跳转）**
   - 首页发送“打开字幕翻译页”，Agent 调用 `open_app_page`，返回路由 `/tools/subtitle/translator`、页面名“字幕AI翻译”和含 `targetLang` 的快照。
   - 外框逐帧取样（`arrival-samples.json`，62 帧）：起点 left 304 / width 672（首页列），left 与 width 单调减小，约 0.5s 后落位 left 11 / width 400 / height 620，面板不透明度 1。
2. **字幕翻译页**
   - 下一轮请求的 instructions 含 Current Page 路由，工具清单含 `subtitle_translator_update_settings`。
   - “把目标语言改成英文，只要译文”：更新 2 项设置。
   - “翻译一个字幕文件”：`queue_subtitle_translate` 返回 `queuedCount: 1`，其中 `appliedSettings.targetLang = EN / tool_page`、`translationOutputMode = target_only / tool_page`、`sourceLang` 来源为 tool_page。
3. **在首页打开（1280 浅色返回）**：取样（`return-samples.json`）从 left 11 / width 400 起，末帧 left > 250、width ≈ 672；入口消失，首页显示同一会话。
4. **用户导航离开首页（786×660 深色）**：取样（`arrival-786-dark-samples.json`，135 帧）从首页列 left 56 / width 672 落位到 left 11 / width 400。
5. **786 深色返回**：取样（`return-786-dark-samples.json`，68 帧）left 11→56、width 400→672 单调变化，不透明度在后段 1→0。
6. **空会话**：新建对话后离开首页，入口保持收起，面板未打开。
7. **减少动态效果**：交接只淡入淡出，首个取样即在静止位置（left 11 / width 400）。
8. 全程无页面错误；结束后无残留 electron 进程。

截图已逐张审阅，存于 `records/i4/screenshots/`：

- 离开：`05a`（首页对话在外框底色下变暗，无叠影）、`05b`/`05c`（内容在移动的外框中淡入，背后首页随路由淡出）、`06` 落位。
- 返回：`03a–03c`、`07b`/`07c`（内容随外框移动后淡出，外框溶解露出唯一一份首页对话；`07c` 为约 0.1s 的空底）、`04`/`08` 落定。
- 字幕翻译页：`01`、`02`。

审查中先后发现的空白卡片与叠影问题、修复和对应的 AC 措辞细化见 T-WORKSPACE-07。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-08-1 | 通过 | inline:最终构建后 agent-handoff 1 项（12.3s）与 agent-dock 1 项（12.8s）通过；file:records/i4/screenshots/；file:records/i4/arrival-samples.json；file:records/i4/return-samples.json；file:records/i4/arrival-786-dark-samples.json；file:records/i4/return-786-dark-samples.json；inline:尺寸与主题覆盖：1280×860 浅色两向、786×660 深色两向 |
| V-WORKSPACE-08-2 | 通过 | inline:`node scripts/home-agent-qa.mjs` success（24 张截图、17 项检查、11 次请求）；cue-revision-ui、cue-editing-ui 共 3 项通过；context-menu-ui 1 项通过；tool-navigation 1 项通过 |
| V-WORKSPACE-08-3 | 通过 | inline:`vitest run src/agent src/store src/pages src/services test/subtitle-studio test/subtitle-studio-provenance` 合并运行 2510 项通过，6 项计时类用例在高并发下失败（ipc 2 项、transcription-runtime 3 项、transcription-task-service 1 项）；单独重跑这 3 个文件 94 项全部通过，与 I3 记录中的既有现象一致。另：`check-boundaries` errors 为空，`check-preload-bundle` 通过，`tsc` 0 错误，i18n 两项检查通过 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-04-1 | 通过 | V-WORKSPACE-08-1 |
| AC-WORKSPACE-04-2 | 通过 | V-WORKSPACE-08-1 |
| AC-WORKSPACE-04-3 | 通过 | V-WORKSPACE-08-1 |
| AC-WORKSPACE-04-4 | 通过 | V-WORKSPACE-08-1 |
| AC-WORKSPACE-04-5 | 通过 | V-WORKSPACE-08-1 |
| AC-RUNTIME-04-2 | 通过 | V-WORKSPACE-08-1 |
| AC-TOOLS-04-1 | 通过 | V-WORKSPACE-08-1 |
| AC-TOOLS-05-1 | 通过 | V-WORKSPACE-08-1 |

## 风险与未执行项

- Agent 为合成响应，真实供应商的页面切换与设置工具调用质量未验证。
- 只截取了中文界面；1280 深色与 786 浅色没有单独取样（同一实现，仅主题色不同）。
- macOS 未运行。
- tool-spacing 与 tool-file-drop 两项既有失败（I3 已记录为基线问题）本批未重跑。
