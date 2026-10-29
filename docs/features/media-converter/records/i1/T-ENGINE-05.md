# 实施记录：T-ENGINE-05

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENGINE-05 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:c2d906fc4c29918290e68a0c2aa3d33d18fbc21831470145fb220aeba77f42a3（基线 a742ec76 + 未提交工作树）。批次 C 修正的独立评审与修复（2026-10-28）后取得：在最后一次代码修改（`engine/executor.ts`、`executor.test.ts`）与 engine design §11 的修改、全部检查的重跑与证据写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时的文件 sha256 前 12 位：`engine/executor.ts` 7dfb9f0b1a3b，`executor.test.ts` 411a7588fa6e，engine design.md 681c032ce2a4；其余批次 C 修正改过的源文件与下述批次 C 修正时相同（`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c）。评审之前的验证版本与说明：snapshot-sha256:2f201d53b059332cb0e6f9dc79dd3d6616d307b1086a3746b5ff9dd816aea715（基线 a742ec76 + 未提交工作树）。批次 C 修正（2026-10-28）后取得：在最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时批次 C 修正改过的文件 sha256 前 12 位：`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`engine/executor.ts` 7bbc95cfd44d，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c，`queue.test.ts` 3804c62b1a5a，`executor.test.ts` 0961d9822a8e，`ipc.test.ts` 96a24113d1c4，`plan/stream-plan.test.ts` cafa28d8d09e，engine design.md dca0ac38db09，encode design.md 3e39a493f5dd。批次 C 修正之前的验证版本与说明：snapshot-sha256:6ca748a22cbbdb3938c818e0c5bb9e99c5e9ca4ef3c9c4f5f42fabe1cea47d05（基线 a742ec76 + 未提交工作树）。在独立评审的最后一次代码修改、两项验证与变异复跑之后取得；本记录与证据文件的这次更新未计入（之后代码未再改动）。此时各文件 sha256 前 12 位：`queue/queue.ts` 841c932c6dcb，`queue/state-store.ts` cc1eceac1121，`queue/types.ts` f4e2a29a406f（评审未改），`contract.ts` 78a35652ac4a（评审未改），`queue.test.ts` 0c84ad569ddc。实施时的快照为 snapshot-sha256:da109d93…（当时 queue.ts 为 bfc82f8f…，state-store.ts 为 ef47c7f1…）。工作树中还有其他任务的智能体正在编写的文件（如 `plan/video.ts`），快照包含它们。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；TypeScript 经 `pnpm exec tsc`；评审复跑在同一环境中完成。本任务的测试用假执行器、假探测器、假能力表和假时钟，没有运行 ffmpeg/ffprobe（随附 ffmpeg n8.1.2 LGPL 与 RTX 4070 Ti SUPER 均未使用），没有启动 Electron。输入文件是测试运行时在 test-results/media-converter/queue-* 下生成的小文本文件（NTFS 卷 C:），测试结束后删除。 |
| 任务指纹 | 6fcbcc00973d69e9f1914a81c20a1f1ebef88826950ae33315b567fa18ac6e64 |

## 实际结果

本任务没有界面部分，不涉及截图。

**修改与新增的文件（均在写集内）**

- `src/media-converter/contract.ts`（只追加，仍只依赖 zod）：
  - 原因码枚举增加 `encode_failed`（不确定的编码失败，即进程层的 `unknown`）与 `output_publish_failed`（成品无法放到目标名下），按 design §10 的预告加入。
  - 新增 `capabilityStatusSchema` / `engineStatusSchema`（运行时状态 + 能力探测状态：unverified、detecting、ready{硬件编码器}、unavailable{code}）。这是给 T-ENGINE-03 的起点，它的写集同样包含 contract.ts，可以细化。
  - 新增队列协议：`QUEUE_LIMITS`（500 条、单次 100 个文件、日志 16 KB、5 个输出目录、进度 250 ms）、`itemIdSchema`、`queueOptionsSchema`（concurrency 1|2、lowUsage）与补丁 schema、`DEFAULT_QUEUE_OPTIONS`、`ITEM_PHASES`、`itemFailureCodeSchema`（引擎码 + 计划的不适用码与错误码）、`itemStateSchema`（design §6 的状态机，含 analyzing、unsupported、partial）、`itemProgressSchema`、`itemResultSchema`、`outputSelectionSchema`、`itemJobSchema`、`itemSummarySchema`、`batchSummarySchema`、`QUEUE_NOTICES`、`queueSnapshotSchema`、`queueEventSchema`（items、progress、engine、options、batch-finished，sequence 严格递增）、`startRequestSchema`、`retryRequestSchema`、`itemIdsRequestSchema`、`clearRequestSchema`、`startResultSchema`、`addFilesResultSchema`。
- `electron/main/media-converter/queue/types.ts`：队列依赖的接口，全部注入，队列本身不 import electron。
  - `MediaExecutor`（T-ENGINE-07 实现）：`run(job, hooks)` 与可选的 `endBatch()`。`ExecutionJob` 带冻结的设置与计划、每个输出的目标名 `targets`（目录 + encode 清理过的基础名 + 扩展名）、冲突策略、已确认可移入回收站的文件名 `confirmedReplace`、`lowUsage`、队列全部输入路径。`ExecutionHooks` 带 AbortSignal、`phase()`、`progress()`。`ExecutionOutcome` 为 succeeded / skipped{not_smaller} / failed{code, outputs, log} / cancelled，可附更新后的计划摘要（`encoder_fallback`）。
  - `QueueCapabilities`（T-ENGINE-03 实现）：`planner()`（等待探测中的检测，失败时给出原因码）、`status()`、`subscribe()`。
  - `QueueProber`（即 `MediaProber.probe`）、`QueuePowerBlocker`（electron `powerSaveBlocker` 的子集）、`QueueClock`（墙钟、单调时钟、定时器）、`QueuePlanner`（`buildPlan`）、`MediaQueueError`（整条命令被拒时的 code）。
- `electron/main/media-converter/queue/state-store.ts`：`QueueStateStore`。
  - `state.json` 内容：版本 1、队列选项、最近 5 个输出目录 `{id, path}`、条目（输入路径与登记时的文件状态、媒体信息、状态、冻结的作业（设置、计划摘要、输出模式/目录/冲突策略/确认替换的文件名、有损转无损是否已确认、是否「仍然转换」）、结果（含输出路径）、≤16 KB 的脱敏日志、时间戳）。
  - 写入：每 500 ms 最多一次（第一次变更起计时，写的是写入时的状态），串行，经 `atomicWriteUtf8File`；写入失败记日志并保留待写标记，下一次调度或 flush 再写。
  - 读取：文件不存在为空队列；JSON 无法解析或顶层结构不符时改名为 `state.corrupt.json`（覆盖旧备份）并以空队列启动；单个条目结构不符时只丢弃该条目。
- `electron/main/media-converter/queue/queue.ts`：`MediaQueue`。
  - **添加与探测**：`add(paths)` 经输入登记表登记（按身份去重，返回已有条目 id），单次最多 100 个，总数最多 500（先按完成时间清理最早结束的条目，仍满则不添加并计入 `truncated`）。新条目为 analyzing，后台探测，成功为 idle，失败为 unsupported{code}。探测不占转换名额。
  - **start**：zod 校验请求；只接受 idle 条目（分析中为 `busy`，unsupported 为其探测码，其他为 `invalid_request`）；输出目录按 id 从记住的目录中取（未知 id 为 `output_dir_unwritable`）；取能力表（失败时整批以其原因码拒绝）；逐条 `buildPlan`：不适用/错误以计划原因码拒绝，`already_target` 直接标为 skipped（不运行 ffmpeg），计划要求 `lossy_to_lossless` 且条目不在 `confirmed.lossyToLossless` 中时需要确认；用 encode 的 `outputFileName` 算出每个输出的目标名（`output_path_too_long` 时拒绝）；冲突策略为 overwrite 时用注入的 `wouldReplace`（即 `MediaOutputs.wouldReplace`）找出会被替换的已有文件，未带 `replaceExisting` 时需要确认。只要有一项需要确认，整批都不启动，返回 `needsConfirmation {lossyToLossless, wouldReplace:[{itemId, fileName}]}`，并把这些条目以 `confirmation_required` 列入 `rejected`。通过后深冻结设置与计划，保存目标名与已确认的替换清单，按请求顺序分配运行序号并进入 queued。所有 await 之后再核对条目仍是同一代、仍为 idle。
  - **调度**：并发数取自主进程的选项（默认 1），按运行序号取下一个；条目先占名额，再用 `InputRegistry.verify` 核对输入身份、体积与修改时间，不存在为 failed{input_missing}，已变化为 input_changed，均不运行；通过后为 running{preparing}，交给执行器。执行器的 phase 回调更新阶段；进度回调先用 schema 校验，再按条目节流：第一次立即发送，之后每 250 ms 最多一次，节流期间只保留最新值，到点发送最新值；条目结束时清除待发的进度，结束事件不节流。
  - **结果**：succeeded 记录已发布输出（路径只留在主进程，渲染进程只看到文件名与文件夹名）；skipped{not_smaller}；failed 时 `unknown` 或不认识的码归为 `encode_failed`，有已发布输出时 `partial: true`，日志先对原始日志的最后 256 KB 用条目的输入、输出目录与已发布输出路径再脱敏一次，再截取最后 16 KB 整行；cancelled（关停期间为 interrupted）。执行器抛错按 `encode_failed` 处理。
  - **cancel / remove / clear**：排队中立即取消（正在核对输入的条目同时中止）；运行中只发中止信号，等执行器清理完、返回 cancelled 后才变为已取消；重试中的条目可取消。remove 不移除运行中的条目。clear 的 finished 清除所有已结束的条目，all_idle 清除除排队、运行、分析中以外的全部条目。
  - **retry(override)**：接受 failed、cancelled、interrupted、input_changed、skipped、unsupported。按请求顺序预先分配运行序号；`InputRegistry.refresh` 以文件现状为准；重新探测；没有作业的条目回到 idle；有作业的用冻结设置与当前能力表重新规划：`not_smaller` 把冻结设置的 `discardIfNotSmaller` 改为 false 并重新冻结，`already_target` 运行被跳过的计划，两者都随作业保留到之后的重试；重新计算目标名后进入 queued。
  - **队列选项**：`setOptions` 只接受 `{concurrency?: 1|2, lowUsage?}`，变化时发 options 事件、写盘，并补足名额；lowUsage 在下一次运行开始时读取。
  - **事件与快照**：所有事件经同一个递增 sequence；`snapshot()` 给出当前 sequence、引擎状态、条目（按添加顺序）、选项、输出目录与一次性的 `notice`。items 事件带变化的条目摘要与被移除的 id。
  - **批次与电源**：条目进入 queued 时开始一批（已有批次则并入），没有排队、占名额或运行中的条目时发出一次 `batch-finished {succeeded, failed, skipped, cancelled, savedBytes}`，并调用执行器的 `endBatch()`。有排队或运行中的条目时持有 `prevent-app-suspension`，空闲或关停时释放。
  - **恢复**：`restore()` 读一次 `state.json`，命令都等它完成；排队、运行、分析中的条目标为 interrupted；idle 条目重新核对身份；超过 500 条时清理最早结束的。
  - **关停**：`shutdown(reason)` 在中止任何运行之前缓存同一个 Promise（FK-PIT-0046）；等待 restore 完成；排队与分析中的条目标为 interrupted；中止所有运行；释放电源阻止；最多等待 4 s；仍未结束的条目标为 interrupted；最后写盘。关停后 start/add/retry/setOptions 返回 `busy`。
  - **给后续任务的接口**：`previewPlan(itemId, settings)`、`rememberOutputDirectory(path)`（最多 5 个，按路径去重，不区分大小写）、`outputPath(itemId, index)`（只返回本工具发布的输出）、`isHardwareEncodeRunning()`（供「重新检测」判断 busy）、`drain()`、`persist()`。
- `test/media-converter/queue.test.ts`：实施时 24 项测试（评审后 28 项，见「评审与修复」），覆盖 V-ENGINE-05-1 列出的全部要点，另含 clear/remove、无效请求、拒绝原因、引擎状态事件等。所有事件都用 `queueEventSchema` 校验，快照用 `queueSnapshotSchema` 校验。

**变异检查**

对 queue.ts 与 state-store.ts 逐个施加 34 个变异（节流、尾随进度、并发、运行顺序、运行前核对、恢复映射、清理顺序、损坏备份、日志截取与再脱敏、两类确认、整批不启动、两种 override、关停等待与 Promise 缓存、关停期间的 interrupted、电源释放、批次结束与合并、sequence、防抖、写失败重写、选项恢复、取消排队、unknown 映射、设置冻结、重试刷新输入、500 上限、restore 等待），每次运行 queue.test.ts，结束后按 sha256 确认源文件已还原。第一轮中「批次运行中新条目重置批次计数」未被发现，因为原测试中后加入的条目在任何结果计数之前就并入了批次；改为在第一个条目结束后再加入，复跑后 34 个变异全部被发现。证据见 file:records/i1/T-ENGINE-05-mutations.txt。

**契约回归**

追加 schema 与两个原因码之后，读取 contract.ts 的单元测试（probe、progress、naming、stream-plan，共 204 项，不运行 ffmpeg）全部通过，见 file:records/i1/T-ENGINE-05-regression.txt。这不是本任务的验证项。

**评审与修复（2026-10-26，独立评审）**

评审逐条对照 R-ENGINE-05、AC-ENGINE-05-1 至 AC-ENGINE-05-5 和 design §6、§10，读完了写集内的全部代码与测试（contract.ts 的队列部分、types.ts、state-store.ts、queue.ts、queue.test.ts），也复跑了全部验证。

总体上，实现与设计一致：

- 状态机、两类确认、设置与计划冻结、运行前核对都有对应测试；
- 250 ms 进度合并、sequence 与快照、防抖原子写、500 条上限、损坏备份都有对应测试；
- 批次、电源和关停（Promise 先缓存再中止，FK-PIT-0046）也有对应测试。

队列不接触 ffmpeg 参数，也不接触渲染进程给的路径。渲染进程只提交条目 id 和输出目录 id，路径只留在主进程和 state.json 中，快照与事件里都没有绝对路径。

评审发现了下列问题，均在写集内修复：

1. **（major，潜在的数据丢失）恢复前的命令会覆盖 state.json。**
   - 问题：命令只在 `restore()` 已被调用时才等待恢复。如果 T-ENGINE-06 在调用 `restore()` 之前先处理了任何会写盘的命令（set-options、add、记住输出目录等），队列会用空的条目表写出 state.json，上次保存的条目全部被覆盖。
   - 修复：每个命令都先经过 `#whenRestored()`。还没有恢复时，由第一个命令触发 `restore()`（重复调用无副作用）；关停开始后不再读取。另外，如果恢复结束前已经给出过快照，恢复结束时补发 options 事件和 items 事件，保证「快照 + 后续事件」仍然等于当前状态。
   - 新增测试：reads state.json before the first command even when restore was not called。
2. **（minor，调度热循环）执行前抛错的条目会被反复重新调度。**
   - 问题：`#execute` 把条目交给执行器之前，如果抛出异常（例如输入登记表的 verify 抛错），条目会停在 queued。`finally` 中的 `#reconcile` 立刻又取出它，形成无休止的重试；如果抛错不经过宏任务，还会饿死事件循环。
   - 修复：`#launch` 的 catch 把仍属于本次运行的 queued/running 条目记为 failed{encode_failed}，批次照常结束，电源阻止照常释放。
   - 新增测试：fails an item whose run cannot be settled。
3. **（minor，持久化）写盘失败后不会自动重写。**
   - 问题：写盘失败后，只有下一次变更或 flush 才会再写。如果之后没有变更，应用又崩溃了，最后一次结果会丢失。
   - 修复：失败后 5 s（`STATE_STORE_POLICY.failedWriteRetryMs`）自动重试；flush 先到时由 flush 写；`close()` 之后不再重试。
   - 扩展了防抖测试：失败后不再有任何变更时，重试照样写出；flush 先写成功时，重试不再重复写。
4. **（minor，契约）执行器返回的计划摘要未经校验。**
   - 问题：执行器返回的计划摘要（`encoder_fallback`）不经校验就进入事件和 state.json。形状不对时，预加载会丢弃整个 items 事件，下次启动时这个条目也会因为结构不符被丢弃。
   - 修复：用 `planSummarySchema` 校验。不符合时保留原来的计划摘要，并记录日志。
   - 新增测试：takes the plan summary the executor ran with only when it has the summary shape。
5. **（minor，加固）恢复时的相对路径。**
   - 问题：state.json 被改动后，可能出现作业输出目录或结果输出路径不是完整路径的条目。这样的条目重试时会写到相对路径，「在文件夹中显示」也会打开相对路径。
   - 修复：这类条目在恢复时直接丢弃。
   - 新增测试：leaves out restored items whose output folder or outputs are not full paths。
6. **（minor，加固）关停的 Promise 可能 reject。**
   - 问题：`shutdown()` 缓存的 Promise 一旦 reject，共享关停每次重试都会拿到同一个已失败的 Promise。
   - 修复：内部错误只记录日志，这个 Promise 不会 reject。

修复后的回归情况：

- 测试从 24 项增加到 28 项，全部通过。
- 用会话 scratchpad 中的脚本，对评审后的代码复跑原有的 34 个变异，再加上针对上述修复的 6 个变异，共 40 个，全部被发现。脚本依次是：
  - M35：命令不触发恢复；
  - M36：执行前抛错的条目仍留在 queued；
  - M37：写盘失败后不重试；
  - M38：不经校验采用执行器的摘要；
  - M39：恢复时保留相对路径；
  - M40：早于恢复的快照之后不补发事件。

  每个变异运行后都按 sha256 确认源文件已还原。证据见 file:records/i1/T-ENGINE-05-mutations.txt（文件末尾追加了评审复跑的结果）。

评审中看到、但没有修改的问题见「风险与未执行项」末尾的「评审备注」。

**批次 C 修正（2026-10-28）**

工作台开始前，批次 C 的评审与集成检查指出队列一侧还缺几样东西，这次一并修正。本任务写集内改了 `queue/queue.ts`、`queue/types.ts`、`contract.ts` 与 `queue.test.ts`；`queue/state-store.ts` 不用改，因为条目状态经 `itemStateSchema` 写入 state.json。执行器、IPC 与规划器的部分见 T-ENGINE-07、T-ENGINE-06、T-ENCODE-01 的记录，设计回写见 engine design §11。

- **检测期间不调度（F3）。**
  - 原因：排队的条目会与硬件测试编码争用编码会话，检测因此得到 `session_limit` 结论，本会话内这些配置都不可用（T-ENGINE-03 的风险）。
  - 做法：能力状态为 `detecting`（第一次检测或「重新检测」）时，`#reconcile` 不启动排队的条目，也不为运行前的输入核对占用槽位。条目保持 `queued`，批次与电源阻止照常保持。
  - 检测开始时正在核对输入的条目，核对完成后交还槽位，继续排队。
  - 队列订阅能力状态，原来只推送 `engine` 事件，现在同时重新调度。检测结束后（以 `unavailable` 结束也一样），条目按启动顺序开始。已经在运行的条目不受影响。
- **`disk_space_low` 的数字（F1）。**
  - 原因：AC-ENGINE-06-4 要求显示所需与可用空间，原来这两个数只写在日志里。
  - 契约：失败状态增加可选字段 `space: {requiredBytes, availableBytes}`（`diskSpaceSchema`），用 refine 限定只能出现在 `disk_space_low` 上。`ExecutionOutcome` 的 `failed` 增加同名字段。
  - 队列：用 schema 校验执行器给出的值，合格才写入条目状态；不合格时只记日志，状态里只有原因码。其他原因码一律不带这个字段。
  - 持久化：状态随 state.json 写盘，重启后原样恢复；重试后清除。
- **取消时已发布的输出（F2）。**
  - `ExecutionOutcome` 的 `cancelled` 可以带 `outputs`、`warnings`、`summary`。
  - 队列像处理部分失败一样生成 result。状态仍为 `cancelled`，关停时为 `interrupted`。
  - result 随 state.json 持久化。`outputPath` 能找到这些输出，「在文件夹中显示」因此可用。
- **预览计划的替代编码（F5）。**
  - 规划器答 `no_encoder_available` 时，`previewPlan` 返回 `{ok: true, status: 'error', reason, alternatives}`。alternatives 去重，只保留契约认识的编码。
  - `dolby_vision_p5_unsupported` 与「不适用」仍然只返回原因码。
  - `start` 拒绝这类条目时只给原因码。
- **ready 状态字段必填（F4）。**
  - 契约中 `ready` 状态的四个字段改为必填。
  - 测试替身改为 `readyStatus()`：用 `resolveEncoders` 与 `defaultCompressCodec` 生成完整的 ready 状态，并经 `capabilityStatusSchema.parse` 校验。
  - 「engine」用例新增断言：发出的所有事件都符合契约。
- **测试。** queue.test.ts 新增 6 个用例：
  1. 检测期间不启动，连运行前的输入核对也没有；检测结束后两个两个地按顺序启动。运行中再次检测时，空出的槽位不会被占用；检测以 `unavailable` 结束后照常启动。
  2. 输入核对期间开始检测：条目交还槽位，检测结束后再核对一次，然后运行。
  3. `disk_space_low` 的字节数进入条目状态、事件与 state.json，重启后恢复；其他原因码、不合格的字节数都不带；契约拒绝其他原因码带这个字段。
  4. 取消的多输出条目列出已发布的输出，`outputPath` 可用，并随 state.json 恢复；关停时为 `interrupted`，同样列出。
  5. `no_encoder_available` 的预览带替代编码，覆盖去重、为空、其他错误与 start 的情况。
  6. ready 状态缺任一字段即不合契约。

  另外修改了「事件序号」用例：它原来在 `detecting` 状态下仍期待第二个条目开始，现在先断言条目保持排队，检测结束后才开始。共 34 项通过。
- **变异。** 逐项撤销修正：M2、M3、M5–M10 都被本文件的用例发现（file:records/i1/FIXUP-C-mutations.txt）。M6 第一次运行时只有一个用例失败，于是给第 1 个用例加了「检测期间输入核对次数为 0」的断言，之后两个用例都会失败。

**评审与修复（批次 C 修正的独立评审，2026-10-28）**

评审复核了本任务写集内的批次 C 修正：`queue/queue.ts`、`queue/types.ts`、`contract.ts` 与 `queue.test.ts`。没有发现需要修改的问题，本任务的文件未改动。评审唯一的代码修正在执行器，见 T-ENGINE-07 记录。

- **F3。**
  - `#reconcile` 与运行前的输入核对都会检查 `detecting`。
  - 真实的 `MediaCapabilities` 在检测开始和结束时都会同步通知订阅者（`#detectOnce` 中的两次 `#emit`），所以检测结束会触发重新调度。
  - 一次检测结束后可能紧接着再测一次（`#forceNext`，「重新检测」并入了用缓存的那次检测）。中间被启动的条目做完输入核对时，新的检测已经开始，于是交还槽位，不会与测试编码重叠。
- **F1。**
  - 只有映射后的原因码为 `disk_space_low` 时才写入 `space`，并先经 `diskSpaceSchema` 校验。
  - zod 4 的 `discriminatedUnion` 接受带 refine 的成员。契约和预加载的事件校验都会拒绝其他原因码带 `space`。
- **F2。**
  - `cancelled` 与关停时的 `interrupted` 都保留 result。
  - 重试会清空 result。已发布的文件留在磁盘上，再次运行时输出按编号命名，与部分失败的处理相同。
- **F5。** 预览结果的 alternatives 已去重，只保留契约中的编码，最多 3 个，满足 `previewPlanResultSchema`。
- 重跑：V-ENGINE-05-1 34 项通过，V-ENGINE-05-2 无诊断。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENGINE-05-1 | 通过 | file:records/i1/T-ENGINE-05-queue.txt |
| V-ENGINE-05-2 | 通过 | file:records/i1/T-ENGINE-05-tsc.txt |

- V-ENGINE-05-1：评审后复跑 28 passed，无跳过，exit 0（为列出用例加了 `--reporter=verbose`）。用例与验证要求的对应：
  - 并发 1 与 2 的执行顺序：并发 1 时按开始顺序逐个运行、最大同时运行数为 1；并发 2 时两个同时运行，第三个等名额；运行中添加的文件立即被探测（探测不占名额）。
  - sequence 严格递增：所有事件的 sequence 为 1、2、3…；运行中取快照后应用更大 sequence 的事件，结果与当前快照完全相同，旧事件不改变快照。
  - 每个条目每秒推送不超过 4 次：两个条目每 10 ms 各报一次进度、持续 3 s，任意 1 s 窗口内每个条目最多 4 个进度事件、相邻间隔 ≥ 250 ms、共 ≥ 12 个，最后一个是最新值；结束后不再有进度事件；非法进度被丢弃。
  - 队列选项经 set-options 修改并持久化：事件、state.json 与重启后的快照一致；lowUsage 传给之后开始的运行；restore 期间到达的命令等待 restore 完成。另验证 500 ms 防抖、原子写（目录中只有 state.json），以及写失败后的重写：没有新的变更时，5 s 后自动重试；flush 先写成功时，不再重复写。
  - 运行前输入被删除报 input_missing、被修改报 input_changed，两者都不交给执行器；重试被修改的条目会以现状运行，被删除的再次失败。
  - 重启后运行中与排队条目变为 interrupted，idle 条目重新核对（被改为 input_changed、被删为 failed{input_missing}）；重试重新探测、重新规划，并按重启前冻结的设置运行。
  - 超过 500 条时清理最早完成的：500 个未完成条目时再加入被计入 truncated；3 个条目先后完成后再加入 2 个，最早完成的 2 个被移除；单次超过 100 个只取前 100；恢复 505 条已完成条目时保留最晚完成的 500 条。
  - 损坏的 state.json 被备份为 state.corrupt.json，队列为空，`notice` 只出现一次；结构不符的整份文件同样备份；单个坏条目只被丢弃。
  - 错误日志尾部被截到 16 KB：约 270 KB 含路径的日志，保存的日志 ≤ 16384 字节且接近上限、以整行开始、以最后一行结束、不含任何盘符路径；state.json 中相同；`unknown` 记为 `encode_failed`。部分完成（2 个输出发布 1 个）为 failed{partial:true}。快照 JSON 中没有任何绝对路径。
  - 需要确认但请求未带确认时返回 confirmation_required：有损转无损未确认时该条目以 `confirmation_required` 拒绝，`needsConfirmation.lossyToLossless` 列出它，同批其他条目也不启动；带上确认后启动。
  - 覆盖策略下返回 wouldReplace：用真实的 `MediaOutputs.wouldReplace` 找到已有的 `clip.mkv`，返回 `wouldReplace:[{itemId, fileName:'clip.mkv'}]`；确认后执行器收到 `conflict:'overwrite'`、`confirmedReplace:['clip.mkv']` 与目标名；编号策略不需要确认。
  - retry 的 override 生效：`already_target` 先直接跳过、不带 override 重试仍跳过，带 override 后运行（目标名为 `same-converted.mp4`），之后的重试保持；`not_smaller` 重试时规划器与执行器收到 `discardIfNotSmaller:false` 的冻结设置，批次的 savedBytes 为 源 − 输出。
  - shutdown 取消并等待所有执行器结束：两次调用（以及中止回调中的重入调用）得到同一个 Promise；两个运行都被中止，二者都结束前 shutdown 不完成；运行与排队条目为 interrupted，未开始的 idle 条目不变；state.json 已写入；关停后 start/add 返回 busy；执行器不响应时在 4 s 后放弃等待并标为 interrupted，迟到的结果被忽略。
  - 电源阻止的获取与释放：一批开始时 `start('prevent-app-suspension')` 一次，批次结束时 `stop(id)` 一次，下一批重新获取与释放；关停时释放。
  - 按批次定义只发一次 batch-finished，批次运行中新加入的条目归入同一批：第一个条目结束后才加入的条目仍计入同一批，结果 {succeeded:2, failed:1}，只发一次；下一批单独再发一次；`endBatch` 每批调用一次。
  - 评审新增的 4 项：
    - 没有调用 `restore()` 时，第一个命令会先读入 state.json，写盘后原有条目仍在；恢复前给出的快照加上后续事件，等于当前快照。
    - 执行前抛错的条目记为 failed{encode_failed}，不会被反复调度（每个条目的 verify 只调用 1 次），批次结束且电源阻止被释放。
    - 执行器返回的计划摘要只有符合 schema 时才采用。
    - 恢复时丢弃输出目录或输出路径不是完整路径的条目。
- V-ENGINE-05-2：`pnpm exec tsc --noEmit -p tsconfig.json` 无诊断，exit 0；测试文件另用继承仓库配置的临时 tsconfig 检查，同样无诊断，exit 0。
- 批次 C 修正（2026-10-28）后，两项检查都已重跑，新输出追加在证据文件末尾，原内容保留：
  - V-ENGINE-05-1：34 passed，exit 0。新增用例见实际结果「批次 C 修正」；
  - V-ENGINE-05-2：`pnpm exec tsc --noEmit -p tsconfig.json` 没有诊断。另用继承它的临时配置检查了 test/media-converter 下的全部测试文件，同样没有诊断。
  - 全部非 Electron 的 media-converter 测试 691 项通过（file:records/i1/FIXUP-C-vitest.txt）。
- 评审与修复（2026-10-28，批次 C 修正的独立评审）后，两项检查都已重跑（本任务的文件未改），新输出追加在证据文件末尾：
  - V-ENGINE-05-1：34 passed，exit 0；
  - V-ENGINE-05-2：tsc 没有诊断，测试文件的临时配置检查同样没有诊断；
  - 全部非 Electron 的 media-converter 测试 692 项通过（file:records/i1/FIXUP-C-vitest.txt 末尾）。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENGINE-05-1 | 通过 | V-ENGINE-05-1, V-ENGINE-05-2 |
| AC-ENGINE-05-2 | 通过 | V-ENGINE-05-1, V-ENGINE-05-2 |
| AC-ENGINE-05-3 | 通过 | V-ENGINE-05-1, V-ENGINE-05-2 |
| AC-ENGINE-05-4 | 通过 | V-ENGINE-05-1, V-ENGINE-05-2 |
| AC-ENGINE-05-5 | 通过 | V-ENGINE-05-1, V-ENGINE-05-2 |

AC 结果只覆盖本任务写集内的队列部分，下列部分由后续任务接线与验证：

- AC-ENGINE-05-1：命令与事件经 IPC、预加载传到渲染进程（T-ENGINE-06）；渲染进程控制器按 sequence 应用事件（workbench）。本任务证明了主进程侧：sequence、快照与后续事件一致、进度节流。
- AC-ENGINE-05-4：把 `shutdown(reason)` 加入 `electron/main/index.ts` 的共享关停（T-ENGINE-06，其验收同样列有 AC-ENGINE-05-4）；取消后等待 ffmpeg 关闭并删除临时文件、日志与工作目录由执行器在返回 cancelled 之前完成（T-ENGINE-07，AC-ENGINE-04-3）。队列负责取消、等待（最多 4 s）、标记与写盘，已用假执行器验证。
- AC-ENGINE-05-5：窗口不在前台时按通知设置发出系统通知，由渲染进程控制器在收到 `batch-finished` 时完成（workbench）。真实的 `powerSaveBlocker` 由 T-ENGINE-06 注入。

## 风险与未执行项

**与设计的差异，以及在设计未明确处采用的做法**（均未修改设计文档）

1. **原因码。** 按编排要求在 contract.ts 中加入 `encode_failed` 与 `output_publish_failed`（design §10 已预告由本任务加入）。执行器应把进程层的 `unknown` 映射为 `encode_failed`、把发布失败映射为 `output_publish_failed`；队列另外把 `unknown` 与不认识的码都归为 `encode_failed`。
2. **start 的结果形状。** design 的表格是 `{started, needsConfirmation?, rejected}`。实现为：
   - 增加 `skipped`（`already_target` 的条目）；
   - `needsConfirmation` 始终存在，不需要时为 null；`wouldReplace` 是 `{itemId, fileName}` 列表，便于界面逐条「跳过」；
   - 需要确认时整批不启动，等待确认的条目以 `confirmation_required` 列入 `rejected`（V-ENGINE-05-1 要求「返回 confirmation_required」）。

   不可开始的原因：条目不存在或状态不是 idle 为 `invalid_request`，分析中为 `busy`，unsupported 为其探测码，未知的目录 id 为 `output_dir_unwritable`。
3. **batch-finished 的字段。** 除 design 的 `succeeded, failed, skipped, savedBytes` 外增加 `cancelled`。`input_changed` 与运行前的 `input_missing` 计入 failed。`savedBytes` 只统计成功的「压缩视频」条目，为 max(0, 源体积 − 输出体积之和)。关停时不发 batch-finished。
4. **事件。** design 只有五种 kind，没有输出目录的事件，所以 options 事件同时携带 `outputDirectories`。
5. **notice。** state.json 损坏后，`notice:'state_reset'` 只出现在之后的第一次快照中（由该次快照取走）。T-ENGINE-06 应只在 `get-snapshot` 处理中调用 `snapshot()`。
6. **重启时的分析中条目。** 启动时不探测（运行时校验只在首次需要时进行，见 runtime.ts），所以分析中的条目也标为 interrupted；重试时重新探测，没有作业的回到 idle。
7. **重试。** 运行序号按请求顺序预先分配；`retry` 等全部条目探测与规划完成后才调度并返回。两种 override 都随作业保留到之后的重试。重新规划时若计划要求有损转无损确认而作业没有确认，记为 failed{confirmation_required}。
8. **目标名的唯一来源。** 队列在 start（与 retry）时用 encode 的 `outputFileName` 算出每个输出的目标名，通过 `ExecutionJob.targets` 交给执行器。T-ENGINE-07 应直接使用，不要另算，以免与确认时的 `wouldReplace` 不一致。`confirmedReplace` 是确认时列出的文件名，执行器按 design §10 在覆盖前再核对一次。
9. **持久化的内容。** state.json 只保存计划摘要，不保存完整计划（它不是 zod 结构）。重启后的条目都要经重试重新探测、重新规划后才会运行，符合 AC-ENGINE-05-3。进入 running 的状态变化不单独写盘：重启后 queued 与 running 都会变为 interrupted，结果相同。
10. **取消与移除。** 运行中的条目在执行器清理完成并返回 cancelled 后才变为已取消；remove 不移除运行中的条目；clear 的两种范围按上文定义。
11. **关停。** 开始时就释放电源阻止，并把排队与分析中的条目标为 interrupted；执行器在关停期间返回 cancelled 时记为 interrupted，而不是 cancelled；4 s 后仍未结束的运行同样标为 interrupted，之后到达的结果被忽略。最后一次写盘失败只记日志，不让 shutdown 失败，以免阻塞退出，代价是该次变更丢失。评审后，`shutdown()` 的 Promise 对任何内部错误都不 reject。
12. **单次 100 个与 500 上限** 在队列内实现（IPC 层也会检查）。`truncated` 是未加入的文件数。
13. **能力与引擎状态。** `QueueCapabilities` 与 `engineStatusSchema`/`capabilityStatusSchema` 是本任务定义的接口与占位 schema，T-ENGINE-03 实现并可在 contract.ts 中细化；提供者抛错时按 `unknown` 拒绝。

**由后续任务接线的部分**

- T-ENGINE-06：注册（root = `userData/media-converter`、真实 `powerSaveBlocker`、`MediaOutputs.wouldReplace`、`MediaProber`、事件发送）、`restore()` 完成后再处理 IPC、`get-snapshot` 组合 `resolvedEncoders` 与 `defaults`、把 `shutdown` 加入共享关停、`pick-output-directory` 调用 `rememberOutputDirectory`、`reveal-output` 使用 `outputPath`。
- T-ENGINE-07：实现 `MediaExecutor`，在返回 cancelled 前删除临时文件与工作目录，`endBatch` 调用 `MediaOutputs.endBatch()`，进度用 `ProgressTracker` 产出 `ItemProgress`。
- T-ENGINE-03：实现 `QueueCapabilities`，「重新检测」时用 `isHardwareEncodeRunning()` 判断 busy。

**测试覆盖的局限**

- 执行器、探测器、能力表、电源阻止都是假的，时间用假时钟推进；真实 ffmpeg 下的取消与清理、真实 `powerSaveBlocker`、真实 IPC 没有在本任务验证。
- 进度节流用单调时钟；默认实现为 `performance.now()`，墙钟跳变不影响节流。
- 并发 2 时两个运行到达执行器的先后，取决于各自的输入核对谁先完成；测试不依赖这个顺序。名额与排队顺序是确定的。
- 500 条上限的测试在 test-results 下生成 503 个小文件，结束后删除。

**潜在风险**

- `retry` 等全部条目探测完成才返回，大批量重试时这次 IPC 调用耗时较长（未变化的文件命中探测缓存，通常很快）。
- items 事件携带完整的媒体信息，批量添加或清除时单个事件较大；state.json 最坏约 500 ×（媒体信息 + 16 KB 日志），即 10 MB 量级，写入有 500 ms 防抖。
- `restore()` 完成前的快照为空。评审后，命令会自己触发并等待恢复；恢复结束时，会给更早拿到快照的渲染进程补发事件。T-ENGINE-06 仍应在注册时调用 `restore()`，并等它完成后再处理 IPC，这样第一次快照就是完整的。

**未执行项与运行环境说明**

- 没有运行全量测试，没有启动 Electron，没有运行 ffmpeg/ffprobe。
- 变异检查脚本放在会话 scratchpad 中，不在仓库里；每个变异运行后都用 sha256 确认源文件已还原。
- 运行目录在 test-results/media-converter/queue-* 下创建，测试结束后删除；没有改动 test-results 下的其他内容。
- 验证版本快照在写入本记录之前取得，本记录的写入会改变工作树哈希。
- 评审没有修改 contract.ts，所以没有重跑契约回归；T-ENGINE-05-regression.txt 仍是实施时的结果。
- 评审复跑了 V-ENGINE-05-1、V-ENGINE-05-2 与变异检查，其余同上：
  - 没有运行全量测试，没有启动 Electron，没有运行 ffmpeg/ffprobe；
  - 结束后 test-results/media-converter 下没有残留的 queue-* 运行目录。

**评审备注（看到但未修改，留给后续任务或可接受）**

- 推送给渲染进程的进度：
  - `phase()` 引起的 items 事件不经过 250 ms 合并，这些事件也带着当前进度。
  - 每个输出只经历少数几次阶段变化，实际频率远低于每秒 4 次。只有一个条目在极短时间内提取很多条音轨时，才可能超过；需要时可由 T-ENGINE-07 合并阶段上报。
- 重试的运行顺序：
  - `retry` 在全部条目规划完后才调用 `#reconcile`。
  - 这期间如果别的运行刚好结束，已进入 queued 的重试条目可能先于同批中仍在探测的条目运行。
  - 名额上限与「先开始先运行」不受影响。
- 关于 `notice`：只有第一次快照会带上它（见差异第 5 条），T-ENGINE-06 应只在 `get-snapshot` 中调用 `snapshot()`。
- AC 的覆盖范围：AC-ENGINE-05-4 与 AC-ENGINE-05-5 在本任务中只证明了队列这一侧。以下部分不在本任务的写集内，由对应任务验证：
  - 共享关停接线（T-ENGINE-06，其验收也列有 AC-ENGINE-05-4）；
  - ffmpeg 的关闭与临时文件清理（T-ENGINE-07）；
  - 系统通知（workbench）。

**批次 C 修正后的说明（2026-10-28）**

- 检测期间排队的条目要等检测结束才开始。正常的检测约 4 s；最坏情况下要等 30 s 的测试预算，加上列表命令与读取显卡信息各自的超时。
- `space` 只在 `disk_space_low` 上出现。界面如何显示这两个数字由 workbench 决定。

**评审后的说明（2026-10-28）**

- 能力状态的订阅回调先推送 `engine` 事件再重新调度。如果 `status()` 抛出异常，这一次不会重新调度，要等下一个命令或运行结束时才调度。真实的 `status()` 是纯计算，评审认为不必处理。
