# 工作包 REL-003：恢复与错误管理 UI

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：REL-003

## 本次实现内容

- 在长文本翻译页面新增恢复入口和恢复任务弹窗。
- 弹窗调用 `listRecoverableTextTranslationTasks()` 展示可恢复任务摘要。
- 展示 taskId、状态、resumable/blocked、source matched/changed/missing/unchecked、completed/total/failed segment 数和 blockingReason。
- 支持继续任务：调用 `resumeTextTranslationTask({ taskId, model })`，使用当前任务模型凭据，不从磁盘读取 API Key。
- 支持从头开始：调用 `restartTextTranslationTask({ taskId, model })`，重置任务并清空旧工作区结果。
- 支持删除工作区：调用 `deleteTextTranslationTask({ deleteWorkspace: true })`，若删除当前 active task 同步清空页面状态。
- 支持打开恢复任务工作区：调用 `revealTextTranslationWorkspace()` 后通过 `show-item-in-folder` 打开。
- 保留页面内结构化错误区域，恢复操作失败时写入 `lastError` 并 toast。
- 新增中、英、日、繁恢复 UI 文案。

## 修改文件

- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 无新增后端接口；页面复用 REL-002 已完成的 IPC wrapper。
- i18n `text` namespace 增加 `translator.recovery.*` 和 `translator.actions.recovery`。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/service/textTranslationService.e2e.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 887 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`：4 个测试文件、18 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 未做真实 Electron 点击级手工验证；当前通过 i18n、类型、构建和后端恢复路径测试确认集成可编译。
- 删除恢复任务当前未加二次确认弹窗；后续如需要更强防误触可在 UX polish 或 DOC-002 清理策略中收口。
- 恢复 UI 仍限定当前单 TXT、parallel、target-only 能力边界。

## 下一步建议

- 继续认领 `MEM-001：语义记忆模型、预算与快照`。
- MEM-001 先只实现本地 memory 数据结构、预算裁剪和快照读写，不提前接模型 patch 或串行 executor。
