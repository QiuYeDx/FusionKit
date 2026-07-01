# 工作包 FIX-UI-004：批量翻译失败反馈、事件订阅与阶段归因修复

## 基本信息

- 日期：2026-06-24
- 状态：已完成
- 对应执行计划工作包：`FIX-UI-004`

## 本次实现内容

- 修复文本翻译详情页事件订阅因 `task` / `queuedTasks` 变化反复重订阅的问题。
- 修复独立批量翻译中单个任务失败就中止后续任务启动的问题。
- 修复 `All text translation segments failed.` 被 UI 标记为“估算”阶段的问题。
- 修复后台任务失败污染当前任务详情错误面板的问题。
- 为全分片失败补充首个分片失败摘要和结构化 details。
- 为 toast 增加短窗口去重，避免相同错误风暴。

## 修改文件

- `electron/main/text-translation/text-translation-service.ts`
- `src/type/textTranslationIpc.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/store/tools/text/useTextTranslatorStore.ts`
- `src/utils/toast.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_event-subscription-cascade.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`

## 接口或数据结构变化

- `TextTranslationIpcError` 新增可选 `phase?: TextTranslationPhase`。
- `TextTranslationTaskFailedEvent` 新增失败后的 `task: TextTranslationTask` 快照。
- `TextTranslatorUiError` 新增可选 `taskId?: string`，Renderer 只在当前任务匹配时显示错误详情。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts src/type/textTranslation.test.ts
pnpm exec vitest run test/text-translation
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

结果：

- Service E2E 通过：1 个文件 / 14 个测试。
- 共享类型/IPC 回归通过：3 个文件 / 15 个测试。
- 完整 text-translation 回归通过：16 个文件 / 135 个测试。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm run i18n:check` 通过，8 个 namespace、四语言各 926 个 key。
- `pnpm build` 通过；仅保留既有动态/静态 import、chunk size、package description、macOS signing identity 与 APFS DMG 提示。
- `git diff --check` 通过。

## 未完成事项

- 未启动前端服务做真实 UI 点击/拖拽验收；本会话未产生需要关闭的前端服务。
- 真实模型失败类型仍需要 `QA-MD-001` 或发布候选手工验收覆盖。

## 下一步建议

- 继续推进 `QA-MD-001：Markdown E2E 自动化与恢复验收`，并把用户提供的 `vercel_design_skill.md/.txt` 作为手工验收样本。
