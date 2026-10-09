# 实施记录：T-TOOLS-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-TOOLS-04 |
| 日期 | 2026-10-09 |
| 验证版本 | df64e8f + 本会话未提交改动 |
| 环境 | Windows 11，Node（vitest 2.1.9）；浏览器部分见 T-WORKSPACE-08 |
| 任务指纹 | 8d5338ede58f0ff365474d8bce7b8092b606d5947186503cb12e7fbb168d68ff |

## 实际结果

- `src/agent/classic-page-contexts.ts`：按路由为字幕翻译、转换、提取、本地转写、名称翻译提供页面上下文，包括页面名、主题、两条页面建议，以及快照。
  - 快照内容：页面设置（不含密钥与令牌）、各状态任务数、最多 10 个任务的名称/状态/进度。
  - 本地转写额外包含环境就绪、可用模型、草稿；名称翻译额外包含根目录数、条目统计。
- 页面工具：`subtitle_translator_update_settings`、`subtitle_converter_update_settings`、`subtitle_extractor_update_settings`、`name_translator_update_settings`。
  - 每个工具只接受该页持久化设置中的枚举字段，返回 `{changed: {key: {before, after}}}`，页面即时反映。
  - 本地转写设置沿用固定工具 `configure_local_transcription`。
- `src/pages/AgentDock/ClassicPageContexts.tsx`：由路由驱动的单一注册组件，挂在 `App.tsx`，不修改经典页面源文件（本地转写页是来源追溯冻结文件）。
- 四种语言新增页面建议文案，动态键已列入 `i18n-usage-manifest.mjs`；结果视图显示“已更新 N 项页面设置”。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TOOLS-04-1 | 通过 | inline:`vitest run src/agent/classic-page-contexts.test.ts` 4 项通过（只覆盖五个经典页、翻译页设置与队列投影、设置更新校验与前后值、本地转写环境/草稿/任务）；`src/agent` 全部 280 项通过 |
| V-TOOLS-04-2 | 通过 | inline:`tsc --noEmit` 0 错误；`check-i18n.mjs`、`check-i18n-usage.mjs` 通过 |
| V-TOOLS-04-3 | 通过 | inline:字幕翻译页面板显示“字幕AI翻译”；请求 instructions 含 `"route":"/tools/subtitle/translator"`，工具清单含 `subtitle_translator_update_settings`；更新 2 项设置后结果显示前后值；file:records/i4/T-WORKSPACE-08.md |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TOOLS-04-1 | 通过 | V-TOOLS-04-1, V-TOOLS-04-3 |
| AC-TOOLS-04-2 | 通过 | V-TOOLS-04-1, V-TOOLS-04-3 |
| AC-TOOLS-04-3 | 通过 | V-TOOLS-04-1, V-TOOLS-04-2 |

## 风险与未执行项

在真实 Electron 中只走了字幕翻译页；转换、提取、本地转写、名称翻译四页的快照与设置工具只有单元测试。翻译知识库页不在本批范围。
