# RV-004 实施记录：批量 path-check 两层 fallback 全部失败时无警告

> 日期：2026-06-22
> 工作包：RV-004
> 状态：已完成

## 问题

`collectExistingTargetPaths()` 中批量 `checkPathsExist` 抛异常后 fallback 到单路径 `checkPathExists`。单路径检查也全部失败时，返回空数组且无任何 warning，冲突检测静默失效——用户看到全部"安全"但实际可能存在冲突。

## 修复内容

### `src/services/rename/nameTranslationPlanner.ts`

在 `collectExistingTargetPaths()` 的单路径 fallback 循环中新增 `checkErrorCount` 计数器，catch 分支递增。循环结束后若有失败，向 `warnings` 追加诊断信息：

```typescript
let checkErrorCount = 0;
// ...
} catch {
  checkErrorCount += 1;
}
// ...
if (checkErrorCount > 0) {
  warnings?.push(
    `路径存在性检查部分失败 (${checkErrorCount}/${targetPaths.length})，冲突检测可能不完整`
  );
}
```

### `src/services/rename/nameTranslationPlanner.test.ts`

新增 2 个测试用例：

1. **"warns when all single-path fallback checks fail"** — 3 条路径全部 throw EACCES，验证 warning 包含 `3/3` 和"冲突检测可能不完整"。
2. **"warns when some single-path fallback checks fail"** — 3 条中 1 条 throw EACCES，验证 warning 包含 `1/3`。

两个测试均验证：
- 预览生成不被阻塞（`readyCount === 3`）。
- 批量 IPC 被调用 1 次后 fallback 到单路径。

## 验收结果

```
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts
✓ src/services/rename/nameTranslationPlanner.test.ts (23 tests) — all passed
```

## 不可违反约束检查

- [x] 未引入新功能，仅修复已识别问题。
- [x] 单个路径失败不阻塞预览生成（现有行为不变）。
- [x] 旧测试中只提供 `checkPathExists` 的 deps 仍通过。
