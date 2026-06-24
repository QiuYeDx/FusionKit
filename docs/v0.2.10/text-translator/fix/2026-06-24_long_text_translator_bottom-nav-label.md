# 长文本翻译详情页底部导航文案修复

> 日期：2026-06-24
> Feature Slug：`long_text_translator`
> 类型：UI 文案修复
> 状态：已完成

## 背景与现象

长文本翻译详情页底部导航中，返回按钮右侧的当前工具名称显示为短横线 `-`，无法让用户确认当前所在工具。

## 根因

`src/constants/router.ts` 的 `ToolNameMap` 未登记 `/tools/text/translator`，`src/pages/components/BottomNavigation.tsx` 找不到当前路径对应的 i18n key 后使用 `"-"` 作为 fallback。

## 修复后行为

- `/tools/text/translator` 底部导航当前工具名称显示为“长文本翻译”及对应语言文案。
- 未登记的二级工具路径 fallback 到通用“工具”文案，不再显示裸露的 `-`。

## 影响范围

- `src/constants/router.ts`
- `src/pages/components/BottomNavigation.tsx`
- `src/locales/*/common.json`

## 实现摘要

- 为 `/tools/text/translator` 增加 `menu.text.translator` 映射。
- 四语言 `common.json` 增加 `menu.text.translator`。
- `BottomNavigation` fallback 从 `"-"` 改为 `menu.tools`。

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

后续新增二级工具时，应同步维护 `ToolNameMap` 或改为从工具 metadata 派生，避免再次出现缺省文案。
