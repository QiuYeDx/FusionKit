# 工作包 REL-002：恢复扫描、校验与继续执行

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：REL-002

## 本次实现内容

- `TextTranslationWorkspaceRepository` 新增 `listTaskIds()`，安全枚举任务工作区。
- `TextTranslationRecoverySummary` 新增 `sourceStatus`，区分 `matched`、`changed`、`missing`、`unchecked`。
- `listRecoverableTasks()` 真实扫描工作区：
  - 读取 `task.json`。
  - 读取 segment index。
  - 重放事件日志。
  - 校验 completed segment result 文件是否仍存在。
  - 校验未完成 segment 的冻结 source snapshot 是否存在。
  - 返回 resumable、completed / total segment、failedSegmentIds、blockingReason、sourceStatus。
- `resumeTask()` 支持恢复磁盘 task：使用当前请求携带的运行时模型凭据，不从磁盘恢复 API Key。
- 恢复时从 segment source snapshots 重建 `sourceText`，从 result 文件重建已完成译文。
- resume 执行时跳过已完成 segment，只请求缺失/失败 segment。
- resume 完成所有 segment 后组装正式输出；如果仍有失败则回到 `partially_completed` / `failed`。
- `restartTask()` 支持安全从头开始：删除目标 task workspace、保留 task 元数据、重置为 `not_started`，避免混用旧 result。
- IPC request 类型允许 `resumeTask` 携带可选运行时模型。

## 修改文件

- `electron/main/text-translation/persistence/workspace-repository.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `src/type/textTranslation.ts`
- `src/type/textTranslationIpc.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `TextTranslationRecoverySummary.sourceStatus?: "matched" | "changed" | "missing" | "unchecked"`。
- `ResumeTextTranslationTaskRequest` 新增可选 `model?: TextTranslationRuntimeModelConfig`。
- `TextTranslationService.resumeTask()` 从 `not_implemented` 变为可用。
- `TextTranslationService.restartTask()` 从 `not_implemented` 变为可用，语义为清空旧 workspace 后重置 task。

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

- `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`：1 个测试文件、3 个测试通过；覆盖恢复扫描、resume 后不重复请求已完成 segment。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`：10 个测试文件、58 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 恢复列表、继续、从头开始、删除工作区和错误详情 UI 尚未接入，由 REL-003 完成。
- 当前恢复执行仍限定单 TXT、parallel、target-only。
- source changed/missing 当前只进入 summary，风险提示的具体交互由 REL-003 实现。

## 下一步建议

- 继续认领 `REL-003：恢复与错误管理 UI`。
- REL-003 应复用 `listRecoverableTextTranslationTasks`、`resumeTextTranslationTask`、`restartTextTranslationTask`、`deleteTextTranslationTask`、`revealTextTranslationWorkspace`，不要绕过 IPC wrapper。
