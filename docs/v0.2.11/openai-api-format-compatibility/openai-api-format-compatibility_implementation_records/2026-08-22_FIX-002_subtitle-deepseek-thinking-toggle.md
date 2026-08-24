# 工作包 FIX-002：字幕 DeepSeek Thinking 开关

## 基本信息

- 日期：2026-08-22
- 状态：已完成
- 对应执行计划工作包：FIX-002

## 本次实现内容

- 增加字幕工具级 Thinking Switch，DeepSeek Chat 下显示并默认关闭。
- 将选项冻结到字幕任务、自动导入 snapshot、checkpoint 和恢复任务。
- Chat adapter 显式发送 DeepSeek thinking.type；旧任务按关闭兜底。
- 增加四语言文案和任务详情状态。

## 修改文件

- src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx
- src/store/tools/subtitle/useSubtitleTranslatorConfigStore.ts
- src/agent/task-model-config.ts
- electron/main/ai/adapters/chat-completions-adapter.ts
- electron/main/translation 下的 typing、checkpoint 与 recovery 文件
- src/type 下的 subtitle、subtitleTranslationIpc、generatedSubtitleImport 文件
- 相关测试与 src/locales 各语言 subtitle.json

## 接口或数据结构变化

- SubtitleTranslatorConfigPreferences.thinkingEnabled: boolean
- SubtitleTaskReadyExecutionBinding.thinkingEnabled?: boolean
- ModelRuntimeConfig.thinkingEnabled?: boolean
- checkpoint/recovery options 增加兼容旧数据的 Thinking 布尔值。

## 验证结果

- `node_modules/.bin/vitest run` 执行 17 个相关测试文件，111 项字幕、恢复、导入、runtime 与 Boolean 控件测试全部通过。
- `node_modules/.bin/tsc --noEmit` 通过。
- `node scripts/check-i18n.mjs` 通过，四种语言 key 数量一致。
- `git diff --check` 通过。

## 未完成事项

- 未使用真实 DeepSeek API Key 做供应商手工请求。
- 未启动 Electron 做视觉手工验收。

## 下一步建议

- 在 QA-002 中分别使用 Thinking 开/关各执行一个短字幕任务，确认真实供应商返回与计费明细。
