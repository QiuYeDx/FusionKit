# 工作包 RN-006：HomeAgent 工具 Schema 与执行器

## 基本信息

- 日期：2026-05-21
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-006_homeagent-tools-and-executor.md`

## 本次实现内容

- 新增 HomeAgent 名称翻译工具：`inspect_rename_paths`、`create_name_translation_plan`、`apply_name_translation_plan`。
- `create_name_translation_plan` 复用 RN-002 planner，只生成 dry-run 预览，并写入 Agent pending plan 状态。
- `apply_name_translation_plan` 复用 RN-003 validate/apply 链路，必须匹配当前 pending plan，且最近用户消息需明确确认。
- 更新 HomeAgent system prompt，区分字幕内容翻译与文件/文件夹名称翻译，并保持 `auto_execute` 不自动 apply rename。
- 新增确认识别和意图区分测试，覆盖模糊确认拒绝、明确确认允许、字幕翻译与文件名翻译分流。

## 修改文件

- `src/agent/tool-schemas.ts`
- `src/agent/tools.ts`
- `src/agent/tool-executor.ts`
- `src/agent/orchestrator.ts`
- `src/agent/types.ts`
- `src/store/agent/useAgentStore.ts`
- `src/pages/HomeAgent/SessionLogViewer.tsx`
- `src/agent/name-plan-confirmation.ts`
- `src/agent/name-translation-intent.ts`
- `src/agent/name-plan-confirmation.test.ts`
- `src/agent/name-translation-intent.test.ts`
- `src/agent/tool-schemas.test.ts`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-006_homeagent-tools-and-executor.md`

## 接口或数据结构变化

- `AgentLogEntryType` 新增 `name_translation_plan`、`name_translation_apply`。
- `AgentStore` 新增 `pendingNameTranslationPlan`、`setPendingNameTranslationPlan`、`confirmNameTranslationPlan`、`dismissNameTranslationPlan`。
- 新增 Agent 工具 schema：
  - `inspectRenamePathsSchema`
  - `createNameTranslationPlanSchema`
  - `applyNameTranslationPlanSchema`

## 验证结果

执行命令：

```text
pnpm exec vitest run src/agent/tool-schemas.test.ts src/agent/name-plan-confirmation.test.ts src/agent/name-translation-intent.test.ts
pnpm exec tsc --noEmit
pnpm exec vitest run src/agent src/services/rename test/rename
pnpm build
```

结果：

- 3 个 Agent 新增/相关测试文件通过，25 个断言通过。
- TypeScript 检查通过。
- Agent 与 rename 回归通过，11 个测试文件、61 个断言通过。
- 生产构建与 Electron 打包通过；保留既有 chunk size、动态导入和未签名提示。

## 未完成事项

- RN-007 需要在 HomeAgent 中把 rename plan tool result 和 pending plan 渲染为专用预览确认卡片。
- 当前 RN-006 可通过对话明确确认触发 apply，但还没有 UI 快捷确认入口。

## 下一步建议

- 开始 RN-007，优先新增 `NameTranslationPlanCard` 并接入 pending plan 的确认/取消按钮。
