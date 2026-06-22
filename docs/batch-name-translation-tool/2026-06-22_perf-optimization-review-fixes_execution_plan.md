# 性能优化 Code Review 问题修复 Execution Plan

> 日期：2026-06-22  
> 对应来源：`RN-PERF-001` ~ `RN-PERF-007` 实施完成后的整体 Code Review  
> 对应设计文档：`docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization-final-design.md`  
> 范围：修复 Review 发现的安全性、数据正确性和健壮性问题，不涉及新功能。

## 1. 问题总览

| ID | 优先级 | 标题 | 风险 | 涉及文件 |
| --- | --- | --- | --- | --- |
| RV-001 | 高 | Dirent 快路径丢失 symlink 检测 | symlink directory 可能绕过 skip 安全规则 | `electron/main/rename/scanner.ts`、`test/rename/scanner.test.ts` |
| RV-002 | 高 | `checkRenameTargetsExist` 丢弃 errors | 权限错误路径被误判为不存在，apply 时可能覆盖已有文件 | `src/services/rename/nameTargetResolver.ts`、`src/services/rename/nameTypes.ts`、`src/services/rename/nameTranslationPlanner.ts`、`src/services/rename/nameTranslationPlanner.test.ts` |
| RV-003 | 中 | `createPlanFromSummary` fallback 使用截断 items | 大批量任务 apply 时会静默丢失超出 preview 限制的文件 | `src/store/tools/rename/useNameTranslatorStore.ts`、`src/store/tools/rename/useNameTranslatorStore.test.ts` |
| RV-004 | 中 | 批量 path-check 两层 fallback 全部失败时无警告 | 冲突检测静默失效，用户看到全部"安全" | `src/services/rename/nameTranslationPlanner.ts`、`src/services/rename/nameTranslationPlanner.test.ts` |
| RV-005 | 低 | 快路径缺少独立单元测试 | 正则修改回归风险高 | `src/services/rename/nameTranslationFastPath.test.ts`（新增） |
| RV-006 | 低 | 性能测试阈值 CI flaky 风险 | 高负载 CI 环境可能误报 | `test/rename/nameTranslationPlanner.performance.test.ts` |

## 2. 状态规则

沿用主执行计划状态值：`未开始`、`进行中`、`已完成`、`阻塞`、`废弃`。

## 3. 进度台账

| ID | 状态 | 完成日期 | 验证 | 实施记录 |
| --- | --- | --- | --- | --- |
| RV-001 | 已完成 | 2026-06-22 | `pnpm exec vitest run test/rename/scanner.test.ts` — 13 tests passed | `docs/batch-name-translation-tool/implementation-records/2026-06-22_RV-001_dirent-symlink-detection.md` |
| RV-002 | 已完成 | 2026-06-22 | `pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts` — 21 tests passed | `docs/batch-name-translation-tool/implementation-records/2026-06-22_RV-002_check-targets-exist-errors.md` |
| RV-003 | 已完成 | 2026-06-22 | `pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts` — 10 tests passed | `docs/batch-name-translation-tool/implementation-records/2026-06-22_RV-003_incomplete-plan-apply-guard.md` |
| RV-004 | 已完成 | 2026-06-22 | `pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts` — 23 tests passed | `docs/batch-name-translation-tool/implementation-records/2026-06-22_RV-004_fallback-path-check-warning.md` |
| RV-005 | 已完成 | 2026-06-22 | `pnpm exec vitest run src/services/rename/nameTranslationFastPath.test.ts` — 76 tests passed | `docs/batch-name-translation-tool/implementation-records/2026-06-22_RV-005_fast-path-unit-tests.md` |
| RV-006 | 已完成 | 2026-06-22 | `pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts` — 4 tests passed | `docs/batch-name-translation-tool/implementation-records/2026-06-22_RV-006_perf-test-flaky-fix.md` |

## 4. 工作包详情

---

### RV-001：Dirent 快路径丢失 symlink 检测

**优先级：高**

**问题描述：**

`electron/main/rename/scanner.ts` 中 `getPathInfoFromDirent()` 在 `entry.isFile()` / `entry.isDirectory()` 命中时硬编码 `symlink: false`，未检查 `entry.isSymbolicLink()`。Node.js 的 `readdir({ withFileTypes: true })` 返回的 Dirent，对于 symlink 指向文件的情况 `isFile()` 也返回 true，因此 symlink 会被误判为普通文件/目录。

原版 `getPathInfo()` 使用 `fs.lstat()` 正确检测 symlink。Dirent 快路径引入后 symlink directory 可能不被标记为 `symlink: true`，进而绕过下游 `getTargetSkipReason()` 中的 symlink skip 安全规则，违反执行计划约束第 8 条。

**修复方案：**

在 `getPathInfoFromDirent()` 中优先检查 `entry.isSymbolicLink()`，若为 symlink 则 fallback 到 `getPathInfo(absolutePath)` 走完整 `lstat` + `stat` 路径：

```typescript
async function getPathInfoFromDirent(
  targetPath: string,
  entry: Dirent
): Promise<PathInfo> {
  // symlink 需要 lstat 获取完整信息，不走快路径
  if (entry.isSymbolicLink()) {
    return getPathInfo(targetPath);
  }

  const absolutePath = path.resolve(targetPath);
  const basename = path.basename(absolutePath);
  const parentPath = path.dirname(absolutePath);
  const hidden = isHiddenPathSegment(basename);

  if (entry.isFile()) {
    return {
      absolutePath, basename, parentPath,
      exists: true, kind: "file", hidden, symlink: false,
    };
  }

  if (entry.isDirectory()) {
    return {
      absolutePath, basename, parentPath,
      exists: true, kind: "directory", hidden, symlink: false,
    };
  }

  return getPathInfo(absolutePath);
}
```

**测试补充：**

在 `test/rename/scanner.test.ts` 中增加断言：确认 symlink 指向目录时 `PathInfo.symlink === true`，且 scanner 仍跳过 symlink directory。

**涉及文件：**

- `electron/main/rename/scanner.ts` — 修改 `getPathInfoFromDirent()`
- `test/rename/scanner.test.ts` — 补充 symlink 快路径测试

**验收口径：**

- 现有 scanner 测试全部通过。
- symlink directory 在 Dirent 快路径下仍被正确跳过。
- 非 symlink 的普通文件/目录仍走快路径，不额外调用 `lstat`。

---

### RV-002：`checkRenameTargetsExist` 丢弃 errors

**优先级：高**

**问题描述：**

`src/services/rename/nameTargetResolver.ts` 中 `checkRenameTargetsExist()` 只返回 `result.existingPaths`，完全忽略 `result.errors`。当目标路径因权限问题（EACCES）无法 stat 时，该路径不出现在 `existingPaths` 中，调用方误判为"不存在"，apply 时可能覆盖实际存在的文件。

**修复方案：**

1. 扩展 `checkRenameTargetsExist` 返回值，将 errors 也传递出去：

```typescript
export interface BatchPathCheckResult {
  existingPaths: Set<string>;
  errorPaths: Map<string, string>; // path → error message
}

export async function checkRenameTargetsExist(
  paths: string[]
): Promise<BatchPathCheckResult> {
  if (paths.length === 0) return { existingPaths: new Set(), errorPaths: new Map() };
  const ipcRenderer = getIpcRenderer();
  const result = (await ipcRenderer.invoke("check-rename-target-paths", {
    paths,
  })) as CheckRenameTargetPathsResult;
  return {
    existingPaths: new Set(result?.existingPaths ?? []),
    errorPaths: new Map((result?.errors ?? []).map((e) => [e.path, e.message])),
  };
}
```

2. 在 `nameTranslationPlanner.ts` 的 `collectExistingTargetPaths()` 中接收 errors，将有错误的路径追加到 plan warnings：

```typescript
// 在 collectExistingTargetPaths 中：
const batchResult = await checkPathsExist(targetPaths);
// 对 batchResult.errorPaths 生成 warnings
for (const [p, msg] of batchResult.errorPaths) {
  warnings.push(`路径检查失败 (${msg}): ${p}`);
}
return [...batchResult.existingPaths];
```

3. 同步更新 `CreateNameTranslationPlanDeps` 中 `checkPathsExist` 的类型签名。

**涉及文件：**

- `src/services/rename/nameTargetResolver.ts` — 修改返回值
- `src/services/rename/nameTypes.ts` — 新增 `BatchPathCheckResult`（如需要）
- `src/services/rename/nameTranslationPlanner.ts` — `collectExistingTargetPaths()` 处理 errors
- `src/services/rename/nameTranslationPlanner.test.ts` — 补充 errors 测试

**验收口径：**

- 批量 IPC 返回 errors 时，plan warnings 包含对应路径和错误描述。
- 旧测试中只提供 `checkPathExists` 的 deps 仍通过。
- 权限错误不阻塞整个预览生成。

---

### RV-003：`createPlanFromSummary` fallback 使用截断 items

**优先级：中**

**问题描述：**

`src/store/tools/rename/useNameTranslatorStore.ts` 中 `createPlanFromSummary()` 用 `summary.itemsPreview`（受 `previewLimit` 截断）填充 `plan.items`，同时设 `itemsStored: false`。对于超出 preview 限制的大批量任务，用户 apply 时会静默丢失超出部分的文件。

**修复方案：**

在 `itemsStored: false` 的 plan 上阻止 apply 操作，并在 UI 上提示 items 不完整：

1. Store 的 `applyPlan()` 中检查 `plan.itemsStored === false && plan.items.length < plan.summary.totalCount` 时拒绝执行并提示。
2. UI 的 PlanPreviewTable 在 `itemsStored === false` 时显示警告 banner，提示用户完整 plan 已过期、需要重新生成。

**涉及文件：**

- `src/store/tools/rename/useNameTranslatorStore.ts` — apply 守卫
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx` — 不完整 plan 提示
- `src/store/tools/rename/useNameTranslatorStore.test.ts` — 测试 apply 守卫
- `src/locales/*/rename.json` — 新增提示文案

**验收口径：**

- `itemsStored: false` 且 items 不完整时 apply 被阻止。
- UI 有明确提示引导用户重新生成预览。
- items 完整时（小批量 fallback）apply 仍可正常执行。

---

### RV-004：批量 path-check 两层 fallback 全部失败时无警告

**优先级：中**

**问题描述：**

`collectExistingTargetPaths()` 中批量 `checkPathsExist` 抛异常后 fallback 到单路径 `checkPathExists`。单路径检查也全部失败时，返回空数组，冲突检测静默失效。

**修复方案：**

在单路径 fallback 循环中统计失败数，若失败比例超过阈值（如 > 50%）或全部失败，将诊断信息追加到 plan warnings：

```typescript
// 单路径 fallback 循环后：
if (checkErrorCount > 0) {
  warnings.push(
    `路径存在性检查部分失败 (${checkErrorCount}/${targetPaths.length})，冲突检测可能不完整`
  );
}
```

**涉及文件：**

- `src/services/rename/nameTranslationPlanner.ts` — fallback 统计与 warning
- `src/services/rename/nameTranslationPlanner.test.ts` — 补充全部失败场景测试

**验收口径：**

- 两层 fallback 全部失败时 plan warnings 包含诊断信息。
- 单个路径失败不阻塞预览生成（现有行为不变）。

---

### RV-005：快路径缺少独立单元测试

**优先级：低**

**问题描述：**

`nameTranslationFastPath.ts` 的 `DATE_PATTERN`、`NUMERIC_PATTERN`、`ASCII_SEASON_EPISODE_PATTERN`、`isTechnicalOnly` 等规则只通过 planner 测试间接覆盖了极少 case。修改正则时回归风险高。

**修复方案：**

新增 `src/services/rename/nameTranslationFastPath.test.ts`，按分类覆盖：

| 分类 | 正例（走快路径） | 反例（不走快路径） |
| --- | --- | --- |
| empty | `""`, `"  "` | — |
| numeric | `"001"`, `"1.2.3"` | `"1a"`, `"v1.0"` |
| date | `"2024-01-01"`, `"2024_06"` | `"2024abc"`, `"1899-01-01"` |
| episode_code | `"S01E02"`, `"Episode.12"`, `"ep_001"` | `"Season One"`, `"Episode Name"` |
| technical_only | `"1080p"`, `"x264.AAC"` | `"Movie 1080p"`, `"1080p intro"` |
| no_natural_language | `"---"`, `"()"`, `"★☆"` | `"hello"`, `"你好"` |

**涉及文件：**

- `src/services/rename/nameTranslationFastPath.test.ts`（新增）

**验收口径：**

- 所有列举的正反例测试通过。
- `pnpm exec vitest run src/services/rename/nameTranslationFastPath.test.ts` 通过。

---

### RV-006：性能测试阈值 CI flaky 风险

**优先级：低**

**问题描述：**

`test/rename/nameTranslationPlanner.performance.test.ts` 中断言 `concurrent.durationMs < serial.durationMs * 0.85`，在高负载 CI 环境下可能抖动失败。

**修复方案：**

将时间比较断言改为确定性的结构断言：

```typescript
// 替换时间比较：
// expect(concurrent.durationMs).toBeLessThan(serial.durationMs * 0.85);

// 改为验证并发结构正确性：
expect(maxConcurrentBatches).toBeLessThanOrEqual(config.concurrency);
expect(maxConcurrentBatches).toBeGreaterThan(1);
```

保留 `durationMs` 记录但降级为 `console.log` 供手工验收参考，不作为测试断言。

**涉及文件：**

- `test/rename/nameTranslationPlanner.performance.test.ts`

**验收口径：**

- 性能测试不依赖时间比较。
- 并发上限断言在任何环境下稳定通过。

---

## 5. 依赖关系

```text
RV-001 和 RV-002 互相独立，可并行。

RV-003 独立，可并行。

RV-004 可与 RV-002 合并实施（同在 collectExistingTargetPaths 改动），
       但建议分别验证和记录。

RV-005 和 RV-006 互相独立，可并行，且不依赖其他工作包。
```

## 6. 不可违反约束

继承主执行计划约束，补充以下 Review 修复约束：

1. 所有修复不得引入新功能，只修复已识别的问题。
2. 修改 Dirent 快路径时，非 symlink 的普通文件/目录仍必须走快路径（不退化性能）。
3. 修改 `checkRenameTargetsExist` 返回值时，必须保持旧 `checkPathExists` deps 在测试中可用。
4. 阻止 `itemsStored: false` plan 执行 apply 时，不得影响正常 plan 的 apply 流程。

## 7. 推荐验证命令

逐包最小验证：

```text
pnpm exec vitest run test/rename/scanner.test.ts
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts
pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm exec vitest run src/services/rename/nameTranslationFastPath.test.ts
pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts
```

全量回归：

```text
pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm run i18n:check
pnpm exec tsc --noEmit
```
