# 工作包 FIX-UI-001：详情页导航、布局与 Beta 文案清理

## 基本信息

- 日期：2026-06-24
- 状态：已完成
- 对应执行计划工作包：`FIX-UI-001`、`FIX-UI-002`、`FIX-UI-003`

## 本次实现内容

- 修复长文本翻译详情页底部导航当前工具名显示为 `-` 的问题。
- 将详情页从三列 `xl` 布局收敛为和其它工具详情页一致的两列 `lg` 布局。
- 删除页面和工具卡中让用户误解功能仍处于 Beta 的文案。

## 修改文件

- `src/constants/router.ts`
- `src/pages/components/BottomNavigation.tsx`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/pages/Tools/index.tsx`
- `src/locales/*/common.json`
- `src/locales/*/text.json`
- `src/locales/*/tools.json`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_bottom-nav-label.md`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_detail-two-column-layout.md`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_beta-copy-cleanup.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`

## 接口或数据结构变化

- 无 IPC、主进程任务模型或持久化 schema 变化。
- 新增四语言 `menu.text.translator` i18n key。
- 工具列表 chip key 从 `tools:chips.text_translator_beta` 切换为 `tools:chips.text_translator_markdown`。

## 验证结果

执行命令：

```text
rg -n "Beta|beta|translator\\.badges\\.beta|translator\\.scope\\.(title|beta_desc|supported_files|execution_modes|outputs)|text_translator_beta" src/pages src/locales -S
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- `rg` 未在 `src/pages` 和 `src/locales` 中找到文本翻译相关 Beta 文案残留。
- `pnpm run i18n:check` 通过，8 个 namespace、四语言各 926 个 key。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm build` 通过；仅保留既有动态/静态 import、chunk size、package description、macOS signing identity 与 APFS DMG 提示。
- `git diff --check` 通过。

## 未完成事项

- 未启动前端服务做截图验收；如本会话后续进行视觉冒烟，需要在结束前停止服务进程。
- `QA-MD-001` 仍需覆盖 Markdown fixture、恢复和 UI 可见入口。

## 下一步建议

- 继续推进 `QA-MD-001：Markdown E2E 自动化与恢复验收`。
