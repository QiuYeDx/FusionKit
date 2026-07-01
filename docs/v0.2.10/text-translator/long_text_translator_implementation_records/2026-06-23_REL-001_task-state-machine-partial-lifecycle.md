# 工作包 REL-001：任务状态机、部分完成与生命周期控制

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：REL-001

## 本次实现内容

- 在 `TextTranslationService` 中增加状态转换守卫，非法状态下的 start / prepare / pause / cancel / delete 会返回结构化 IPC 失败。
- `startTask` 仅允许从 `waiting` 启动，避免未 prepare、运行中或完成后的重复启动。
- `prepareTask` 仅允许从 `not_started`、`failed`、`cancelled` 重新准备。
- `pauseTask` 改为真实实现：仅允许运行中任务暂停，立即 abort 当前 controller，取消调度队列中等待槽位，状态写为 `paused` 并保留工作区。
- `cancelTask` 明确保留工作区，允许取消 preparing / waiting / running / paused / failed / partially_completed 任务。
- `deleteTask` 拒绝删除 running / preparing 任务，要求先取消。
- 并发翻译时单 segment 失败不再立刻中断其它独立 segment；失败 segment 写入 `segment_failed` 事件，其它 segment 继续请求和落盘。
- 固定并发结果规则：
  - 全部 segment 成功：`completed`，组装正式输出。
  - 部分成功、部分失败：`partially_completed`，不组装完整输出，保留已完成 segment result。
  - 全部失败：`failed`。
- `partially_completed`、`failed`、`paused`、`cancelled` 终态均写入 `task_status_changed` 事件，供 REL-002 恢复扫描重放。
- 持久化 `failedSegmentIds`，为后续恢复/继续执行提供稳定输入。

## 修改文件

- `electron/main/text-translation/text-translation-service.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `pauseTask` 从 `not_implemented` 变为可用。
- 状态转换错误统一返回 `invalid_ipc_request`，message 指出当前任务状态。
- `PersistedTextTranslationTask.failedSegmentIds` 现在由 service 在部分失败场景写入。
- 暂停策略明确为“立即 abort 当前请求并保留工作区”，继续执行由 REL-002 接入。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`：1 个测试文件、3 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`：10 个测试文件、58 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- `paused` / `partially_completed` 的继续执行尚未实现，由 REL-002 完成。
- 恢复扫描仍未读取磁盘工作区生成可恢复任务列表。
- UI 的恢复与错误管理面板仍由 REL-003 完成。
- 串行模式失败即停止的完整 executor 仍由 MEM-003 实现；本包只固定并发模式的部分完成语义。

## 下一步建议

- 继续认领 `REL-002：恢复扫描、校验与继续执行`。
- REL-002 应基于事件日志、task.json、source snapshots 和 segment results 判断 completed / failed / stale / missing，不重复请求已完成 segment。
