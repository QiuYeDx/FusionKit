# I8 任务

当前用户授权八项连续实施，Codex root串行负责。

### T-POLISH-01 实现与集成验收

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I8 |
| 需求 | R-POLISH-01 |
| 验收 | AC-POLISH-01-1, AC-POLISH-01-2, AC-POLISH-01-3, AC-POLISH-01-4, AC-POLISH-01-5, AC-POLISH-01-6, AC-POLISH-01-7, AC-POLISH-01-8 |
| 依赖 | - |
| 写集 | src/App.tsx, src/pages/Tools/Subtitle/SubtitleStudio/, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, src/locales/, test/subtitle-studio/, test/tool-spacing.electron.test.ts, .agents/skills/fusionkit-pitfall-guard/references/keep-route-insets-with-the-exiting-page.md, .agents/skills/fusionkit-pitfall-guard/references/index.md, scripts/subtitle-studio/boundaries.json |
| 负责人 | Codex root |
| 依赖确认 | 3a3fcdf已提交、工作树干净，I7可用 |
| 完成日期 | 2026-09-13 |
| 实施记录 | records/2026-09-13-polish.md |
| 集成版本 | feat/subtitle-studio-transcription，3a3fcdf加I8未提交工作树；精确源码及证据见2026-09-13-polish.snapshot.json |

#### 实现要点

先队列与共享视觉，再来源受控API和实际用量，最后路由连续帧及集成复验；保留已完成I7语义。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-POLISH-01-1 | integration | required | 来源身份/owner/生命周期及用量分页、未知值测试，真实Electron工作流 | - |
| V-POLISH-01-2 | browser | required | 浅宽深窄、长名、hover/详情/按钮/看板截图审阅，进退场连续帧 | - |
| V-POLISH-01-3 | static | required | TS、i18n、boundary、preload、构建、diff和spec检查 | - |
