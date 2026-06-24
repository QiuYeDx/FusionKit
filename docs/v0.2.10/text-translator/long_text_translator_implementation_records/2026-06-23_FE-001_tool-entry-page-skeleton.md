# 工作包 FE-001：工具入口与页面骨架

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：FE-001

## 本次实现内容

- 新增长文本翻译工具 metadata，包含 `textTranslator` 工具 ID、文本工具分类、图标、工具色和 `/tools/text/translator` 路由。
- 在工具首页新增文本工具分组和卡片入口，保留现有字幕、音乐和重命名工具入口行为。
- 新增 `TextTranslator` 页面骨架，包含页面头、任务队列空状态、任务模型可用/缺失状态、Beta 范围提示。
- 页面只读取任务模型配置是否可用，不展示或持久化 API Key。
- 新增中、英、日、繁 `text` namespace，并将其接入 i18n constants/resources。
- 更新四语言 `tools` namespace，补齐文本工具分类、说明和 chips。
- 为长文本工具增加 light/dark 工具色变量。
- 修复 Electron main/preload 子构建未继承 `@ -> src` alias 的 build 问题，避免主进程文本翻译模块在 `pnpm build` 时无法解析共享类型。

## 修改文件

- `src/App.tsx`
- `src/pages/Tools/_shared/toolMeta.ts`
- `src/pages/Tools/index.tsx`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/i18n/constants.ts`
- `src/i18n/resources.ts`
- `src/locales/en/tools.json`
- `src/locales/zh/tools.json`
- `src/locales/ja/tools.json`
- `src/locales/zh-Hant/tools.json`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `src/index.css`
- `vite.config.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `ToolKey` 新增 `textTranslator`。
- `ToolMeta.category` 新增 `text`。
- i18n namespace 新增 `text`。
- 新增页面路由 `/tools/text/translator`。
- `vite.config.ts` 将 `@` alias 显式传入 Electron main/preload 子构建；这不改变运行时 API，只修复 build 解析。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 800 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程出现既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，均不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- FE-001 不接入完整执行交互；文件选择、配置、prepare/start、进度和完成路径展示由 FE-002 完成。
- 当前页面仅展示空状态、任务模型状态和 Beta 范围提示。
- 未做浏览器截图级视觉验收；本包通过 build、类型和 i18n 检查确认路由与页面可编译。

## 下一步建议

- 继续认领 `FE-002：单文件配置、准备与进度闭环`。
- FE-002 应复用 `src/services/text/textTranslatorExecutionService.ts`，不要在页面组件中直接手写 IPC channel 字符串。
- FE-002 应只持久化偏好和任务摘要，不把源文件全文、segment source 或 API Key 放入 Renderer store。
