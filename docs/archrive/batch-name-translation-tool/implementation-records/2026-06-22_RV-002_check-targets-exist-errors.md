# 工作包 RV-002：`checkRenameTargetsExist` 丢弃 errors

## 基本信息

- 日期：2026-06-22
- 状态：已完成
- 对应执行计划工作包：RV-002

## 本次实现内容

- 新增 `BatchPathCheckResult` 类型，包含 `existingPaths: Set<string>` 和 `errorPaths: Map<string, string>`。
- `checkRenameTargetsExist()` 返回值从 `Set<string>` 改为 `BatchPathCheckResult`，不再丢弃 IPC 返回的 `errors`。
- `CreateNameTranslationPlanDeps.checkPathsExist` 类型签名同步更新为返回 `BatchPathCheckResult`。
- `collectExistingTargetPaths()` 新增 `warnings` 参数，处理 `batchResult.errorPaths` 并将每个错误路径格式化为 `路径检查失败 (${message}): ${path}` 追加到 warnings。
- Plan 构建时将 `pathCheckWarnings` 与 `scanResult.warnings`、`translationWarnings` 合并。
- 新增测试 "surfaces batch path-check errors as plan warnings" 验证 EACCES 等权限错误被正确传递到 plan warnings。

## 修改文件

- `src/services/rename/nameTypes.ts` — 新增 `BatchPathCheckResult` 接口
- `src/services/rename/nameTargetResolver.ts` — `checkRenameTargetsExist()` 返回 `BatchPathCheckResult`
- `src/services/rename/nameTranslationPlanner.ts` — 更新 deps 类型、`collectExistingTargetPaths()` 处理 errorPaths、合并 `pathCheckWarnings`
- `src/services/rename/nameTranslationPlanner.test.ts` — 更新现有 `checkPathsExist` mock 返回格式、新增 error path warnings 测试

## 接口或数据结构变化

新增类型：

```typescript
export interface BatchPathCheckResult {
  existingPaths: Set<string>;
  errorPaths: Map<string, string>;
}
```

`CreateNameTranslationPlanDeps.checkPathsExist` 签名变更：

```typescript
// before
checkPathsExist?: (filePaths: string[]) => Promise<Iterable<string>>;
// after
checkPathsExist?: (filePaths: string[]) => Promise<BatchPathCheckResult>;
```

## 验证结果

执行命令：

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts
```

结果：

- 21 tests passed (含新增 error path warnings 测试)
- Duration: 375ms

## 未完成事项

无。

## 下一步建议

继续 RV-003：`createPlanFromSummary` fallback 使用截断 items。
