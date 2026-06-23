# HomeAgent 控制字幕翻译历史任务恢复设计

日期：2026-06-03

关联文档：

- `docs/subtitle-translator/20260603_resume_task_discovery_design.md`
- `docs/home-agent/home-agent-architecture.md`

## 背景

字幕翻译任务恢复功能已经具备手动入口：

- 主进程可扫描和解析 `*.fusionkit.resume.json`：`electron/main/translation/recovery-discovery.ts`
- IPC 已注册恢复相关通道：`electron/main/translation/ipc.ts`
- renderer service 已封装 IPC：`src/services/subtitle/translatorRecoveryService.ts`
- 字幕翻译页已有恢复弹窗：`src/pages/Tools/Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx`
- 翻译 store 已支持 `addRecoveredTask()` / `addRecoveredTasks()`：`src/store/tools/subtitle/useSubtitleTranslatorStore.ts`

但 HomeAgent 目前只知道：

1. `scan_subtitle_files`：扫描普通字幕文件。
2. `queue_subtitle_translate`：读取普通字幕文件并加入翻译队列。
3. `queue_subtitle_convert` / `queue_subtitle_extract`。
4. 名称翻译相关 dry-run 工具。

因此用户说“恢复之前失败的字幕翻译任务”“扫描输出目录里的 resume json 并继续翻译”时，Agent 缺少专门工具，只可能误用 `scan_subtitle_files` 或把 `*.fusionkit.resume.json` 当作普通字幕源文件处理。

本文只做开发设计，不开始实现。

## 目标

1. 让 HomeAgent 能通过自然语言扫描历史字幕翻译恢复任务。
2. 让 HomeAgent 能把可恢复候选加入字幕翻译队列，并按当前执行模式决定是否启动。
3. 避免把恢复清单 JSON 当作普通字幕文件翻译。
4. 支持大批量恢复候选，复用 HomeAgent 现有 scanId + batchStart + batchSize 思路。
5. 复用现有恢复实现，不重复写扫描、manifest 校验、draft 生成逻辑。
6. 保持恢复任务属于 translate store，因此继续使用 `pendingExecution` / `auto_execute` 机制。

## 非目标

1. 不在 Agent 中实现文件选择弹窗。Agent 只处理用户文本中给出的路径，或使用当前字幕翻译输出目录。
2. 不让 Agent 修改 manifest、删除临时文件或清理恢复产物。
3. 不让 Agent 改写 manifest 中的语言、分片策略、输出目录；这些以恢复清单为准。
4. 不做分片级选择性恢复。
5. 不改变手动 `RecoveryDialog` 的交互。

## 当前链路缺口

### HomeAgent 现有工具

相关文件：

- `src/agent/tool-schemas.ts`
- `src/agent/tools.ts`
- `src/agent/tool-executor.ts`
- `src/agent/orchestrator.ts`
- `src/agent/queue-batch.ts`
- `src/store/agent/useAgentStore.ts`

现有系统提示中写明：

- 目录处理先调用 `scan_subtitle_files`。
- 大批量扫描结果用 `scanId` 批量入队。
- 入队后通过 `handlePostQueue("translate" | "convert" | "extract")` 接入执行模式。

恢复任务与普通字幕文件不同：

| 项 | 普通字幕翻译 | 历史恢复任务 |
| --- | --- | --- |
| 扫描对象 | `.srt` / `.lrc` / `.vtt` | `*.fusionkit.resume.json` |
| 入队依据 | 字幕源文件路径和内容 | manifest candidate / checkpointPath |
| 任务内容 | 读取源文件文本 | `createRecoveredSubtitleTaskDraft()` 生成 |
| 语言/分片策略 | 用户参数或默认值 | manifest options 为准 |
| 续跑状态 | 新任务从 0 开始 | 保留 resolvedFragments / progress |

所以不应复用 `scan_subtitle_files` 的 `scanId` 存储结构，也不应让 `queue_subtitle_translate` 接受 resume json 路径。

## 用户可见行为

### 支持的自然语言

应支持这些表达：

```text
扫描当前输出目录里之前失败的字幕翻译任务
恢复上次中断的字幕翻译任务
把 /Users/me/subs-output 里的 FusionKit 恢复任务都加回队列
继续执行 /Users/me/subs-output 里还没翻译完的字幕任务
导入 /Users/me/movie.fusionkit.resume.json 继续翻译
扫描这个目录下的 resume.json，能恢复的都继续
```

### 推荐交互

如果用户提供目录：

```text
用户：恢复 /Users/me/subs-output 里之前失败的字幕翻译任务
Agent：调用 scan_subtitle_recovery_tasks
Agent：调用 queue_recovered_subtitle_translate
Agent：总结已加入队列数量、跳过数量、执行状态
```

如果用户没有提供路径：

1. 如果字幕翻译 store 有 `outputURL`，Agent 可以使用当前输出目录扫描。
2. 如果没有 `outputURL`，Agent 应追问用户要扫描哪个目录。

如果扫描结果很多：

1. `scan_subtitle_recovery_tasks` 返回 `recoveryScanId` 和有限 preview。
2. Agent 用 `queue_recovered_subtitle_translate` 按 batch 继续入队。
3. 如果 `batch.hasMore=true`，继续调用下一批，直到完成。

如果扫描到 `ready_from_manifest`：

- 可以加入队列，使用 `manifest_fragments` 模式。
- Agent 总结时必须说明“部分任务源文件缺失或变化，将使用恢复清单中保存的原始分片续跑”。

如果扫描不到可恢复候选：

- Agent 不调用 queue 工具。
- 直接说明没有找到可恢复任务，并给出扫描目录和跳过原因摘要。

## 总体设计

新增两个 HomeAgent 工具：

```text
scan_subtitle_recovery_tasks
queue_recovered_subtitle_translate
```

数据流：

```text
用户恢复请求
  -> LLM 调用 scan_subtitle_recovery_tasks
  -> executor 调用 scanTranslationRecoveryArtifacts / inspectTranslationRecoveryArtifact
  -> recovery-batch 缓存完整候选，返回 recoveryScanId + preview
  -> LLM 调用 queue_recovered_subtitle_translate
  -> executor 解析 recoveryScanId / batch
  -> createRecoveredSubtitleTaskDraft
  -> 注入当前 task model
  -> useSubtitleTranslatorStore.addRecoveredTasks
  -> handlePostQueue("translate")
```

新增文件建议：

```text
src/agent/recovery-batch.ts
src/agent/subtitle-recovery-intent.ts
```

修改文件：

```text
src/agent/tool-schemas.ts
src/agent/tools.ts
src/agent/tool-executor.ts
src/agent/orchestrator.ts
src/agent/types.ts
src/agent/tool-schemas.test.ts
src/agent/queue-batch.test.ts
```

可选补充：

```text
src/agent/subtitle-recovery-intent.test.ts
```

## Tool Schema 设计

### `scan_subtitle_recovery_tasks`

用途：扫描恢复清单，不加入队列。

```ts
export const scanSubtitleRecoveryTasksSchema = z.object({
  roots: z
    .array(z.string())
    .optional()
    .describe("Absolute directories to scan for *.fusionkit.resume.json."),
  checkpointPaths: z
    .array(z.string())
    .optional()
    .describe("Explicit *.fusionkit.resume.json file paths to inspect."),
  useCurrentOutputDir: z
    .boolean()
    .default(false)
    .describe("Use current subtitle translator output directory when user asks to scan previous output without giving a path."),
  recursive: z.boolean().default(true),
  maxDepth: z.number().int().min(0).max(12).default(8),
  maxFiles: z.number().int().min(1).max(500).default(500),
  includeCompleted: z.boolean().default(false),
});
```

约束：

- `roots`、`checkpointPaths`、`useCurrentOutputDir` 至少一个有效。
- `checkpointPaths` 用于用户明确给出单个或多个 resume json 文件。
- 默认不返回 completed 任务。

### `queue_recovered_subtitle_translate`

用途：把恢复候选加入翻译队列。

```ts
export const queueRecoveredSubtitleTranslateSchema = z.object({
  recoveryScanId: z
    .string()
    .optional()
    .describe("recoveryScanId returned by scan_subtitle_recovery_tasks."),
  checkpointPaths: z
    .array(z.string())
    .optional()
    .describe("Explicit checkpoint paths. Use only for small explicit lists."),
  candidateIds: z
    .array(z.string())
    .optional()
    .describe("Specific candidate ids from a recovery scan preview."),
  batchStart: z.number().int().min(0).default(0),
  batchSize: z.number().int().min(1).max(25).default(15),
  recoverability: z
    .enum(["ready", "ready_from_manifest", "both"])
    .default("both")
    .describe("Which recoverable candidates to queue."),
  conflictPolicy: z
    .enum(["index", "overwrite"])
    .default("index")
    .describe("Final output filename conflict policy. Use overwrite only when explicitly requested."),
  concurrentSlices: z
    .boolean()
    .default(true)
    .describe("Whether resumed unfinished slices may run concurrently."),
});
```

约束：

- `recoveryScanId` 和 `checkpointPaths` 至少一个有效。
- 不能接受 `sourceLang`、`targetLang`、`sliceType`、`outputDir`，这些由 manifest 决定。
- `recoverability="both"` 会加入 `ready` 和 `ready_from_manifest`。
- 不可恢复候选一律跳过，不报致命错误。

## Recovery Scan 缓存

新增 `src/agent/recovery-batch.ts`，仿照 `queue-batch.ts`。

核心类型：

```ts
export type StoredRecoveryCandidate = TranslationRecoveryCandidate;

type StoredRecoveryScanResult = {
  recoveryScanId: string;
  candidates: StoredRecoveryCandidate[];
  createdAt: number;
};

export type RecoveryBatchMeta = {
  recoveryScanId: string;
  batchStart: number;
  batchEnd: number;
  batchSize: number;
  attemptedCount: number;
  totalCandidates: number;
  queuedThrough: number;
  hasMore: boolean;
  nextBatchStart: number | null;
  remainingCount: number;
};
```

导出函数：

```ts
rememberRecoveryScanResult(candidates): string;
createRecoveryScanResultPayload(result, scannedRoots): RecoveryScanPayload;
resolveRecoveryCandidateSelection(args): RecoveryCandidateSelection;
clearStoredRecoveryScanResults(): void;
```

返回给 LLM 的 payload 必须有界：

```ts
{
  recoveryScanId,
  candidates: candidatesPreview,
  totalCount,
  recoverableCount,
  readyCount,
  readyFromManifestCount,
  completedCount,
  invalidCount,
  scannedRoots,
  allCandidatesIncluded,
  previewCount,
  omittedCount,
  recommendedQueueBatchSize,
  maxQueueBatchSize,
  queueInstruction
}
```

候选 preview 不包含字幕正文或译文，只包含摘要字段。

## Executor 设计

### `executeScanSubtitleRecoveryTasks`

流程：

1. 解析扫描来源：
   - `roots` 直接使用。
   - `useCurrentOutputDir` 从 `useSubtitleTranslatorStore.getState().outputURL` 读取。
   - `checkpointPaths` 逐个调用 `inspectTranslationRecoveryArtifact()`。
2. 调用 `scanTranslationRecoveryArtifacts()` 或 `inspectTranslationRecoveryArtifact()`。
3. 合并、按 `checkpointPath` 去重。
4. 调用 `createRecoveryScanResultPayload()` 保存完整候选并返回 preview。
5. 写 session log，类型建议新增 `subtitle_recovery_scan`。

错误处理：

- 当前输出目录为空时返回 `success:false`，提示用户提供目录。
- 单个 checkpoint inspect 失败时记录到 `errors`，其它继续。
- 扫描结果为空时仍返回 `success:true`，`totalCount=0`。

### `executeQueueRecoveredSubtitleTranslate`

流程：

1. 校验任务模型：复用 `useModelStore.getState().getTaskProfile()`。
2. 解析候选：
   - 有 `recoveryScanId`：从 `recovery-batch` 取 batch 或 candidateIds。
   - 有 `checkpointPaths`：先 inspect 成候选，再处理。
3. 过滤可恢复候选：
   - `ready` -> `recoveryInputMode="source_file"`
   - `ready_from_manifest` -> `recoveryInputMode="manifest_fragments"`
   - 其它 -> skip
4. 对每个候选调用 `createRecoveredSubtitleTaskDraft({ checkpointPath, recoveryInputMode })`。
5. 注入当前任务模型：

```ts
const task: SubtitleTranslatorTask = {
  ...draft,
  fileContent: draft.fileContent || "",
  status: TaskStatus.NOT_STARTED,
  apiKey: taskProfile.apiKey,
  apiModel: taskProfile.modelKey,
  endPoint: taskProfile.baseUrl,
  conflictPolicy: args.conflictPolicy ?? "index",
  concurrentSlices: args.concurrentSlices ?? true,
};
```

6. 调用 `useSubtitleTranslatorStore.getState().addRecoveredTasks(tasks)`。
7. 返回 queue summary。
8. 调用 `handlePostQueue("translate", addedCount, result)`。

返回数据：

```ts
{
  queuedCount,
  skippedCount,
  totalCandidates,
  readyCount,
  readyFromManifestCount,
  invalidCount,
  manifestFragmentCount,
  sourceFileCount,
  batch?: RecoveryBatchMeta,
  errors?: string[],
  executionMode,
  executionStatus
}
```

注意：

- 不做 token 预估首版可接受。恢复任务只需要从未完成分片继续，manifest 中没有现成的完整费用估算契约。
- 如果未来要展示成本，可在 draft 或 manifest 中增加 remaining source token 估算，但不放在首版 Agent 接入。

## System Prompt 更新

在 `buildSystemPrompt()` 的 capabilities 中新增：

```text
5. Subtitle Translation Recovery: Scan FusionKit recovery manifests (*.fusionkit.resume.json) and resume unfinished subtitle translation tasks.
```

新增操作区分规则：

```text
- "恢复字幕翻译" / "续跑字幕翻译" / "继续上次失败的翻译" / "resume subtitle translation" / "*.fusionkit.resume.json" = RECOVERY, use scan_subtitle_recovery_tasks then queue_recovered_subtitle_translate.
- Do NOT use scan_subtitle_files for *.fusionkit.resume.json.
- Do NOT pass *.fusionkit.resume.json to queue_subtitle_translate.
```

新增恢复 workflow：

```text
## Workflow for Subtitle Recovery Requests
1. If the user gives a directory, call scan_subtitle_recovery_tasks with roots=[directory].
2. If the user gives one or more *.fusionkit.resume.json files, call scan_subtitle_recovery_tasks with checkpointPaths.
3. If the user asks to scan previous/current output without a path, call scan_subtitle_recovery_tasks with useCurrentOutputDir=true. If the tool reports no current output dir, ask for a directory.
4. If no recoverable candidates are found, summarize the scan result and do not queue.
5. Queue recoverable candidates with queue_recovered_subtitle_translate. For large scans, use recoveryScanId + batchStart + batchSize and continue while batch.hasMore=true.
6. ready_from_manifest candidates are allowed; tell the user they will continue from original fragments stored in the recovery manifest because the source file is missing or changed.
7. Follow current execution mode exactly based on tool result.
```

## Intent 辅助

现有 `src/agent/name-translation-intent.ts` 只区分名称翻译和字幕内容翻译，建议扩展或新增 `subtitle-recovery-intent.ts`：

```ts
export type AgentOperationIntent =
  | "name_translation"
  | "subtitle_translation"
  | "subtitle_recovery"
  | "unknown";
```

匹配词：

```text
恢复、续跑、继续上次、继续失败、中断、resume、recovery、checkpoint、resume.json、fusionkit.resume.json
```

测试重点：

- “恢复字幕翻译任务” -> `subtitle_recovery`
- “继续上次失败的字幕翻译” -> `subtitle_recovery`
- “翻译 resume.json 文件内容” 不应误入恢复，除非出现 FusionKit 恢复语义；这种表达应追问。

这个 intent helper 主要用于测试和后续规则化，不要求 orchestrator 直接调用。

## 执行模式衔接

恢复任务入队后属于 translate store：

- `queue_only`：只加入翻译队列。
- `ask_before_execute`：写入 `pendingExecution.stores=["translate"]`，等待用户点击确认。
- `auto_execute`：调用 `executeTasksInStores(["translate"])`，即 `useSubtitleTranslatorStore.startAllTasks()`。

`handlePostQueue("translate", addedCount, result)` 可以直接复用，不需要新增 TaskStoreType。

## 可观测性

建议扩展 `AgentLogEntryType`：

```ts
| "subtitle_recovery_scan"
| "subtitle_recovery_queue"
```

日志摘要：

- scan：扫描根目录、候选总数、可恢复数、跳过数、是否 truncated。
- queue：加入队列数、重复跳过数、`ready_from_manifest` 数量、batch 信息。

不记录字幕正文、译文正文、API key。

## 测试策略

### Schema 测试

更新 `src/agent/tool-schemas.test.ts`：

1. `scanSubtitleRecoveryTasksSchema` 支持 `useCurrentOutputDir=true`。
2. 支持 `roots` 和 `checkpointPaths`。
3. `queueRecoveredSubtitleTranslateSchema` 默认 `recoverability="both"`。
4. queue schema 不接受语言、分片策略和 outputDir。

### Batch 测试

新增或扩展：

```text
src/agent/recovery-batch.test.ts
```

覆盖：

1. scan payload 只返回有界 preview。
2. `recoveryScanId` 能按 batch 解析候选。
3. `recoverability` 过滤 ready / ready_from_manifest / both。
4. stale recoveryScanId 返回明确错误。

### Executor 测试

建议新增：

```text
src/agent/subtitle-recovery-executor.test.ts
```

覆盖：

1. 当前输出目录为空且未提供 roots 时返回错误。
2. scan 调用 recovery service 并返回 `recoveryScanId`。
3. queue ready 候选时使用 `source_file`。
4. queue ready_from_manifest 候选时使用 `manifest_fragments`。
5. task model 缺失时返回“未配置任务执行模型”。
6. queue 成功后调用 `handlePostQueue` 等价行为，返回正确 executionStatus。

### Prompt / Intent 回归

新增测试或手工脚本覆盖：

1. “恢复之前失败的字幕翻译任务”不会调用 `scan_subtitle_files`。
2. `*.fusionkit.resume.json` 不会传给 `queue_subtitle_translate`。
3. 大批量 recovery scan 会继续 queue batches。
4. `ready_from_manifest` 会在最终回复里说明来源。

验证命令：

```bash
pnpm test -- src/agent
pnpm build
```

## 实施步骤

### 第一步：新增 recovery batch 缓存

新增 `src/agent/recovery-batch.ts` 和测试。

交付：

- 完整候选保存在内存。
- 返回有界 preview。
- 支持 batch 解析和 recoverability 过滤。

### 第二步：新增工具 schema 和注册

修改：

- `src/agent/tool-schemas.ts`
- `src/agent/tools.ts`

交付：

- 注册 `scan_subtitle_recovery_tasks`。
- 注册 `queue_recovered_subtitle_translate`。
- 导出对应 args 类型。

### 第三步：新增 executor

修改 `src/agent/tool-executor.ts`：

- 导入 `translatorRecoveryService`。
- 实现 `executeScanSubtitleRecoveryTasks`。
- 实现 `executeQueueRecoveredSubtitleTranslate`。
- 复用 `handlePostQueue("translate")`。

### 第四步：更新 prompt 和 intent 测试

修改 `src/agent/orchestrator.ts`：

- capabilities 增加恢复能力。
- operation split 增加 recovery。
- workflow 增加 Subtitle Recovery。
- 明确禁止把 resume json 当普通字幕翻译。

可新增 `src/agent/subtitle-recovery-intent.ts` 和测试。

### 第五步：日志与回归

修改：

- `src/agent/types.ts`
- `src/pages/HomeAgent/SessionLogViewer.tsx` 如需展示更友好的日志标签。

执行：

```bash
pnpm test -- src/agent
pnpm build
```

## 验收标准

1. 用户说“恢复之前失败的字幕翻译任务”时，Agent 使用 recovery 工具链。
2. 用户提供目录时，Agent 能扫描 `*.fusionkit.resume.json` 并返回候选摘要。
3. 用户提供单个 resume json 路径时，Agent 能 inspect 并加入队列。
4. Agent 不会把 `*.fusionkit.resume.json` 传给 `queue_subtitle_translate`。
5. 可恢复候选能加入字幕翻译队列，并保留原 progress / resolvedFragments。
6. `ready_from_manifest` 候选能以 `manifest_fragments` 模式恢复。
7. 大批量候选能通过 `recoveryScanId` 分批加入队列。
8. 三种执行模式下返回的 executionStatus 准确。
9. 未配置 task model 时不会入队，并返回明确错误。
10. `pnpm test -- src/agent` 和 `pnpm build` 通过。

## 风险与注意事项

1. `candidate.id` 可能来自 manifest.taskId，不保证跨文件唯一；内部选择应优先使用 `checkpointPath` 去重。
2. Agent 工具结果不能暴露 manifest 中的 `sourceContent` / `translatedContent`，避免把用户字幕正文塞进对话上下文。
3. `ready_from_manifest` 是合理续跑路径，但最终回复必须透明说明源文件缺失或变化。
4. 恢复任务不应允许 Agent 改语言、分片策略和输出目录，否则会破坏 checkpoint 校验。
5. 恢复扫描与普通字幕扫描的 scanId 不可混用，建议命名为 `recoveryScanId`。

