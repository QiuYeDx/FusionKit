# 字幕翻译实际 Token 用量与费用显示

## 背景

模型响应已经返回 usage，但字幕任务和页面没有消费该字段，完成任务仍显示请求前估算。

## 目标行为

- API 返回 usage 后立即累计并更新任务。
- 实际用量跨失败、重试与 checkpoint 恢复保留。
- 任务与汇总界面清楚区分实际 Token、计算费用和剩余预估。
- DeepSeek V4 默认价格同步 2026-08-22 官方价格。

## 影响范围

- Model runtime usage 解析。
- SubtitleTranslator task/execution/checkpoint/recovery/event 合同。
- Renderer queue Store 与 SubtitleTranslator 页面。
- DeepSeek model presets、四语言文案与相关测试。

## 验证

实现覆盖 adapter usage 解析、BaseTranslator 聚合、并发失败 settle、checkpoint/recovery、
Renderer queue、任务行/详情/汇总显示与 DeepSeek 预设价格。

执行结果：

- 字幕相关 Vitest：21 个文件、142 个测试全部通过。
- `node_modules/.bin/tsc --noEmit`：通过。
- `node scripts/check-i18n.mjs`：通过，四种语言 `subtitle` 均为 641 个键。
- `node_modules/.bin/vite build --mode=test`：Renderer、Electron Main、Preload 全部通过。
- `git diff --check`：通过。
- `node scripts/check-i18n-usage.mjs`：仍报告 Rename 工具既有的动态 `hintKey` 与陈旧
  manifest selector 两项错误，本功能新增字幕 key 均可解析。

DeepSeek 官方来源：`https://api-docs.deepseek.com/quick_start/pricing`（2026-08-22 核对）。
由于现有 profile 只有单组输入/输出价格，内置值采用高峰 cache-miss 价格。
