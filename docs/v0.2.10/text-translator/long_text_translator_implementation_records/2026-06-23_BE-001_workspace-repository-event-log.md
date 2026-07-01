# 工作包 BE-001：工作区 Repository 与事件日志

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：BE-001

## 本次实现内容

- 新增 `TextTranslationWorkspaceRepository`，默认工作区路径为 `<userData>/text-translation/tasks/<taskId>/`，单测通过临时目录注入避免依赖真实用户数据目录。
- 实现受控目录创建：`task.json`、`files.ndjson`、`units/`、`segments/index.ndjson`、`segments/source/`、`results/`、`memory/latest.json`、`memory/snapshots/`、`events.ndjson`、`metrics.json`、`locks/`。
- 实现 `task.json`、segment source/result、memory latest/snapshot 的临时文件原子写入、文件 fsync 和目录 fsync 降级。
- 实现 files / units / segments 的 NDJSON 写入与读取，以及事件日志 append/read。
- 增加 taskId、fileId、segmentId、snapshotId 的安全 ID 校验和工作区路径逃逸防护。
- 新增 `event-log.ts`，定义持久化事件类型、敏感字段写入前检查和最小状态重放能力。
- 事件日志拒绝 `apiKey`、`authorization`、`content`、`sourceText`、`translatedText`、`rawText`、`body` 等敏感或全文字段。
- 实现删除单个 task workspace，删除前仍走受控路径解析。

## 修改文件

- `electron/main/text-translation/persistence/workspace-repository.ts`
- `electron/main/text-translation/persistence/event-log.ts`
- `test/text-translation/persistence/workspaceRepository.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `TextTranslationWorkspaceEvent` 持久化事件 union，覆盖任务状态、segment started/completed/failed/stale、file completed、task completed/failed 和 warning。
- 新增 `TextTranslationReplayedState`，用于从 `events.ndjson` 重放出 lastSequence、完成/失败/stale segment、result path、file output path、task output path 与 warning code。
- 新增 Repository API：
  - `ensureWorkspace`
  - `writeTask` / `readTask`
  - `writeFilesIndex` / `readFilesIndex`
  - `writeUnits` / `readUnits`
  - `writeSegmentsIndex` / `readSegmentsIndex`
  - `writeSegmentSource` / `readSegmentSource`
  - `writeSegmentResult` / `readSegmentResult`
  - `writeMemoryLatest` / `readMemoryLatest`
  - `writeMemorySnapshot`
  - `appendEvent` / `readEvents` / `replayEvents`
  - `deleteWorkspace`

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/persistence/workspaceRepository.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/persistence/workspaceRepository.test.ts`：1 个测试文件、5 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts`：4 个测试文件、20 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- 本包只实现 Repository 与事件日志基础；应用启动扫描、schema 校验、源文件 matched/changed/missing 判断和继续执行由 REL-002 落地。
- 真实 parser、executor 和 output assembler 尚未写入这些 API，后续 BE-002/BE-003/BE-007 接入。

## 下一步建议

- 继续认领 `BE-002：文件检查、编码探测与解码`。
- BE-002 可把输入文件元数据、encoding summary、fingerprint 和解码警告写入 BE-001 工作区结构，但不得把 API Key 或完整模型 profile 持久化。
- 低置信度编码应产出结构化错误并停在 `detecting_encoding` 阶段，不能继续发起模型请求。
