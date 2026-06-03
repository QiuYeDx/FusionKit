# 字幕翻译历史任务扫描与恢复设计

日期：2026-06-03

## 背景

字幕翻译已经具备分片级 checkpoint 能力：主进程会在输出目录写入 `*.fusionkit.resume.json`，并配套生成 `*.fusionkit.completed.*`、`*.fusionkit.remaining.*`、`*.fusionkit.error.log` 等恢复产物。当前失败任务在同一应用运行周期内可以通过 `retryTask(fileName, "resume")` 续跑。

新的缺口在“历史任务发现”：

1. `useSubtitleTranslatorStore` 目前只持久化 `outputURL`，不会持久化任务队列。
2. 应用重启、页面刷新或用户清空队列后，renderer 侧丢失失败任务对象。
3. 输出目录中的 `*.fusionkit.resume.json` 仍然保存了分片状态，但没有入口扫描、校验、恢复成可执行任务。
4. 现有 `retryTask()` 依赖 failed 队列中已有任务，不能从磁盘 JSON 反向重建任务。

本文只做开发设计，不开始实现。

## 现有状态

相关文件：

- `electron/main/translation/checkpoint.ts`
  - 已有 `createManifest()`、`loadManifest()`、`validateManifest()`、`buildRecoverySummary()`。
  - manifest 写入使用 `write -> rename` 原子更新。
- `electron/main/translation/recovery-artifacts.ts`
  - 已有 completed / remaining / error log 产物生成和成功清理逻辑。
- `electron/main/translation/class/base-translator.ts`
  - 已支持 `task.checkpointPath` + `task.recoveryMode` 续跑。
  - 当前续跑仍先基于 `task.fileContent` 重新分片，再校验 manifest。
- `electron/main/translation/ipc.ts`
  - 目前只有 `translate-subtitle`、`estimate-subtitle-tokens`、`cancel-translation`。
- `src/services/subtitle/translatorQueueService.ts`
  - 现有 `retryTask()` 可以保留 recovery 信息并设置 `checkpointPath`。
- `src/store/tools/subtitle/useSubtitleTranslatorStore.ts`
  - Zustand facade 暴露队列操作，但 persist 只保存 `outputURL`。
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
  - 任务管理区有开始、重试、删除、打开位置等操作，没有“扫描恢复任务”入口。
- `electron/main/fs/ipc.ts`
  - 已有通用目录扫描能力，但只返回文件元数据，不会解析翻译 checkpoint。

已有恢复产物命名：

```text
movie.fusionkit.resume.json
movie.fusionkit.completed.srt
movie.fusionkit.remaining.srt
movie.fusionkit.error.log
```

## 目标

1. 支持用户选择目录或使用当前输出目录扫描历史字幕翻译恢复产物。
2. 支持识别 `*.fusionkit.resume.json` 并展示可恢复任务列表。
3. 支持从历史 manifest 重建 `SubtitleTranslatorTask`，加入字幕翻译队列，并接着未完成分片继续执行。
4. 支持源文件仍存在、源文件丢失、源文件被改动三类场景的明确状态和可恢复策略。
5. 不扫描全盘，不自动读取任意 JSON；只处理 FusionKit 约定后缀的恢复清单。
6. 不把 API key、请求 header 等敏感信息写入或从 manifest 恢复；恢复任务使用当前配置的任务模型。
7. 保持现有分片 checkpoint 和队列状态机的职责边界，避免把文件系统扫描逻辑放到 React 页面里。

## 非目标

1. 不把普通 `.json` 文件都当作恢复文件解析。
2. 不恢复已成功并被清理掉 manifest 的任务。
3. 不提供分片级手动编辑、选择性重翻或合并编辑器。
4. 不改变 LRC/SRT 分片算法。
5. 不把 converter / extractor 纳入本次恢复扫描。
6. 不做后台自动全局扫描；用户必须明确选择扫描范围。

## 用户可见行为

### 入口

在字幕翻译页任务管理区新增一个次要按钮：

```text
恢复历史任务
```

点击后打开恢复任务弹窗。弹窗提供：

1. 扫描当前输出目录。
2. 选择目录扫描。
3. 导入单个 `*.fusionkit.resume.json`。

默认推荐“扫描当前输出目录”。如果当前 `outputURL` 为空，则只显示“选择目录扫描”和“导入单个文件”。

### 扫描结果

扫描结果以表格或列表呈现：

- 文件名
- manifest 状态：`running` / `failed` / `cancelled` / `completed`
- 已完成分片：`resolvedFragments / totalFragments`
- 语言与输出模式
- 分片策略
- 最近更新时间
- 输出目录
- 源文件状态：存在且一致 / 不存在 / 内容已变化 / 未记录
- 恢复状态：可恢复 / 需确认 / 不可恢复

候选项操作：

- `加入队列`：恢复为 NotStarted 任务，保留已完成进度。
- `立即续跑`：加入队列后直接启动，受现有并发上限约束。
- `打开所在位置`：打开 manifest 或输出目录位置。
- `忽略`：仅从本次弹窗结果中移除，不删除磁盘文件。

### 恢复入队后的任务表现

恢复任务进入 `notStartedTaskQueue`：

- 状态显示为未开始，但保留 `progress`、`resolvedFragments`、`totalFragments`。
- 任务详情显示 checkpoint、completed、remaining、error log 路径。
- 点击开始或开始全部时，继续翻译未完成分片。
- 如果用户要完全重新翻译，仍使用现有 `restart` 模式，但需要明确确认。

### 源文件缺失时的策略

当前 manifest 的每个 fragment 都包含 `sourceContent`，因此设计上不应强制依赖原始源文件仍存在。

推荐恢复策略分两档：

1. `source_file`：源文件存在且 hash 一致。恢复时可以继续走当前“读取源文件 -> 分片 -> 校验 manifest”的路径。
2. `manifest_fragments`：源文件不存在或已变化，但 manifest 自身完整。恢复时以 manifest.fragments 中的 `sourceContent` 作为权威分片继续执行。

UI 需要在第二种场景提示：

```text
源文件不可用或已变化，将使用恢复清单中的原始分片继续翻译。
```

如果 manifest 缺少 fragment sourceContent、fragment hash 无法自校验、schema 不支持或 JSON 损坏，则不可恢复。

## 总体架构

新增一个“恢复发现”链路：

```text
用户选择扫描范围
  -> renderer 调用 IPC
  -> main 递归扫描 *.fusionkit.resume.json
  -> main 安全解析并生成候选摘要
  -> renderer 展示候选项
  -> 用户选择恢复
  -> main 读取 manifest 并生成恢复任务草稿
  -> renderer 注入当前模型配置
  -> 加入队列 / 启动任务
  -> BaseTranslator 从 checkpoint 继续未完成分片
```

新增模块建议：

```text
electron/main/translation/recovery-discovery.ts
src/services/subtitle/translatorRecoveryService.ts
```

修改模块：

```text
electron/main/translation/ipc.ts
electron/main/translation/class/base-translator.ts
electron/main/translation/checkpoint.ts
electron/main/translation/typing.ts
src/type/subtitle.ts
src/services/subtitle/translatorQueueService.ts
src/store/tools/subtitle/useSubtitleTranslatorStore.ts
src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx
src/locales/*/subtitle.json
```

## 主进程设计

### `recovery-discovery.ts`

职责：

1. 扫描用户授权目录内的 `*.fusionkit.resume.json`。
2. 安全解析 manifest，不向 renderer 返回字幕全文和译文全文。
3. 校验 manifest 基础结构和 fragment 自洽性。
4. 读取源文件元数据并判断源文件是否存在、是否与 `sourceContentHash` 一致。
5. 生成恢复候选摘要。
6. 在用户确认恢复时生成任务草稿。

核心函数：

```ts
export async function scanTranslationRecoveryArtifacts(
  request: TranslationRecoveryScanRequest,
): Promise<TranslationRecoveryScanResult>;

export async function inspectTranslationRecoveryArtifact(
  checkpointPath: string,
): Promise<TranslationRecoveryCandidate>;

export async function createRecoveredSubtitleTaskDraft(
  request: TranslationRecoveryImportRequest,
): Promise<RecoveredSubtitleTaskDraft>;
```

扫描限制：

- 默认只扫描用户选择目录。
- 默认递归，最大深度 8。
- 默认最多返回 500 个 manifest。
- 单个 JSON 文件超过 50 MB 时跳过并标记 `too_large`。
- 跳过隐藏目录、`node_modules`、`.git`、系统包目录。
- 不跟随 symlink，避免循环和越界。
- 解析失败只记录摘要错误，不中断整个扫描。

### IPC 契约

新增三个 IPC handle：

```ts
ipcMain.handle(
  "scan-translation-recovery-artifacts",
  async (_, request: TranslationRecoveryScanRequest) => { ... },
);

ipcMain.handle(
  "inspect-translation-recovery-artifact",
  async (_, checkpointPath: string) => { ... },
);

ipcMain.handle(
  "create-recovered-subtitle-task-draft",
  async (_, request: TranslationRecoveryImportRequest) => { ... },
);
```

`scan` 用于列表，`inspect` 用于单个 JSON 导入，`create draft` 用于用户真正点击恢复后读取必要内容。

## 数据结构

### 扫描请求

```ts
export type TranslationRecoveryScanRequest = {
  roots: string[];
  recursive?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  includeCompleted?: boolean;
};
```

### 扫描结果

```ts
export type TranslationRecoveryScanResult = {
  candidates: TranslationRecoveryCandidate[];
  scannedDirs: number;
  scannedFiles: number;
  skippedFiles: number;
  truncated: boolean;
  errors: Array<{
    path: string;
    reason: string;
  }>;
};
```

### 候选摘要

```ts
export type TranslationRecoveryCandidate = {
  id: string;
  checkpointPath: string;
  fileName: string;
  manifestStatus: "running" | "failed" | "cancelled" | "completed";
  createdAt: string;
  updatedAt: string;

  outputDir: string;
  completedOutputPath?: string;
  remainingOutputPath?: string;
  errorLogPath?: string;
  finalOutputPath?: string;

  options: {
    fileType: "LRC" | "SRT";
    sliceType: "NORMAL" | "SENSITIVE" | "CUSTOM";
    customSliceLength?: number;
    sourceLang: string;
    targetLang: string;
    translationOutputMode: "bilingual" | "target_only";
  };

  resolvedFragments: number;
  totalFragments: number;
  failedFragmentIndexes?: number[];
  progress: number;

  sourceFilePath?: string;
  sourceState:
    | "matched"
    | "missing"
    | "changed"
    | "unknown"
    | "not_checked";

  recoverability:
    | "ready"
    | "ready_from_manifest"
    | "completed"
    | "no_pending_fragments"
    | "unsupported_schema"
    | "corrupt_manifest"
    | "invalid_manifest"
    | "too_large";

  blockingReason?: string;
};
```

`ready` 表示源文件存在且一致；`ready_from_manifest` 表示可使用 manifest.fragments 续跑，但源文件不可用或不一致。

### 恢复任务草稿

```ts
export type TranslationRecoveryInputMode =
  | "source_file"
  | "manifest_fragments";

export type RecoveredSubtitleTaskDraft = {
  fileName: string;
  fileContent?: string;
  originFileURL: string;
  targetFileURL: string;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  sourceLang: TranslationLanguage;
  targetLang: TranslationLanguage;
  translationOutputMode: TranslationOutputMode;
  resolvedFragments: number;
  totalFragments: number;
  progress: number;
  recoveryMode: "resume";
  checkpointPath: string;
  recoveryInputMode: TranslationRecoveryInputMode;
  recovery: SubtitleTranslationRecovery;
};
```

renderer 收到 draft 后注入当前模型配置：

```ts
const task: SubtitleTranslatorTask = {
  ...draft,
  status: TaskStatus.NOT_STARTED,
  apiKey: taskProfile.apiKey,
  apiModel: taskProfile.modelKey,
  endPoint: taskProfile.baseUrl,
  conflictPolicy,
  concurrentSlices,
};
```

## Checkpoint 校验规则

扫描阶段的校验分为“结构校验”和“源文件校验”。

结构校验：

1. JSON 必须能解析为对象。
2. `schemaVersion` 必须受支持，首版只支持 `1`。
3. `fileName`、`outputDir`、`options`、`fragments` 必须存在。
4. `fragments` 必须是非空数组，index 连续且唯一。
5. 每个 fragment 必须包含 `sourceContent` 和 `sourceHash`。
6. `hashContent(fragment.sourceContent)` 必须等于 `fragment.sourceHash`。
7. `resolved` fragment 必须有非空 `translatedContent`。
8. `completed` manifest 必须全部 fragment resolved。

源文件校验：

1. 如果 `sourceFilePath` 存在且可读取，计算源文件 hash。
2. hash 与 `sourceContentHash` 一致时，候选为 `ready`。
3. 源文件不存在或 hash 不一致，但结构校验通过时，候选为 `ready_from_manifest`。
4. 源文件不一致不应静默覆盖 manifest，也不应使用当前源文件重新分片。

运行中任务处理：

- `manifest.status === "running"` 但不在当前 activeTasks 中时，视为上次异常中断，可恢复。
- 如果后续要检测当前进程内活跃任务，需要 `TranslationService` 提供 `isTaskActive(fileName)` 或按 checkpointPath 追踪 active task，避免同一 manifest 被重复启动。

## 执行层改造

当前 `BaseTranslator.translate()` 一定先基于 `task.fileContent` 拆分，再加载 checkpoint。为了支持 `ready_from_manifest`，需要抽出 fragment 解析流程。

建议新增：

```ts
type ResolvedRecoveryContext = {
  manifest?: TranslationCheckpointManifest;
  manifestPath?: string;
  fragments: string[];
  inputMode: "fresh" | "source_file" | "manifest_fragments";
};
```

流程调整：

1. 如果没有 `task.checkpointPath`，保持现有首次执行流程。
2. 如果 `task.checkpointPath` 存在且 `task.recoveryInputMode === "source_file"`：
   - 读取 `task.fileContent`。
   - 用现有分片算法生成 fragments。
   - 调用现有 `validateManifest()`。
3. 如果 `task.checkpointPath` 存在且 `task.recoveryInputMode === "manifest_fragments"`：
   - 先 `loadManifest(task.checkpointPath)`。
   - 调用新增 `validateManifestSelfContained()`。
   - 直接使用 `manifest.fragments.map(f => f.sourceContent)` 作为 fragments。
   - 不再要求 `task.fileContent` 与 `sourceContentHash` 一致。
4. 后续顺序/并发翻译、checkpoint 写入、最终合并逻辑保持不变。

新增校验函数：

```ts
export function validateManifestSelfContained(
  manifest: TranslationCheckpointManifest,
): ValidationResult;
```

它只验证 manifest 自身结构和 fragment hash，不依赖当前源文件。

## Renderer 设计

### `translatorRecoveryService.ts`

集中管理恢复相关 IPC：

```ts
export function scanTranslationRecoveryArtifacts(
  request: TranslationRecoveryScanRequest,
) {
  return window.ipcRenderer.invoke("scan-translation-recovery-artifacts", request);
}

export function inspectTranslationRecoveryArtifact(checkpointPath: string) {
  return window.ipcRenderer.invoke("inspect-translation-recovery-artifact", checkpointPath);
}

export function createRecoveredSubtitleTaskDraft(
  request: TranslationRecoveryImportRequest,
) {
  return window.ipcRenderer.invoke("create-recovered-subtitle-task-draft", request);
}
```

页面和 store 不直接写 IPC channel 字符串。

### Store 增量 API

`useSubtitleTranslatorStore` 新增：

```ts
addRecoveredTask(task: SubtitleTranslatorTask): {
  added: boolean;
  reason?: "duplicate_file" | "duplicate_checkpoint";
};

addRecoveredTasks(tasks: SubtitleTranslatorTask[]): {
  addedCount: number;
  skippedCount: number;
};
```

去重规则：

1. 当前所有队列中已有相同 `checkpointPath`，跳过。
2. 当前所有队列中已有相同 `originFileURL + targetFileURL + fileName`，跳过。
3. 仅 `fileName` 相同但 checkpoint 不同，允许恢复，但 UI 需要显示路径以避免误解。

现有 `addTask()` 只按 `fileName` 去重，不足以支持同名不同目录的历史恢复任务，因此恢复入口不要直接复用旧去重规则，或者需要扩展 `addTask()` 的比较键。

### 页面交互

新增组件建议：

```text
src/pages/Tools/Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx
```

状态：

- idle：未扫描。
- scanning：扫描中，显示目录和进度摘要。
- ready：展示候选项。
- importing：用户选择候选项并生成任务草稿。
- error：扫描失败或导入失败。

按钮策略：

- `ready`：显示“加入队列”。
- `ready_from_manifest`：显示“使用恢复清单加入队列”，并在确认区域说明源文件状态。
- `completed` / `no_pending_fragments`：默认禁用加入队列，可打开位置。
- `invalid_manifest` / `corrupt_manifest` / `unsupported_schema`：禁用加入队列，显示原因。

## i18n 文案

需要补充 `src/locales/zh/subtitle.json`、`en/subtitle.json`、`ja/subtitle.json`：

- `translator.recovery.title`
- `translator.recovery.scan_current_output`
- `translator.recovery.select_directory`
- `translator.recovery.import_manifest`
- `translator.recovery.add_to_queue`
- `translator.recovery.add_and_start`
- `translator.recovery.ready`
- `translator.recovery.ready_from_manifest`
- `translator.recovery.source_missing`
- `translator.recovery.source_changed`
- `translator.recovery.invalid_manifest`
- `translator.recovery.no_candidates`
- `translator.recovery.scan_truncated`
- `translator.recovery.duplicate_skipped`

## 错误处理

扫描错误不应中断整批扫描：

- 某个目录无权限：记录到 `errors`，继续其它目录。
- 某个 JSON 损坏：生成不可恢复候选或记录 skip reason。
- 文件过大：跳过并标记 `too_large`。
- manifest schema 不支持：展示不可恢复，不自动删除。
- 用户恢复时模型配置缺失：renderer 阻止加入队列，并提示去设置页配置任务模型。

执行时错误沿用现有 `task-failed`：

- 如果 checkpoint 在恢复后被删除，任务失败并提示 checkpoint 不存在。
- 如果 manifest 在恢复后被外部修改且校验失败，任务失败并保留 error log。
- 如果并发续跑部分分片成功，继续刷新 manifest 和 completed / remaining 文件。

## 性能与安全

1. 扫描只返回摘要，不返回 `sourceContent` 或 `translatedContent`。
2. 真正恢复单个任务时才读取 manifest 全量内容。
3. 不在日志中打印字幕正文、译文正文、API key。
4. 扫描范围必须来自用户选择或当前已配置输出目录。
5. 限制最大深度、最大文件数、最大 JSON 文件体积。
6. 不跟随 symlink。
7. 对路径只做展示和读取，不执行删除、移动、覆盖。

## 兼容性

1. `schemaVersion: 1` 的现有 manifest 可直接纳入扫描。
2. 已成功任务默认调用 `cleanupOnSuccess()` 删除 manifest，因此通常不会出现在恢复列表；若用户未来配置保留 manifest，扫描默认隐藏 `completed`，可通过 `includeCompleted` 显示。
3. `completed` / `remaining` / `error.log` 缺失不影响续跑，机器恢复只依赖 manifest。
4. 如果旧 manifest 缺少 `sourceContent`，只能在源文件存在且 hash 一致时走 `source_file` 恢复；否则不可恢复。

## 实施步骤

### 第一步：主进程恢复发现模块

新增 `electron/main/translation/recovery-discovery.ts`：

- 扫描 `*.fusionkit.resume.json`。
- 安全解析 manifest。
- 生成 `TranslationRecoveryCandidate`。
- 支持 `inspect` 和 `createRecoveredSubtitleTaskDraft`。

同步扩展 `electron/main/translation/ipc.ts` 注册新 IPC。

### 第二步：checkpoint 自校验与 manifest fragments 执行模式

扩展 `electron/main/translation/checkpoint.ts`：

- 新增 `validateManifestSelfContained()`。
- 新增 `getManifestFragments()` 或等价 helper。

扩展 `SubtitleTranslatorTask`：

- `recoveryInputMode?: "source_file" | "manifest_fragments"`。

调整 `BaseTranslator.translate()` 的 checkpoint 加载顺序，使 `manifest_fragments` 模式不依赖源文件重新分片。

### 第三步：renderer 恢复 service 和 store API

新增 `src/services/subtitle/translatorRecoveryService.ts`。

扩展 `useSubtitleTranslatorStore`：

- `addRecoveredTask`
- `addRecoveredTasks`

补队列 service 测试，覆盖 checkpointPath 去重。

### 第四步：恢复任务弹窗 UI

新增 `RecoveryDialog` 并接入字幕翻译页任务管理区。

最低交互：

- 选择扫描目录。
- 展示候选项。
- 加入队列。
- 加入并启动。
- 展示不可恢复原因。

### 第五步：测试与回归

建议新增测试：

```text
test/translation/recovery-discovery.test.ts
test/translation/checkpoint-self-contained.test.ts
src/services/subtitle/translatorQueueService.test.ts
```

验证命令：

```bash
pnpm test
pnpm build
```

手工回归：

1. 翻译大 SRT，手动取消或制造失败，确认输出 `*.fusionkit.resume.json`。
2. 重启应用，打开字幕翻译页，扫描输出目录。
3. 选择候选项加入队列，确认进度不是 0。
4. 点击开始，确认只请求未完成分片。
5. 删除或移动源文件，再扫描并使用 `ready_from_manifest` 恢复。
6. 修改源文件内容，再扫描，确认提示源文件变化并使用 manifest fragments。
7. 损坏 JSON，确认扫描不崩溃且提示不可恢复。
8. 多个同名字幕来自不同目录，确认不会错误去重。

## 验收标准

1. 用户能从历史输出目录扫描到 `*.fusionkit.resume.json`。
2. 可恢复候选能重建为字幕翻译任务并加入队列。
3. 恢复任务启动后跳过已 resolved 分片，只翻译未完成分片。
4. 源文件缺失或变化时，只要 manifest 自身完整，仍可用 `manifest_fragments` 续跑。
5. 损坏、过大、不支持 schema 的 JSON 不会导致扫描失败。
6. API key 不写入 manifest，也不从 manifest 恢复；恢复任务使用当前任务模型配置。
7. 现有失败任务同运行周期内的 `retryTask(fileName, "resume")` 行为不回退。
8. `pnpm test` 和 `pnpm build` 通过。

## 风险与注意事项

1. `manifest_fragments` 模式会把 manifest 中保存的分片作为权威原文，因此必须严格校验每个 fragment 的 hash。
2. 当前 `addTask()` 按 `fileName` 去重，恢复历史任务时需要扩展去重键，否则同名不同路径任务会被错误跳过。
3. `manifest.status === "running"` 可能来自崩溃中断，也可能是当前进程仍在执行；实现时需要避免重复启动同一 checkpoint。
4. 扫描目录可能很大，必须有深度、数量、体积限制，并在 UI 展示 `truncated`。
5. 成功任务默认清理 manifest，用户不能通过扫描恢复已经清理的任务；这是预期行为，不应误报为丢失。

