# 工作包 BE-005：全局公平请求调度器

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：BE-005

## 本次实现内容

- 新增 `TextTranslationRequestScheduler`，提供全局模型请求槽位调度。
- 默认全局上限为 5，并发任务单任务默认上限为 3，串行任务单任务上限为 1。
- `acquire()` 返回 idempotent release 函数，释放后自动 drain 等待队列。
- 等待队列按 taskId 轮转，避免一个大任务长期占满新释放的槽位。
- 支持 priority；同优先级内进行 task 轮转。
- 支持 `cancelWaiting(taskId)`，只取消对应 task 的等待请求，不影响已获得槽位的请求。
- 支持等待中的 AbortSignal 取消。
- 新增 `snapshot()`，返回 active/waiting 计数，供后续 UI 或测试观察。
- 新增调度器单测，覆盖全局上限、单任务上限、其它任务利用空槽、公平轮转、串行模式上限、取消等待、AbortSignal 和重复 release 安全。

## 修改文件

- `electron/main/text-translation/request-scheduler.ts`
- `test/text-translation/scheduler/requestScheduler.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `ReleaseTextTranslationRequestSlot`。
- 新增 `TextTranslationRequestSchedulerOptions`。
- 新增 `AcquireTextTranslationRequestSlotOptions`。
- 新增 `TextTranslationRequestSchedulerSnapshot`。
- 新增 `TextTranslationRequestSchedulerCancelledError`。
- 新增 `TextTranslationRequestScheduler.acquire()` / `cancelWaiting()` / `snapshot()`。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/scheduler/requestScheduler.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/scheduler/requestScheduler.test.ts`：1 个测试文件、5 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts`：8 个测试文件、51 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- BE-005 只提供调度器；BE-007 接入时需要确保 429 retry sleep 不长期占用槽位，即请求失败并进入重试等待前应 release，下一次重试再 acquire。
- 动态降低并发属于后续优化，本包先实现固定全局上限与公平队列。

## 下一步建议

- 继续认领 `BE-006：TXT 仅译文输出组装器`。
- BE-006 应使用 BE-003 的 split metadata 避免段内硬切在最终输出中产生额外空行。
- 输出路径冲突策略应默认 `index`，不得默认覆盖源文件。
