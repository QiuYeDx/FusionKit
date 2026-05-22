# 修复记录：HomeAgent 跳转工具页后预览为空

## 基本信息

- 日期：2026-05-21
- 状态：已完成
- 关联范围：RN-007 HomeAgent 预览确认 UI、RN-004 手动工具页

## 问题现象

HomeAgent 生成名称翻译计划后，用户点击“在工具页打开”会进入 `/tools/rename/name-translator?planId=<planId>`，但工具详情页仍处于初始空状态，看不到刚刚生成的翻译计划预览、选中路径和应用状态。

## 原因

HomeAgent 已把 `planId` 写入跳转 URL，完整计划也保存在 renderer memory `namePlanStore` 中；但手动工具页没有读取 `planId` query，也没有把 memory plan hydrate 到 `useNameTranslatorStore`。因此工具页只展示自己的默认空 store。

## 修复内容

- `useNameTranslatorStore` 新增 `loadPlanFromCache(planId)`：
  - 从 `namePlanStore` 读取未过期完整 plan。
  - 恢复 `selectedPaths`、`options`、`currentPlan`、`originalSuggestions` 和 history。
  - 重新 inspect roots；inspect 不可用时保留 fallback path，避免整页空白。
  - 合并同一 `planId` 的并发加载，避免 React StrictMode 开发环境重复 inspect 和重复提示。
  - plan 缺失或过期时显示明确错误。
- `NameTranslator` 页面读取 `?planId=` 自动加载计划，并展示 HomeAgent 计划加载中/已加载提示。
- HomeAgent 卡片按钮文案调整为“在工具页打开”，和实际行为一致。
- 更新中英日 rename 文案。
- 回填 final design、最终实现状态和 RN-007/RN-008 记录。

## 验证

- `pnpm exec tsc --noEmit`
- `pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts src/agent src/services/rename test/rename`
- `pnpm build`

浏览器冒烟说明：

- `pnpm dev --host 127.0.0.1` 可启动 Vite。
- Codex in-app browser 可打开 `http://127.0.0.1:5173/#/tools/rename/name-translator?planId=missing_plan`，但普通浏览器环境缺少 Electron 注入的 `window.ipcRenderer`，既有 `src/renderer/subtitle.ts` 初始化会报 `Cannot read properties of undefined (reading 'on')`，页面无法完成真实视觉验收。

后续发布前仍建议在 Electron renderer 环境中补一次真实点击链路验收。
