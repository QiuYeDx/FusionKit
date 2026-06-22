# 文件名翻译工具任务处理性能优化 Execution Plan

> 日期：2026-06-17  
> 对应设计文档：`docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization-final-design.md`  
> 范围：将文件名 / 文件夹名翻译工具性能优化设计拆分为可连续交接的开发工作包、进度台账和验证合同。

## 1. 使用方式

每次开发会话开始前必须先读：

1. `docs/batch-name-translation-tool/2026-06-17_name-translation-speed-optimization-final-design.md`
2. 本执行计划文档
3. 准备认领工作包涉及的现有代码和测试

实施时只认领一个最小可闭环工作包。若两个工作包强耦合，必须在会话开头说明一起认领的原因，并在进度台账中分别更新状态。

每次完成代码工作后必须：

1. 运行该工作包列出的验证命令，或记录不能运行的原因。
2. 更新本文件的进度台账。
3. 在 `docs/batch-name-translation-tool/implementation-records/` 新增实施记录。
4. 若实际实现改变了设计契约，同步更新对应 final design。

## 2. 状态规则

工作包状态只使用以下值：

- `未开始`
- `进行中`
- `已完成`
- `阻塞`
- `废弃`

只有代码、测试、文档和台账都完成，并且验证命令通过或明确记录验证限制时，才能标记为 `已完成`。

## 3. 优先级原则

优先级按以下顺序推进：

1. 先让生成预览过程可观测，避免继续盲调。
2. 再减少模型请求数量，包括去重、快路径和缓存。
3. 再压缩模型请求墙钟时间，包括受控并发、退避和错误分类。
4. 再减少 renderer/main IPC 往返。
5. 最后优化主进程扫描器 IO。

不把真实 `fs.rename` apply 阶段作为本轮提速重点。apply、journal、rollback 的安全契约优先级高于速度。

## 4. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RN-PERF-001 | 已完成 | 2026-06-17 | Planner 进度与耗时观测 | `src/services/rename/nameTypes.ts`、`src/services/rename/nameTranslationPlanner.ts`、`src/services/rename/nameTranslationPlanner.test.ts` | `pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts`；`pnpm exec vitest run test/rename src/services/rename`；`pnpm exec tsc --noEmit` 失败于既有 code-block styled-jsx 属性类型问题 | `docs/batch-name-translation-tool/implementation-records/2026-06-17_RN-PERF-001_planner-progress.md` | 无 |
| RN-PERF-002 | 已完成 | 2026-06-17 | Store/UI 规划进度与取消入口 | `src/store/tools/rename/useNameTranslatorStore.ts`、`src/store/tools/rename/useNameTranslatorStore.test.ts`、`src/pages/Tools/Rename/NameTranslator/index.tsx`、`src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`、`src/locales/*/rename.json` | `pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm run i18n:check`；`pnpm exec tsc --noEmit` 失败于既有 code-block styled-jsx 属性类型问题 | `docs/batch-name-translation-tool/implementation-records/2026-06-17_RN-PERF-002_store-ui-progress-cancel.md` | 无 |
| RN-PERF-003 | 已完成 | 2026-06-17 | 翻译去重、快路径与内存缓存 | `src/services/rename/nameTranslationPlanner.ts`、`src/services/rename/nameTranslationCache.ts`、`src/services/rename/nameTranslationFastPath.ts`、`src/services/rename/nameTranslationPlanner.test.ts`、`src/services/rename/nameTranslationCache.test.ts` | `pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts src/services/rename/nameTranslationCache.test.ts`；`pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm run i18n:check`；`pnpm exec tsc --noEmit` 失败于既有 code-block styled-jsx 属性类型问题 | `docs/batch-name-translation-tool/implementation-records/2026-06-17_RN-PERF-003_dedupe-cache-fast-path.md` | 无 |
| RN-PERF-004 | 已完成 | 2026-06-17 | 受控并发翻译、错误分类与 abort 语义 | `src/services/rename/nameTranslationPlanner.ts`、`src/services/rename/nameTranslationPlanner.test.ts` | `pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts src/services/rename/nameTranslationCache.test.ts`；`pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm run i18n:check`；`pnpm exec tsc --noEmit` 失败于既有 code-block styled-jsx 属性类型问题 | `docs/batch-name-translation-tool/implementation-records/2026-06-17_RN-PERF-004_concurrent-translation.md` | 无 |
| RN-PERF-005 | 已完成 | 2026-06-18 | 批量目标路径存在性 IPC | `electron/main/rename/types.ts`、`electron/main/rename/ipc.ts`、`electron/main/rename/path-check.ts`、`src/services/rename/nameTargetResolver.ts`、`src/services/rename/nameTranslationPlanner.ts`、`src/store/tools/rename/useNameTranslatorStore.ts`、`test/rename/path-check.test.ts`、`src/services/rename/nameTranslationPlanner.test.ts`、`src/store/tools/rename/useNameTranslatorStore.test.ts` | `pnpm exec vitest run test/rename/path-check.test.ts src/services/rename/nameTranslationPlanner.test.ts src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm run i18n:check`；`pnpm exec tsc --noEmit` 失败于既有 code-block styled-jsx 属性类型问题 | `docs/batch-name-translation-tool/implementation-records/2026-06-18_RN-PERF-005_batch-path-exists-ipc.md` | 无 |
| RN-PERF-006 | 已完成 | 2026-06-18 | 扫描器 IO 优化与稳定排序 | `electron/main/rename/scanner.ts`、`test/rename/scanner.test.ts` | `pnpm exec vitest run test/rename/scanner.test.ts`；`pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm run i18n:check`；`pnpm exec tsc --noEmit` 失败于既有 code-block styled-jsx 属性类型问题 | `docs/batch-name-translation-tool/implementation-records/2026-06-18_RN-PERF-006_scanner-io-optimization.md` | 无 |
| RN-PERF-007 | 已完成 | 2026-06-18 | 性能回归测试、验收记录与文档回填 | `test/rename/nameTranslationPlanner.performance.test.ts`、本执行计划、final design、`docs/batch-name-translation-tool/implementation-notes/2026-05-21_final-implementation-status.md` | `pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts src/services/rename/nameTranslationPlanner.test.ts`；`pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts`；`pnpm run i18n:check`；`pnpm exec tsc --noEmit` 失败于既有 code-block styled-jsx 属性类型问题；`git diff --check` | `docs/batch-name-translation-tool/implementation-records/2026-06-18_RN-PERF-007_perf-tests-docs.md` | 真实模型性能按发布前手工验收清单执行；`pnpm build` 因 tsc 前置门禁仍被既有 styled-jsx 类型问题阻塞，未单独运行 |
| RN-PERF-008 | 已完成 | 2026-06-22 | 小批量自适应并发拆分 | `src/services/rename/nameTranslationPlanner.ts`、`src/services/rename/nameTranslationPlanner.test.ts`、`test/rename/nameTranslationPlanner.performance.test.ts` | `pnpm exec vitest run test/rename src/services/rename src/store/tools/rename/useNameTranslatorStore.test.ts src/agent/tool-schemas.test.ts` — 168 tests passed；fake 基准 single=64ms、legacy five=202ms、adaptive five=97ms；`pnpm exec tsc --noEmit` 仅失败于既有 styled-jsx 类型问题 | `docs/batch-name-translation-tool/implementation-records/2026-06-22_RN-PERF-008_small-batch-adaptive-concurrency.md` | 真实供应商绝对耗时仍按发布前手工验收记录 |

## 5. 工作包详情

### RN-PERF-001：Planner 进度与耗时观测

目标：不改变现有串行翻译行为，先让 planner 对外暴露阶段进度和内部耗时。

实施范围：

- 在 `src/services/rename/nameTypes.ts` 新增 `NameTranslationPlanningPhase`、`NameTranslationPlanningProgress` 和可选 metrics 类型。
- 扩展 `CreateNameTranslationPlanDeps`，新增 `progress?: (progress) => void` 和可选 `signal?: AbortSignal` 占位。
- 在 `createNameTranslationPlan` 中上报 `scanning`、`translating`、`checking_targets`、`validating`、`storing`、`done`、`failed`。
- 记录阶段耗时和 batch 统计，但本包不改变 batch size 和串行策略。
- 测试 progress 调用顺序、失败态 progress、原有 summary 兼容性。

验收口径：

- 旧的 planner 调用方式无需修改仍可工作。
- progress callback 不影响 plan store、planId、itemsPreview 行为。
- 出错时能上报 `failed`，且错误继续按原方式抛出。

### RN-PERF-002：Store/UI 规划进度与取消入口

目标：把 RN-PERF-001 的进度接到工具页状态，并提供取消入口。

实施范围：

- 在 `useNameTranslatorStore` 增加 `planningProgress`、`cancelPlanning` 和内部 `AbortController` 管理。
- `createPreview` 调用 planner 时传入 progress 和 signal。
- 取消后不写入新 plan，保留 selected paths 和 options。
- 在工具页生成预览区域展示简短阶段状态、进度条和取消按钮。
- 文案写入 `src/locales/*/rename.json`，保持中英日繁同步。

验收口径：

- 正常生成预览时，UI 状态从 planning 进入 done 并展示 plan。
- 取消时当前 plan 不被半成品覆盖。
- 若底层 in-flight 模型请求无法真正 abort，也必须阻止后续结果 commit。

### RN-PERF-003：翻译去重、快路径与内存缓存

目标：减少模型请求数量。

实施范围：

- 新增 `nameTranslationCache.ts`，实现 renderer 内存 TTL 和容量淘汰。
- 新增 `nameTranslationFastPath.ts`，只覆盖高置信跳过规则。
- 在 planner 中将 targets 转换为 work items，以 translation key 去重。
- 缓存命中和快路径结果 fan-out 到所有 target ids。
- 模型返回后写入缓存，再构造 plan items。
- progress 中补充 `cacheHitCount`、`fastPathCount`、`translatableCount`。

验收口径：

- 同一批次重复 stem 只调用一次模型。
- 同一会话重复生成相同配置的预览能命中缓存。
- 快路径项不会调用模型，并在 item warnings 中保留可诊断标记。
- `outputMode`、`bilingualSeparator` 等本地重组仍不触发重新翻译。

### RN-PERF-004：受控并发翻译、错误分类与 abort 语义

目标：缩短模型请求墙钟时间，同时避免无限并发和无意义 fallback。

实施范围：

- 新增小型 promise pool 或 `nameTranslationBatchQueue.ts`。
- 将 `translateTargets` 从批次串行改为受控并发。
- 默认配置：`batchSize = 50`、`concurrency = 3`、`minBatchSize = 5`、`maxBatchSize = 80`、`rateLimitBackoffMs = 1500`。
- schema/parse 类错误允许 text fallback 或 batch split。
- 401/403、quota、model not found、network unavailable 等非可恢复错误 fail fast。
- 429/rate limit 降级并发到 1 并退避重试。
- 在 batch 开始前、重试前、path check 前检查 abort signal。

验收口径：

- fake model 可证明最大并发不超过配置值。
- 10 个 batch、并发 3 的测试能明显小于串行耗时。
- 429 后会降速并记录 warning。
- abort 后不写 plan，不启动新 batch。

### RN-PERF-005：批量目标路径存在性 IPC

目标：减少规划和 revalidate 阶段的 renderer/main IPC 往返。

实施范围：

- 在 rename 主进程类型中新增 `CheckRenameTargetPathsParams` 和 `CheckRenameTargetPathsResult`。
- 在 `electron/main/rename/ipc.ts` 注册 `check-rename-target-paths`。
- 主进程内部使用有限并发检查路径存在性，建议并发 64。
- `src/services/rename/nameTargetResolver.ts` 新增 `checkRenameTargetsExist(paths)`。
- planner 的 `collectExistingTargetPaths` 优先使用批量接口，保留单路径 fallback。
- store 的 `revalidatePlanConflicts` 同步改用批量接口。

验收口径：

- 目标存在、目标缺失、权限错误都能返回可消费结果。
- 权限或单个路径错误不应导致整个预览失败。
- 旧测试 deps 中只提供 `checkPathExists` 时仍通过。

### RN-PERF-006：扫描器 IO 优化与稳定排序

目标：降低递归扫描大目录时的 IO 成本。

实施范围：

- 在 `electron/main/rename/scanner.ts` 中优先利用 `Dirent` 判断 file/directory。
- 仅在 symlink、other、需要 size/mtime 等情况下补充 `lstat/stat`。
- 引入有限并发目录扫描，但最终 targets 排序保持稳定。
- 保留 protected path、hidden path、symlink directory skip、maxDepth、maxTargets 规则。
- 扩展 scanner 测试，覆盖稳定顺序和安全规则不变。

验收口径：

- 现有 scanner 测试全部通过。
- 多次扫描同一 fixture 的 targets 顺序一致。
- symlink directory、hidden、protected path 行为与优化前一致。

### RN-PERF-007：性能回归测试、验收记录与文档回填

目标：把优化效果和后续维护入口固化下来。

实施范围：

- 新增 fake model 性能测试，不依赖真实模型网络。
- 测试并发上限、缓存命中、快路径、取消、batch split。
- 根据实际实现更新 final design 中的配置默认值或风险说明。
- 更新本执行计划进度台账。
- 如有必要，补 `implementation-notes` 中的最终性能优化状态。

验收口径：

- CI 不依赖真实模型提供商。
- 性能测试阈值宽松，避免环境抖动导致误报。
- 发布前验证命令和手工验收结果写入实施记录。

### RN-PERF-008：小批量自适应并发拆分

目标：修复 5～50 个名称仍落入单一模型请求、无法使用现有并发池的问题。

实施范围：

- `NameTranslationBatchConfig` 新增 `adaptiveBatching`，默认开启。
- 1～4 个 work items 保持单请求。
- 5 个以上且原始批次数未超过并发数时，均匀拆成最多 3 个批次。
- 5 项默认形成 `2 + 2 + 1`，并发峰值不超过 3。
- progress 的 `totalBatchCount` 与 metrics 使用自适应后的真实批次数。
- 增加 single / legacy five / adaptive five fake model 对照基准。

验收口径：

- 5 项不再作为一个模型响应串行生成。
- 4 项及以下不增加额外请求。
- 429 降速、取消、缓存、快路径和 batch split recovery 行为保持兼容。
- fake model 下 adaptive five 明显快于 legacy five，并保持在单项耗时的宽松倍数内。

## 6. 依赖关系

```text
RN-PERF-001
  -> RN-PERF-002
  -> RN-PERF-003
  -> RN-PERF-004

RN-PERF-001
  -> RN-PERF-005

RN-PERF-006 可在 RN-PERF-001 后并行，但建议放在 RN-PERF-003/004 之后。

RN-PERF-007 依赖 RN-PERF-003、RN-PERF-004，最好在 RN-PERF-005/006 后最终收口。
```

## 7. 不可违反约束

来自 final design 的约束在实现期间必须保持：

1. 只优化生成预览，不并发真实 `fs.rename` apply。
2. 所有真实重命名前仍必须先生成 dry-run plan，并经过用户确认。
3. HomeAgent 即使在 `auto_execute` 模式下，也只能自动生成预览，不能自动 apply。
4. `NameTranslationPlan`、`NameTranslationPlanSummary` 对既有调用保持兼容。
5. plan store 仍默认使用 renderer 内存，不把完整用户路径长期持久化。
6. 翻译缓存 key 默认不包含完整路径。
7. 快路径只覆盖高置信场景，不能为了省模型请求牺牲翻译正确性。
8. 扫描优化不能绕过 protected path、hidden path、symlink directory skip 等安全规则。
9. 取消任务后不能写入半成品 plan。
10. 批量 IPC 必须保留旧单路径 fallback，以便测试和旧环境兼容。

## 8. 推荐验证命令

按工作包选择最小命令：

```text
pnpm exec vitest run src/services/rename/nameTranslationPlanner.test.ts
pnpm exec vitest run src/store/tools/rename/useNameTranslatorStore.test.ts
pnpm exec vitest run test/rename/scanner.test.ts
pnpm exec vitest run test/rename src/services/rename
```

发布前或跨模块改动后补充：

```text
pnpm exec tsc --noEmit
pnpm build
```

如新增性能测试：

```text
pnpm exec vitest run test/rename/nameTranslationPlanner.performance.test.ts
```

## 9. 实施记录模板

每个会话结束前，在 `docs/batch-name-translation-tool/implementation-records/` 新增记录：

```markdown
# 工作包 <ID>：<标题>

## 基本信息

- 日期：
- 状态：已完成 / 部分完成 / 阻塞
- 对应执行计划工作包：

## 本次实现内容

-

## 修改文件

-

## 接口或数据结构变化

-

## 验证结果

执行命令：

```text

```

结果：

-

## 未完成事项

-

## 下一步建议

-
```

## 10. 下一步建议

性能优化主线 `RN-PERF-001` 到 `RN-PERF-008` 已收口。下一次优先处理发布前阻塞项：修复 `src/components/qiuye-ui/code-block/*` 中既有 styled-jsx React 类型问题，然后补跑 `pnpm exec tsc --noEmit`、`pnpm build` 和 10.3 的真实模型手工验收。
