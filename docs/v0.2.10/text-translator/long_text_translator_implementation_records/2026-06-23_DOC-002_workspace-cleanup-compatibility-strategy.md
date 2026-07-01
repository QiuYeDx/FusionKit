# 工作包 DOC-002：工作区清理与兼容策略收口

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：`DOC-002`

## 1. 本次目标

完成长文本翻译恢复工作区的数据生命周期策略，使成功任务、非成功任务、缺失 metadata 和旧 schema 工作区在发布前都有明确的清理或复核行为。

## 2. 关键变更

### 2.1 Repository 清理计划

- 在 `TextTranslationWorkspaceRepository` 增加 `planWorkspaceCleanup`。
- 默认策略：
  - `completed` 任务保留 7 天，过期后进入 `delete`。
  - 失败、取消、暂停、部分完成等非成功任务默认保留，30 天后进入 `review`。
  - 缺失 `task.json` 的工作区进入 `review`。
  - `schemaVersion !== 1` 的工作区进入 `review`。
  - `updatedAt` 无法解析的任务进入 `review`。
- 清理计划返回 `taskId`、`workspacePath`、`action`、`reason`、`status`、`updatedAt` 和 `ageDays`，便于后续任务管理 UI 展示可诊断原因。

### 2.2 受控清理执行

- 增加 `cleanupWorkspaces`，默认只删除计划中 `action === "delete"` 的工作区。
- 支持 `deleteEligible: false` 作为 dry-run，只返回计划，不执行删除。
- 删除路径复用 `deleteWorkspace`，继续受 `taskId` 安全字符校验和 `assertPathInside` 保护，避免清理工作区之外的文件。

### 2.3 兼容策略

- 未知 `schemaVersion` 不参与自动删除，只进入人工复核。
- 缺失 metadata 不推断状态，不静默删除。
- 旧 schema 后续如需要迁移，应在迁移工作包中先支持只读识别、已完成译文导出和可诊断失败原因，再开放删除。
- 当前 UI 仍以用户显式删除任务为主，自动触发清理入口留给后续任务管理或设置页验收，避免 Beta 阶段静默删除用户敏感数据。

## 3. 测试覆盖

- `workspaceRepository.test.ts` 增加成功任务过期删除、近期成功任务保留、非成功旧任务复核的覆盖。
- 增加未知 schema 与缺失 task metadata 只进入人工复核的覆盖。

## 4. 验证

- `pnpm exec vitest run test/text-translation/persistence/workspaceRepository.test.ts`：7 tests passed。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vitest run src/type/textTranslationIpc.test.ts test/text-translation/input test/text-translation/memory test/text-translation/model test/text-translation/output test/text-translation/parsing test/text-translation/persistence test/text-translation/planning test/text-translation/scheduler test/text-translation/service`：12 files / 85 tests passed。
- `pnpm run i18n:check`：8 namespaces / 927 keys passed。
- `pnpm build`：通过；保留既有 Vite chunk size、动态/静态 import 和 electron-builder 未签名提示。
- `git diff --check`：通过。

## 5. 文档同步

- 更新 Execution Plan 顶部状态、第 5 节台账、DOC-002 详情和第 12 节下一步建议。
- 更新 Final Design 状态、数据清理策略、发布兼容策略和后续实现状态。

## 6. 遗留边界

- 自动清理 UI 暂未开放；当前仅提供 repository 层计划/执行能力和用户显式删除路径。
- QA-001 至 QA-003 仍需继续做自动化 fixture 收口、性能验收、跨平台手工验收和真实模型验证。

## 7. 下一步建议

进入 `QA-001：核心自动化测试与 Fixture 收口`。
