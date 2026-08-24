# 工作包 FE-003：批量草稿与任务队列 checkpoint

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`FE-003`
- 目标平台/硬件：跨平台 Renderer 与既有 Electron fixed API；本轮不声明 Windows/macOS packaged 产品或真实 GPU 验收通过

## 本次认领边界

- 包含：1～100 文件 draft 与批次 request、revisioned session batch/task 列表、逐 task cancel/retry/CPU retry/remove/reveal、四语言批量语义。
- 不包含：逐文件 media probe 与多音轨 Radio、SRT 内容预览/复制/翻译交接、真实 Electron 窄窗口/键盘与 packaged 目标机验收。

## 本次实现内容

- 将单文件 readiness/request 扩为完整文件数组。request为每个已授权 opaque `fileToken`生成一个条目，并在纯模型边界限制1～100文件；已有active task不再阻止新draft或下一批enqueue。
- `ToolFileDropZone`启用既有`multiple`能力，授权前截断到schema上限；草稿区按文件显示名称/大小并支持逐项移除或清空。替换、移除和离页仍通过既有Store与SPA cleanup retry回收未提交capability；enqueue成功后只清renderer draft，不撤销main已接管lease。
- 新增`LocalSubtitleTaskQueue`，直接消费共享runtime的revisioned `batches`，按batch展示状态与完成数，逐task展示状态、stage/stageProgress/overallProgress、backend、请求格式、媒体时长、committed SRT和结构化错误。
- 接通fixed `cancelTask`、`retryTask`、`retryTaskOnCpu({ taskId, generation })`、`removeTask`与`revealArtifact`。所有动作使用task-scoped pending key；确认式CPU retry继续复用既有`ConfirmDialog`，renderer不接收backend proof、路径或hash。
- enqueue回执只作为session snapshot/event接管前的短期fallback；同batch一旦被runtime观察，fallback即退休，避免terminal task移除后由旧renderer回执复活。
- 四语言将单文件说明、readiness与空态改为批量/队列语义，并为图标动作提供包含文件名的`title`与`aria-label`。

## 修改文件

- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleTaskQueue.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/{localSubtitleTranscriberModel,localSubtitleTranscriberPage}.test.ts`
- `src/locales/{zh,zh-Hant,en,ja}/subtitle.json`
- Final Design、Execution Plan与本实施记录

## 接口、状态或数据结构变化

- 未新增IPC channel、domain schema或持久化字段；继续复用`authorizeInputFiles(File[])`、`enqueue()`和既有逐task fixed API。
- 页面从单个`activeIdentity/submittedBatch`切换为shared runtime `batches`加短期enqueue fallback；主进程session snapshot/event仍是权威状态。
- `deriveLocalSubtitleStartIssue()`改收`selectedFiles[]`并移除`task_active`；`createSingleFileLocalSubtitleRequest()`替换为`createLocalSubtitleBatchRequest()`。

## 安全、隐私与许可证检查

- 路径/capability：Renderer仍只保存opaque file/output token和display metadata，不接收raw path；未提交token沿用bounded cleanup retry，已提交lease不被draft cleanup撤销。
- 日志/持久化：未新增task、token、路径或字幕内容持久化；错误继续消费结构化、脱敏`LocalSubtitleError`。
- 第三方来源与许可：未新增依赖、runtime、模型或资源许可变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber src/store/tools/subtitle src/services/local-subtitle
node_modules/.bin/tsc --noEmit --pretty false
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：Renderer/Store/runtime 9 files / 65 tests；TypeScript；四语言1657 keys完整性与source usage；renderer/main/preload三段Vite test build；diff check。
- Vite仅报告既有dynamic-import与chunk-size warning。
- 未运行及原因：本checkpoint未实现多音轨选择，也不为代码主干已覆盖的队列操作启动Electron做重复人工QA。
- 真实硬件/packaged范围：未运行真实模型、GPU、Windows NSIS或macOS packaged产品，本记录不扩大既有QA结论。
- 本轮未执行`pnpm`，未修改`pnpm-lock.yaml`，未启动Vite/Electron常驻服务。

## Pitfall边界

- `FK-PIT-0010`：替换/移除/离页draft token继续进入renderer级cleanup retry；resolved `{ ok: false }`不会被当作成功。
- `FK-PIT-0037`：队列只消费既有subscribe-before-snapshot service的共享revision状态；短期enqueue fallback在runtime观察后退休，不覆盖snapshot omission/tombstone。
- `FK-PIT-0012`、`FK-PIT-0019`：当前checkpoint复用真实`ToolFileDropZone`和既有CPU确认对话框；后续多音轨必须复用完整交互面的`ToolRadioButtonGroup`，不能用隐藏Radix item加外层label模拟。
- `FK-PIT-0048`：三段Electron build只运行root `vite build --mode=test`。
- `FK-PIT-0002`：本轮未启动前端/Electron服务；结束前仍检查进程表。

## 未完成事项与风险

- 接通`probeMedia(fileToken)`并保存不扩大authority的draft probe摘要；多音轨逐文件选择只能提交main签发的`streamId`，不能输入任意FFmpeg selector。
- 覆盖批量部分授权失败的产品反馈、音轨默认选择说明、窄窗口布局、普通点击/键盘、cancel race和离页返回snapshot产品验收。
- FE-004继续负责内容预览、复制、partial format详情与手动翻译交接入口。

## 下一步建议

- 继续`FE-003`的多音轨probe/Radio独立checkpoint；优先定义draft probe状态与capability替换/移除时的清理关系，再接页面，避免把probe结果误作文件authority。
