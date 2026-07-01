# 长文本翻译 Beta 文案清理

> 日期：2026-06-24
> Feature Slug：`long_text_translator`
> 类型：UI 文案修复
> 状态：已完成

## 背景与现象

长文本翻译工具已经开放 TXT 与 Markdown 的并发/串行、仅译文/双语、恢复和混合项目能力，但详情页和工具卡仍展示多处 Beta 文案，包括队列 badge、右侧“当前 Beta 范围”、Markdown Beta 提示和工具卡 Beta chip。对用户而言，这会形成“功能还没做完”的错误暗示。

## 根因

`FE-005` 开放 Markdown 入口时沿用了早期谨慎发布文案；后续 `MD-006` 已补齐 Markdown sequential、恢复和 mixed ordered project，但 Renderer UI 未同步移除 Beta 叙事。

## 修复后行为

- 文本翻译详情页不再显示 Beta badge 或“当前 Beta 范围”。
- Markdown 选择后的提示改为“Markdown 结构与资源提示”，只说明结构保护、软警告和硬限制。
- 工具列表卡片从 `TXT + Beta` 改为 `TXT + Markdown`。
- 文案仍保留必要的复杂 Markdown 输出检查建议，这属于资源和质量边界，不再用 Beta 状态表达。

## 影响范围

- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/pages/Tools/index.tsx`
- `src/locales/*/text.json`
- `src/locales/*/tools.json`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`

## 实现摘要

- 删除任务队列标题右侧 Beta badge。
- 删除第三列中的 Beta 范围说明。
- 四语言移除已不再使用的 `translator.badges.beta` 和范围型 Beta 文案。
- 工具卡 chip key 改为 `tools:chips.text_translator_markdown`。

## 仍需明确

`QA-MD-001` 仍是 Markdown 自动化 fixture 与恢复验收的下一步，这不等于用户界面需要继续标记 Beta。后续发布说明可以在 `DOC-MD-001` 中同步描述真实支持范围和 QA 边界。

## 验证

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

## 后续建议

发布文档应在 `QA-MD-001` 完成后由 `DOC-MD-001` 统一更新，避免 README/CHANGELOG 与实际能力继续偏离。
