# 字幕翻译任务失败恢复与续跑设计

日期：2026-04-29

## 背景

字幕翻译目前支持任务队列、任务失败、手动重试和分片级请求重试，但“任务级失败”后的恢复能力不足：

- 单片请求失败会在 `BaseTranslator.translateFragment()` 内重试，达到上限后整项任务失败。
- `retryTask()` 只是把失败任务从 failed 队列移回 not started，并把进度重置为 0。
- 主进程只在全部分片翻译成功后一次性写最终文件。
- 已翻译成功的分片只保存在内存数组里，任务失败后不会落盘。
- 并发分片模式下，任意分片失败会导致整项任务失败，已经成功的其它分片也无法复用。

用户视角的问题是：一个大字幕文件翻译到中后段失败后，只能从头重新翻译，既浪费时间，也浪费 token；失败时也拿不到“已完成部分”和“未完成部分”的独立文件，后续人工处理或继续处理都不方便。

本文只做开发设计，不开始实现。

## 当前链路

关键路径：

- Renderer 入队：`src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- Renderer 队列状态机：`src/services/subtitle/translatorQueueService.ts`
- Renderer store facade：`src/store/tools/subtitle/useSubtitleTranslatorStore.ts`
- IPC 适配：`src/services/subtitle/translatorExecutionService.ts`
- IPC 注册：`electron/main/translation/ipc.ts`
- 主进程入口：`electron/main/translation/translation-service.ts`
- 翻译模板方法：`electron/main/translation/class/base-translator.ts`
- 格式策略：`electron/main/translation/class/lrc-translator.ts`、`electron/main/translation/class/srt-translator.ts`

当前 `BaseTranslator.translate()` 的核心流程是：

1. 根据任务配置拆分 `fragments`。
2. 顺序或并发调用 `translateFragment()`。
3. 所有分片成功后拼接 `translatedFragments.join("\n\n")`。
4. 调用 `writeFile()` 写最终输出。
5. 推送 `task-resolved`。
6. 任意异常进入 catch，推送 `task-failed`。

缺口在第 2 到第 4 步之间：成功分片没有持久化，失败任务没有可恢复的分片状态。

## 目标

本次能力建设的目标：

1. 任务失败后，支持从已完成分片后继续重试，不需要从头翻译。
2. 失败或取消时，输出已完成内容文件和未完成原文文件。
3. 使用独立的续跑清单文件记录分片状态，后续可校验并恢复。
4. 兼容 LRC 和 SRT，兼容顺序与并发分片模式。
5. 不把 API key、请求 header 等敏感信息写入续跑文件。
6. 最终输出文件仍只在所有分片成功后生成，避免用户误以为部分文件是完整结果。

## 非目标

首轮不建议做这些事情：

- 不做分片级 UI 编辑器。
- 不做单个分片手动选择重翻。
- 不改变 LRC/SRT 分片算法。
- 不把 converter/extractor 一起纳入恢复机制。
- 不在首轮解决 renderer 队列持久化。跨应用重启续跑通过续跑清单文件导入或自动发现来扩展。

## 设计总览

新增“翻译检查点”机制：

```text
开始任务
  ├─ 拆分 fragments
  ├─ 创建或加载 checkpoint manifest
  ├─ 跳过 checkpoint 中已成功的分片
  ├─ 只翻译 missing / failed 分片
  ├─ 每个分片成功后写入 checkpoint
  ├─ 同步刷新 completed / remaining 临时文件
  ├─ 全部分片完成后合并最终文件
  └─ 成功后清理或标记临时产物
```

核心原则：

- `checkpoint manifest` 是恢复依据。
- `completed` 文件是给用户查看或人工利用的已完成译文。
- `remaining` 文件是给用户查看或另行处理的未完成原文。
- 最终输出仍由 manifest 中全部分片译文按原顺序合并生成。

## 续跑文件

以源文件 `movie.srt` 为例，建议在输出目录生成：

```text
movie.fusionkit.resume.json       # 续跑清单，机器读取
movie.fusionkit.completed.srt     # 已完成译文分片，用户可读
movie.fusionkit.remaining.srt     # 未完成原文分片，用户可读
movie.fusionkit.error.log         # 可选，失败日志快照
```

LRC 使用 `.lrc` 后缀：

```text
song.fusionkit.completed.lrc
song.fusionkit.remaining.lrc
```

命名规则：

- 使用原始文件名的 `name` 部分加固定后缀。
- 临时/续跑文件不占用最终输出名。
- `completed` 和 `remaining` 只在失败、取消或进行中需要展示时保留。
- 最终成功后默认删除 `remaining`；`completed` 可删除，也可通过后续设置保留。

## Checkpoint Manifest 结构

建议新增 schema version，避免后续升级无法识别旧文件：

```ts
type TranslationCheckpointManifest = {
  schemaVersion: 1;
  taskId: string;
  status: "running" | "failed" | "cancelled" | "completed";
  createdAt: string;
  updatedAt: string;

  fileName: string;
  sourceFilePath?: string;
  sourceContentHash: string;
  sourceSize?: number;
  sourceMtimeMs?: number;

  outputDir: string;
  finalOutputPath?: string;
  completedOutputPath: string;
  remainingOutputPath: string;
  errorLogPath?: string;

  options: {
    fileType: "LRC" | "SRT";
    sliceType: "NORMAL" | "SENSITIVE" | "CUSTOM";
    customSliceLength?: number;
    sourceLang: string;
    targetLang: string;
    translationOutputMode: "bilingual" | "target_only";
  };

  fragments: Array<{
    index: number;
    sourceHash: string;
    sourceContent: string;
    translatedContent?: string;
    status: "pending" | "running" | "resolved" | "failed";
    attempts: number;
    error?: string;
    startedAt?: string;
    completedAt?: string;
    model?: string;
  }>;
};
```

注意：

- 不写入 `apiKey`。
- `apiModel` 可以记录到单个 fragment，方便排查不同模型混用；续跑时允许用户更换模型。
- 必须记录 `sourceContentHash` 和每个 `sourceHash`，用于判断 checkpoint 是否还能用于当前任务。
- `sourceContent` 会包含字幕原文，`translatedContent` 会包含译文，因此 manifest 本身也是用户数据文件。

## 恢复校验

续跑前必须校验：

1. `schemaVersion` 支持。
2. 当前源文件内容 hash 与 `sourceContentHash` 一致。
3. 当前分片算法重新拆出的 fragment 数量与 manifest 一致。
4. 每个 fragment 的 `sourceHash` 与 manifest 一致。
5. `sourceLang`、`targetLang`、`translationOutputMode` 一致。
6. `sliceType` 和 `customSliceLength` 一致。

允许变化：

- `apiKey`
- `apiModel`
- `endPoint`
- `concurrentSlices`
- `conflictPolicy`

如果校验失败：

- 不复用 checkpoint。
- UI 应提示“续跑文件与当前任务不匹配”。
- 用户可以选择“重新开始”，创建新的 checkpoint。

## 翻译执行流程

### 首次执行

1. 主进程收到 `translate-subtitle`。
2. `BaseTranslator` 拆分 fragments。
3. 创建 manifest，所有分片初始为 `pending`。
4. 生成 `completedOutputPath`、`remainingOutputPath`。
5. 写入初始 manifest 和 remaining 文件。
6. 开始翻译分片。
7. 每个分片成功后：
   - 写入 `translatedContent`。
   - 状态改为 `resolved`。
   - 原子更新 manifest。
   - 刷新 completed 和 remaining 文件。
   - 推送 `update-progress`。
8. 任意分片最终失败：
   - 状态改为 `failed`。
   - flush manifest / completed / remaining / error log。
   - 推送 `task-failed`，携带恢复文件路径。

### 继续重试

1. Renderer 对失败任务调用 `retryTask(fileName, { mode: "resume" })`。
2. 任务带上 `recovery.checkpointPath` 再次进入执行。
3. 主进程加载并校验 manifest。
4. `resolved` 分片直接复用，不再请求模型。
5. 只翻译 `pending` / `failed` / 缺少 `translatedContent` 的分片。
6. 新成功的分片继续写回 manifest。
7. 全部分片 `resolved` 后合并最终文件。

### 重新开始

用户需要明确选择“重新开始”：

1. 忽略旧 checkpoint。
2. 重新创建 manifest。
3. 所有分片从 `pending` 开始。
4. 旧的续跑文件可以保留为 `.bak` 或由用户确认删除。

## 并发模式处理

并发模式下需要额外注意：

- `results` 不能再只存在内存数组里，要以 fragment index 写入 manifest。
- 多个 worker 同时完成时，checkpoint 写入必须串行化。
- 推荐新增 `CheckpointWriter`，内部维护一个 promise 队列，保证写文件顺序。
- `completedCount` 应按 manifest 中 `resolved` 分片数量计算，而不是只按本次执行成功数量计算。
- 失败后已经完成的其它并发请求仍要 flush 到 manifest。

并发失败时，不要求首轮主动取消已经发出的 axios 请求，但建议把 `AbortSignal` 传入 axios config 作为后续优化，减少失败后的额外 token 消耗。

## 输出合并

最终输出必须只从 manifest 合并：

```text
manifest.fragments
  .sort(index)
  .map(translatedContent)
  .join("\n\n")
```

如果任意分片不是 `resolved` 或缺少 `translatedContent`：

- 不写最终文件。
- 保持任务 failed。
- 更新 remaining 文件。

写最终文件建议改为原子写：

```text
movie.srt.fusionkit.tmp -> movie.srt
```

这样可以避免写入过程中进程退出导致最终文件半成品。

## Renderer 任务模型

建议扩展 `SubtitleTranslatorTask`：

```ts
type SubtitleTranslationRecovery = {
  checkpointPath?: string;
  completedOutputPath?: string;
  remainingOutputPath?: string;
  errorLogPath?: string;
  resumable?: boolean;
  failedFragmentIndexes?: number[];
  resolvedFragments?: number;
  totalFragments?: number;
};

type SubtitleTranslatorTask = {
  // existing fields...
  recovery?: SubtitleTranslationRecovery;
};
```

`task-failed` payload 扩展：

```ts
{
  fileName: string;
  error: string;
  message: string;
  errorLogs: string[];
  recovery?: SubtitleTranslationRecovery;
}
```

`update-progress` payload 可选扩展：

```ts
{
  fileName: string;
  resolvedFragments: number;
  totalFragments: number;
  progress: number;
  recovery?: Pick<
    SubtitleTranslationRecovery,
    "checkpointPath" | "completedOutputPath" | "remainingOutputPath"
  >;
}
```

这样 UI 在任务未失败但已经生成临时文件时，也能展示路径。

## Store 与队列设计

`translatorQueueService.ts` 建议新增或调整：

- `retryTask(state, fileName, options)`：
  - `mode: "resume"` 默认保留 `recovery` 和已有 `resolvedFragments`。
  - `mode: "restart"` 清理 `recovery`，进度重置为 0。
- `failTask()`：
  - 写入 `task.recovery`。
  - 保留 `resolvedFragments`、`totalFragments`、`progress`。
- `completeTaskProgress()`：
  - 支持 progress 中携带 recovery 路径并 patch 到 pending task。
- `resolveTask()`：
  - 成功后可清理或保留 recovery 摘要。

UI 行为建议：

- 失败任务主按钮改成“继续重试”。
- 失败任务增加二级操作“重新开始”。
- 展开详情中展示：
  - 续跑清单路径
  - 已完成文件路径
  - 未完成文件路径
  - 失败分片序号
- 删除任务默认只删除队列项，不删除续跑文件；如要删除文件，需要单独确认。

## IPC 设计

可复用现有 `translate-subtitle`，只扩展 task 参数：

```ts
type TranslationRecoveryMode = "auto" | "resume" | "restart";

type SubtitleTranslatorTask = {
  // existing fields...
  recoveryMode?: TranslationRecoveryMode;
  checkpointPath?: string;
};
```

主进程行为：

- `auto`：如果 task 上有可用 checkpoint，则续跑；否则首次执行。
- `resume`：必须加载 checkpoint，失败则返回不可续跑错误。
- `restart`：忽略 checkpoint，重新创建。

也可以新增只读 IPC：

- `inspect-translation-checkpoint`：读取 manifest 摘要，用于 UI 导入或自动发现。
- `cleanup-translation-checkpoint`：用户确认后删除 checkpoint 和临时文件。

首轮可以不做导入 UI，只保证失败任务在当前队列中能继续重试。

## 主进程新增模块

建议新增：

```text
electron/main/translation/checkpoint.ts
electron/main/translation/recovery-artifacts.ts
```

`checkpoint.ts` 职责：

- 创建 manifest。
- 加载 manifest。
- 校验 manifest。
- 原子写 JSON。
- 根据 manifest 计算 progress。

`recovery-artifacts.ts` 职责：

- 生成 completed 内容。
- 生成 remaining 内容。
- 写 completed / remaining / error log。
- 处理 LRC/SRT 文件后缀。

`BaseTranslator` 负责接入：

- 拆分后创建或加载 checkpoint。
- 翻译前计算待翻译 indexes。
- 分片成功后更新 checkpoint。
- 失败时 flush recovery artifacts。
- 完成后合并最终文件。

## 与现有重试机制的关系

已有 `translateFragment()` 内的 `maxRetries` 保留，职责不变：

- 它解决单个请求的瞬时失败。
- checkpoint 解决任务失败后的跨任务恢复。

两层关系：

```text
fragment request retry:  单片请求内部最多重试 N 次
task resume retry:       单片最终失败后，下一次任务只重试失败/未完成分片
```

这两层不要合并，否则会让失败恢复逻辑过度耦合到 HTTP 请求细节。

## 风险与取舍

### 1. Manifest 会包含字幕内容

这是续跑能力的必要代价。必须明确：

- 不写 API key。
- 文件保存在用户选择的输出目录。
- UI 提供路径展示和后续清理能力。

### 2. 并发写 checkpoint 可能产生竞态

用串行 writer 和原子 rename 规避。不要让多个分片直接并行 `writeFile(manifestPath)`。

### 3. 用户修改翻译配置后不能盲目续跑

语言、输出模式、分片策略改变后，旧译文和新任务不再一致，应强制重新开始。

### 4. 当前任务队列不持久化

应用重启后 UI 队列会丢失。首轮目标是“当前失败任务继续重试”。如果要支持隔天续跑，需要第二阶段做 checkpoint 导入或自动发现。

### 5. 输出目录冲突策略

当前最终文件名在写入时才根据 `conflictPolicy` 决定。续跑设计建议任务开始时就记录 `finalOutputPath`，保证多次续跑目标稳定。若最终写入时路径已被外部占用，再按冲突策略生成新路径并更新 manifest。

## 分阶段实施建议

### 阶段 1：当前队列内续跑

范围：

- 新增 checkpoint 和 artifact 写入。
- 扩展 `task-failed` payload。
- failed task 保留 recovery 信息。
- “继续重试”只翻译未完成分片。

验收：

- 大字幕翻译到一半失败后，输出 completed / remaining / resume.json。
- 点击继续重试后，只请求未完成分片。
- 成功后最终文件顺序正确。

### 阶段 2：UI 完善与清理

范围：

- 失败任务展示续跑文件路径。
- 增加“重新开始”。
- 增加“打开已完成文件”“打开未完成文件”。
- 增加“清理续跑文件”确认操作。

验收：

- 用户可以直接打开三个恢复产物。
- 删除任务不会误删恢复产物。
- 清理恢复产物需要明确确认。

### 阶段 3：跨重启续跑

范围：

- 支持导入 `*.fusionkit.resume.json`。
- 或添加源文件时自动扫描输出目录中的匹配 checkpoint。
- 校验通过后构建 failed/not started task。

验收：

- 应用重启后，用户仍可从 checkpoint 继续。
- checkpoint 不匹配时给出明确错误。

## 测试计划

单元测试：

- `checkpoint.ts`
  - 创建 manifest。
  - 原子写入和加载。
  - hash 不匹配时拒绝续跑。
  - 不写入 API key。
- `recovery-artifacts.ts`
  - completed 只包含已完成译文。
  - remaining 只包含未完成原文。
  - LRC/SRT 后缀正确。
- `BaseTranslator`
  - 第 2 个分片失败后写出恢复产物。
  - resume 时不再请求第 1 个已完成分片。
  - 并发模式下最终合并顺序稳定。
  - 取消任务后仍能保留 checkpoint。
- `translatorQueueService`
  - failed task 保留 recovery。
  - resume retry 不清空 progress。
  - restart retry 清空 recovery 和 progress。

手工回归：

1. 使用敏感模式翻译一个多分片 LRC，mock 或临时制造中间分片失败。
2. 确认输出目录生成 `resume.json`、`completed.lrc`、`remaining.lrc`。
3. 点击继续重试，确认只处理未完成分片。
4. 成功后最终 LRC 内容完整且顺序正确。
5. 同样流程验证 SRT。
6. 验证并发分片开启时，completed 文件不会乱序。
7. 验证更改源语言或输出模式后，旧 checkpoint 不被复用。

建议命令：

```bash
pnpm exec vitest run test/translation/base-translator.test.ts src/services/subtitle/translatorQueueService.test.ts
pnpm exec tsc --noEmit
```

如新增 checkpoint 独立测试，可再加：

```bash
pnpm exec vitest run test/translation/checkpoint.test.ts
```

## 建议改动文件清单

首轮预计涉及：

- `electron/main/translation/checkpoint.ts`
- `electron/main/translation/recovery-artifacts.ts`
- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/typing.ts`
- `src/type/subtitle.ts`
- `src/renderer/subtitle.ts`
- `src/services/subtitle/translatorQueueService.ts`
- `src/store/tools/subtitle/useSubtitleTranslatorStore.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/locales/zh/subtitle.json`
- `src/locales/en/subtitle.json`
- `src/locales/ja/subtitle.json`
- `test/translation/checkpoint.test.ts`
- `test/translation/base-translator.test.ts`
- `src/services/subtitle/translatorQueueService.test.ts`

## 结论

推荐把失败恢复设计成“分片级 checkpoint + 用户可读恢复产物”的机制，而不是只改 `retryTask()`。

这样可以同时解决三个问题：

- 继续重试时复用已完成分片。
- 失败后用户能拿到已完成和未完成内容文件。
- 后续可以自然扩展到应用重启后的导入续跑。

