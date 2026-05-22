# 工作包 RN-003：安全 Apply + Journal

## 基本信息

- 日期：2026-05-19
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-003_safe-apply-and-journal.md`

## 本次实现内容

- 新增主进程 `validate-rename-plan`，apply 前复验 plan 过期状态、`applyable`、blocked 项、source 存在与类型、target parent、target 冲突、basename 合法性和危险路径。
- 新增主进程 `apply-rename-plan`，只执行 `ready` 项，`unchanged/skipped` 计入 skipped，不参与真实 rename。
- 实现两阶段 rename：
  - Stage 1：`sourcePath -> tempPath`
  - Stage 2：`tempPath -> targetPath`
- 支持 case-only rename、A/B swap、目录 rename，以及父目录和子项同时 rename 时的路径重写。
- 新增 journal 文件读写，默认落在 `app.getPath("userData")/rename-journals/<journalId>.json`，测试可注入 `journalDir`。
- 新增 `rollback-rename-journal`，对 `final_done/temp_done` 操作做尽力回滚，失败项标记 `rollback_blocked`。
- 新增 renderer 侧 `nameApplyService`，从 `namePlanStore` 获取完整 plan 后调用 validate/apply/rollback IPC。

## 修改文件

- `electron/main/rename/types.ts`
- `electron/main/rename/path-utils.ts`
- `electron/main/rename/planner-validation.ts`
- `electron/main/rename/journal.ts`
- `electron/main/rename/apply.ts`
- `electron/main/rename/ipc.ts`
- `src/services/rename/nameTypes.ts`
- `src/services/rename/nameApplyService.ts`
- `test/rename/apply.test.ts`
- `test/rename/journal.test.ts`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-003_safe-apply-and-journal.md`
- `docs/batch-name-translation-tool/implementation-records/2026-05-19_RN-003_safe-apply-and-journal.md`

## 接口或数据结构变化

- 新增 IPC：
  - `validate-rename-plan`
  - `apply-rename-plan`
  - `rollback-rename-journal`
- 新增 renderer service：
  - `validateNameTranslationPlan(planId)`
  - `applyNameTranslationPlan(planId)`
  - `rollbackNameTranslationJournal(journalId)`
- `RenameJournalOperation` 增加 `kind`，用于目录优先回滚和路径重写。
- `NameTranslationPlan` 在 main 侧接受 `expiresAt`，用于 RN-002 plan store 的 30 分钟过期契约。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename src/services/rename
pnpm build
```

结果：

- rename 相关测试：6 files passed，26 tests passed。
- `pnpm build`：通过；electron-builder 产生 macOS arm64 DMG/zip，构建日志仅保留既有 chunk size warning、package description missing 和未签名提示。

## 未完成事项

- RN-004 需要在手动工具页接入 `createNameTranslationPlan`、`validateNameTranslationPlan`、`applyNameTranslationPlan` 和 `rollbackNameTranslationJournal`。
- RN-006/RN-007 需要在 HomeAgent 中加工具 schema、执行器和预览确认 UI。
- `path_segments` 仍未开放可应用计划，后续应在 UI/Agent 层继续显示为需要确认或不可应用。

## 下一步建议

- 下一会话优先认领 RN-004：实现手动工具页，让用户可以选择路径、创建预览、查看冲突，并通过 RN-003 的 apply service 手动确认执行。
