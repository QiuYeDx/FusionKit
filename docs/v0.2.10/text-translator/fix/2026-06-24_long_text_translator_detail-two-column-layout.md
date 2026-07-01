# 长文本翻译详情页两列布局修复

> 日期：2026-06-24
> Feature Slug：`long_text_translator`
> 类型：UI 布局修复
> 状态：已完成

## 背景与现象

长文本翻译详情页在较宽视口下呈现三列布局，右侧第三列包含模型状态、Beta 范围和能力列表。该列信息与页头或主操作区重复，且 `xl` breakpoint 会让默认初始化视口更容易退回单列，和其它工具详情页体验不一致。

## 根因

`src/pages/Tools/Text/TextTranslator/index.tsx` 使用了 `xl:grid-cols-[330px_minmax(0,1fr)_320px]`，并把说明性内容单独放在第三列；其它工具详情页普遍使用 `lg:grid-cols-[320px_minmax(0,1fr)]` 两列布局。

## 修复后行为

- 长文本翻译详情页使用两列布局：左侧配置，右侧任务队列和执行状态。
- breakpoint 与字幕转换、字幕提取、字幕翻译等工具详情页保持 `lg` 口径一致。
- 页头仍保留模型状态 badge，避免丢失关键可用性反馈。
- 不再渲染无独立操作价值的第三列。

## 影响范围

- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`

## 实现摘要

- 页面容器从 `max-w-6xl` 调整为 `max-w-7xl`，与其它复杂工具详情页一致。
- 主 grid 从三列 `xl` 改为两列 `lg:grid-cols-[320px_minmax(0,1fr)]`。
- 删除右侧第三列的模型卡、范围说明卡和重复能力列表。

## 验证

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check` 通过，8 个 namespace、四语言各 926 个 key。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm build` 通过；仅保留既有动态/静态 import、chunk size、package description、macOS signing identity 与 APFS DMG 提示。
- `git diff --check` 通过。

## 后续建议

如果后续需要增加帮助说明，应优先放入配置区的上下文提示、任务区的条件提示或可折叠帮助，而不是恢复常驻第三列。
