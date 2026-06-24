# 工作包 FE-004：批量独立文件任务与队列体验

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：FE-004

## 本次实现内容

- Renderer store 新增 `queuedTasks`、`setQueuedTasks` 和 `upsertQueuedTask`。
- 多文件选择时不再强制锁定有序项目，用户可以选择 `independent_files` 或 `ordered_project`。
- 当多文件且项目模式为 `independent_files` 时，Renderer 为每个文件创建单独的单文件 task，并逐个 prepare。
- 批量 start 会启动所有 waiting task，交给现有主进程 request scheduler 做公平调度。
- taskUpdated、taskCompleted 和 progress 事件会回填队列 task 状态与进度。
- 队列 UI 展示独立任务文件名、状态、segment 进度和等待任务数量，并支持点击切换活动 task。
- 清空操作会删除队列中所有非运行 task，避免遗留未使用工作区。
- 四语言文案补充独立任务队列、等待数量和批量准备完成提示。

## 修改文件

- `src/store/tools/text/useTextTranslatorStore.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 无新增 IPC；批量独立文件在 Renderer 层拆成多个既有单文件 task。
- Store 新增队列状态，但只持久化 preferences 与 activeTaskId，避免 Renderer 本地保存过期 task 快照。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/output/markdownOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 927 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- 核心文本翻译回归：14 个测试文件、93 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 未做浏览器级点击验证；当前通过 i18n、类型、核心回归和 build 验证。
- 队列状态依赖运行时事件更新；应用重启后仍以恢复列表作为 authoritative source。

## 下一步建议

- 继续认领 `DOC-001：README、i18n、隐私与发布说明`。
- DOC-001 应明确当前 Beta 范围、文件路径/正文不经 Renderer、模型服务费用、TXT 与 Markdown 能力边界，以及尚未完成真实模型/手工验收的风险。
