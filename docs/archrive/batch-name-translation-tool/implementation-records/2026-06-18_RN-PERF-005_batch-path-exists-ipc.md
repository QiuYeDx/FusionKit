# 工作包 RN-PERF-005：批量目标路径存在性 IPC

## 基本信息

- 日期：2026-06-18
- 状态：已完成
- 对应执行计划工作包：RN-PERF-005

## 本次实现内容

- 新增主进程批量路径存在性检查模块 `electron/main/rename/path-check.ts`。
- 在 rename IPC 注册 `check-rename-target-paths`。
- 主进程批量检查内部使用有限并发，默认并发 64。
- 批量检查会对输入路径去重；缺失路径视为正常不存在，不写入 errors；权限或未知错误按路径返回 errors。
- renderer resolver 新增 `checkRenameTargetsExist(paths)`，调用批量 IPC 并返回 existing path `Set`。
- planner 的目标路径存在性检查优先使用批量接口，批量接口不可用或失败时退回旧单路径 `checkPathExists`。
- store 的 `revalidatePlanConflicts` 同步优先使用批量接口，并保留旧单路径 fallback。
- path check progress metric 的 `pathCheckRequestCount` 改为按实际请求次数计数：批量成功为 1；批量失败后 fallback 为 `1 + paths.length`；旧 deps 只注入单路径时仍为 `paths.length`。

## 修改文件

- `electron/main/rename/types.ts`
- `electron/main/rename/ipc.ts`
- `electron/main/rename/path-check.ts`
- `src/services/rename/nameTypes.ts`
- `src/services/rename/nameTargetResolver.ts`
- `src/services/rename/nameTranslationPlanner.ts`
- `src/store/tools/rename/useNameTranslatorStore.ts`
- `test/rename/path-check.test.ts`
- `src/services/rename/nameTranslationPlanner.test.ts`
- `src/store/tools/rename/useNameTranslatorStore.test.ts`
- `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization_execution_plan.md`

## 接口或数据结构变化

- 主进程新增：
  - `CheckRenameTargetPathsParams`
  - `CheckRenameTargetPathsResult`
  - IPC channel：`check-rename-target-paths`
- renderer 新增：
  - `CheckRenameTargetPathsResult`
  - `checkRenameTargetsExist(paths): Promise<Set<string>>`
- `CreateNameTranslationPlanDeps` 新增可选 `checkPathsExist?: (filePaths: string[]) => Promise<Iterable<string>>`。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/rename/path-check.test.ts src/services/rename/nameTranslationPlanner.test.ts src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm run i18n:check
pnpm exec tsc --noEmit
```

结果：

- RN-PERF-005 最小验证：3 files / 29 tests passed。
- rename 与 store 扩展验证：9 files / 64 tests passed。
- `pnpm run i18n:check`：通过，所有 namespace 多语言 key 数一致。
- `pnpm exec tsc --noEmit`：失败于既有 `src/components/qiuye-ui/code-block/code-block-panel.tsx` 与 `src/components/qiuye-ui/code-block/code-block-root.tsx` 的 `style jsx global` React 类型问题；本次 rename 改动未出现新的类型错误。

## 未完成事项

- 本包不优化扫描器递归 IO；该项进入 RN-PERF-006。
- store/planner fallback 只在批量 IPC 抛错时触发；批量 IPC 返回的 per-path errors 当前不阻断预览，最终真实文件系统校验仍由 apply 前 `validate-rename-plan` 承担。

## 下一步建议

- 下一轮认领 RN-PERF-006：优化 `electron/main/rename/scanner.ts`，利用 `Dirent` 减少不必要 stat，引入有限并发目录扫描，同时保持 stable ordering 和安全 skip 规则不变。
