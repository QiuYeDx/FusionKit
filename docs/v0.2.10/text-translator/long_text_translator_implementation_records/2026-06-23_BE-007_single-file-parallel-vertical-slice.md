# 工作包 BE-007：单文件并发执行垂直切片

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：BE-007

## 本次实现内容

- 将 `TextTranslationService` 从占位实现替换为最小真实主进程实现。
- 支持单个 TXT、parallel、target-only 的 create / prepare / start 主流程。
- `createTask` 生成稳定 `taskId`、检查输入文件、创建任务工作区、写入 files index 和不含 API Key 的 task metadata。
- `prepareTask` 重新读取并解码文件，解析 TXT units，规划 segments，写入 units、segments index 和 segment source snapshots。
- `startTask` 使用 `TextTranslationRequestScheduler` 控制请求槽位，调用 `sendOpenAICompatibleChatCompletion`，每片成功后写入 result 文件并追加事件日志。
- 全部 segment 成功后调用 TXT target-only output assembler 写入正式输出文件。
- 维护运行时 task registry 和 AbortController；`cancelTask` 可 abort 当前任务并取消等待槽位。
- `deleteTask` 支持删除受控 task workspace。
- `getTaskDetail`、`revealOutput`、`revealWorkspace` 提供最小可用查询能力。
- 新增 fake server 端到端测试，覆盖 create -> prepare -> start -> fake model -> workspace events/results -> output file。

## 修改文件

- `electron/main/text-translation/text-translation-service.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `TextTranslationService` 现在真实实现 `createTask`、`prepareTask`、`startTask`、`cancelTask`、`deleteTask`、`listRecoverableTasks`、`getTaskDetail`、`revealOutput`、`revealWorkspace`。
- `pauseTask`、`resumeTask`、`restartTask` 仍返回 `not_implemented`，后续由 REL-001/REL-002 完成。
- BE-007 当前能力边界为单 TXT、parallel、target-only；多文件、Markdown、双语、串行记忆和可靠恢复仍由后续工作包扩展。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`：1 个测试文件、1 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`：10 个测试文件、56 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- Renderer 页面尚未接入；FE-001/FE-002 继续完成工具入口和手动页面。
- 当前 service 只支持单 TXT、parallel、target-only； REL、MEM、PROJ、OUT、MD 工作包继续扩展状态机、恢复、串行记忆、项目、双语和 Markdown。
- `pauseTask`、`resumeTask`、`restartTask` 尚未实现。

## 下一步建议

- 继续认领 `FE-001：工具入口与页面骨架`。
- FE-001 应只完成入口、路由、页面骨架、空状态、模型未配置状态和 i18n，不要把 FE-002 的完整执行交互提前塞入。
- FE-002 接入时复用 `src/services/text/textTranslatorExecutionService.ts`，不要在页面组件里直接手写 IPC channel 字符串。
