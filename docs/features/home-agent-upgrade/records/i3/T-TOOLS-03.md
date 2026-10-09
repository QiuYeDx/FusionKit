# 实施记录：T-TOOLS-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-TOOLS-03 |
| 日期 | 2026-10-09 |
| 验证版本 | df64e8f + 本会话未提交改动 |
| 环境 | Windows 11，仓库 node_modules，Vitest 2.1.9 |
| 任务指纹 | 67dbb6a254890afc35f50c8668d17ed2c32103a24c904fbed084825db7237419 |

## 实际结果

- 主进程只读 `findCues`（`cue-revision-contract.ts` 请求 schema 与 `CueFindResult`，`CueRevisionService.find`）：按写法（含近似误写）或编号查找，原文与译文都检索，不调用模型；与 AI 修订定位共用 `searchCues`；校验 owner 文档授权与 revision，超过 5000 条拒绝。IPC、preload、通道白名单同步，`electron/main/subtitle-studio/index.ts` 审计按 FK-PIT-0186 更新（`resources/speech-resources/provenance/current-integration-audits.v1.json`）。
- `StudioCueRevision` 支持 `preset`（修改要求、范围、字段、可选写法/编号）与一次性 `onSettled`：预设填入表单后自动生成；带写法或编号时用 `findCues` 取代规划请求；结果 `ready / needs_confirmation / failed / cancelled` 只回调一次，关闭、停止、新请求或卸载都视为取消。应用仍只由用户点击。
- `StudioCueTable` 新增 `onSelectionChange`；工作台页面以 ref 读取当前文档、译文轨、选区、受阻状态与预览是否打开，注册 `studioPageContext`。
- `SubtitleStudio/agent-context.ts`：快照（文档、可见范围、选区编号、编辑可用性、预览状态）、页面说明、三条建议，以及 `studio_read_cues`、`studio_find_cues`、`studio_prepare_revision`。工具是结构化普通对象，工作台只依赖中性的 `src/agent/page-context.ts`；该文件已登记为字幕工作台边界的基础设施（`scripts/subtitle-studio/boundaries.json`）。
- 页面名称翻译键为动态键，已在 `scripts/i18n-usage-manifest.mjs` 登记精确清单；四语言新增 `studio:agent.*` 建议文案。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TOOLS-03-1 | 通过 | inline:`vitest run test/subtitle-studio/cue-revision.test.ts`（14 项，含 findCues 写法/译文/编号/冲突/非法参数）与 `src/pages/Tools/Subtitle/SubtitleStudio/agent-context.test.ts`（6 项：快照、跨页读取与过期标记、查找投影、预设打开与三类结果映射、受阻/预览已开/空选区/无译文轨、停止保留预览与文档切换） |
| V-TOOLS-03-2 | 通过 | inline:`tsc --noEmit` 0；check-i18n 与 check-i18n-usage 通过；check-boundaries 543 文件 0 错误；`vitest run test/subtitle-studio-provenance` 等 22 文件 306 项通过、3 项跳过；preload 检查在 T-WORKSPACE-06 构建时复核 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TOOLS-03-1 | 通过 | V-TOOLS-03-1 |
| AC-TOOLS-03-2 | 通过 | V-TOOLS-03-1 |
| AC-TOOLS-03-3 | 通过 | V-TOOLS-03-1, V-TOOLS-03-2 |
| AC-TOOLS-03-4 | 通过 | V-TOOLS-03-1 |
| AC-TOOLS-03-5 | 通过 | V-TOOLS-03-1 |

## 风险与未执行项

预设在真实 Electron 中自动生成、预览覆盖悬浮面板等交互由 T-WORKSPACE-06 验证。
