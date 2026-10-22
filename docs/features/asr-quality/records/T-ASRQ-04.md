# 实施记录：T-ASRQ-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-04 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。修改：`electron/main/subtitle-studio/transcription/native/subtitle-post-processor.ts`、`electron/main/subtitle-studio/transcription/native/overlap-group-splice.ts`（写集外，见“偏离”）、`scripts/subtitle-studio-provenance/current-copy-audits.{mjs,json}`、`test/subtitle-studio-provenance/replay.test.ts`、`test/subtitle-studio-provenance/transcript-executor-replay.test.ts`。新增：`test/subtitle-studio/transcription/transcriptConfidence.test.ts`、`test/subtitle-studio/transcription-confidence-document.test.ts`（写集外的 `test/subtitle-studio/` 根目录，见“偏离”）、本记录与 `records/T-ASRQ-04-{unit,static,integration}.txt` |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；TypeScript 5.9.3。测试只用合成的服务端响应与 PCM 夹具，不使用 GPU、真实模型、whisper-server 或 FFmpeg；没有下载任何模型 |
| 任务指纹 | 46ff26e9fdeacd3c28870a79b287e76f6494cd62bf160b2ba86138a8bec5a365 |

## 实际结果

### 置信度计算（`native/subtitle-post-processor.ts`）

- 每个原始段：`c = exp(min(0, averageLogProbability)) × (1 − noSpeechProbability)`。原始段契约已保证两者有限且 `noSpeechProbability ∈ [0, 1]`；设计没有写的一处细节是把正的 log 概率截到 0（否则 exp 会超过 1），因此 c 必然在 [0, 1]，不会出现 NaN。
- `WorkingSegment` 增加 `confidence` 与 `confidenceWeightMs`（只在后处理内部使用，不进入报告与策略对象）：
  - 投影/裁剪：投影到窗口核心并裁剪后的段保留原值，权重是裁剪后拥有的时长（`endMs − startMs`），不是原始观测时长。
  - 跨窗去重（`duplicateBoundarySegment`）与“裁剪前缀后为空/只剩标点”的边界碎片：并入前一段时按两者权重求加权平均，权重相加。被保留的“裁剪前缀但仍有文字”的段文本变短、时间不变，置信度保持自身值。
  - 重叠修复（≤ 100 ms 的边界移动）：被移动起点的段此时总是单一来源，权重改为调整后的时长；它若随后吸收下一窗的重复观测，按调整后的跨度加权。前一段此后不会再合并，不需要调整。
  - 断句整形 `shapeCanonicalSegments` 为一对一映射（`{ ...segment, text }`），置信度原样带过。
- 输出：`segments[].confidence = Math.round(c × 1000) / 1000`，紧跟在可选的 `estimatedTiming` 之后写入候选对象；经 `validateLocalSubtitleTranscript`（zod strict schema，`confidence` 早已是可选的 0–1 有限数）后按 schema 字段顺序输出。时间、文本、合并、整形、重试与质量判定逻辑都没有改动。

### 执行器后续修复中的置信度

`transcript-executor.ts`（以及冻结副本 `native/production-executor.ts`）在 win32 + CUDA + VAD 路径上会用 DTW/接缝证据替换个别字幕。逐一检查了所有替换构造：`cue-separator-restorer`（含 DTW 拆句）、`cue-display-separators`、`cue-overlap-resolver`、`cue-complete/prefix/multi/contained/variant-overlap-evidence`、`cue-short-onset-evidence` 都以 `{ ...cue, ... }` 展开原字幕，因此自动带上其（某一个父字幕的）置信度；唯一新建对象的是 `overlap-group-splice.ts` 的 `draftOverlapGroupSplice`，它被默认的 `acoustic_quiet_v1` 停顿窗口 + large-v3 日语路径使用，原实现会让这些字幕丢失置信度。为满足 AC“每段都有置信度”，在该处让保留的字幕带上它自己的置信度（`id` 与文本本来就与原字幕相同，只是时间被重新估计）；输入字幕没有置信度时（旧文档、复制来的测试）输出与之前逐字段相同。`transcript-executor.ts` 没有修改。

### 回放测试

- `replay.test.ts`（旧版对拍）：新增 `withoutReviewedConfidence`，在严格比较前只从 Studio 一侧的 `transcript.segments[]` 去掉 `confidence`，并以带日期与原因的注释说明这是审阅过的差异；另用 `assertStudioConfidence` 断言旧版一侧没有该字段、Studio 一侧每段都是三位小数以内的 0–1 数值。其余字段（请求、窗口、原始响应、生命周期、产物哈希等）仍严格相等。产物只有 SRT/LRC，不含置信度，哈希不变。
- `transcript-executor-replay.test.ts`：两侧都使用当前的 Studio 后处理器，置信度已在原有严格比较之内；另加每段置信度存在与范围的断言，并在“真实 producer → sink → repository → 重开”用例中断言重开后的文档转写稿每段都有置信度。
- T02 复制来的 `test/subtitle-studio/transcription/*.test.ts` 没有需要改动的精确转写断言（`subtitlePostProcessor.test.ts` 85 项、`productionExecutor.test.ts` 174 项、`overlapGroupSplice.test.ts` 30 项均未修改并通过），因此没有新增测试副本的审计。

### 文档兼容

`document-adapter.ts` 与 `validateDocument` 都使用同一个 strict 转写稿 schema，无需修改：有置信度、无置信度（旧文档）与部分有置信度的转写稿都能生成文档、通过校验、写入并重开；`transcriptDigest` 在创建与重读时按同一 schema 顺序计算，自洽。超出 0–1、NaN 或字符串的值在两处都被拒绝为 `invalid_input`。字幕（cue）本身不复制置信度，转写稿是唯一来源。

### 审计登记

- `current-copy-audits.mjs`：`CURRENT_COPY_AUDIT_OWNERS` 增加 `native/overlap-group-splice.ts` 与 `native/subtitle-post-processor.ts`（`FORK_PATH`），共 10 个所有者。
- `current-copy-audits.json`：10 条。新增 `subtitle-post-processor.ts`（`copiedSha256 a6cfa204…` → `currentSha256 314f94e0…`）与 `overlap-group-splice.ts`（`547c64ad…` → `4e4be16a…`），`copiedSha256` 取自 `transcription-fork.json` 的 `destinationSha256`，各附 2026-10-22 T-ASRQ-04 原因。其他条目未动。受审计文件均为 LF（CR 字节数 0）。完整哈希见 `T-ASRQ-04-static.txt`。
- 未改任何组合文件，不需要重新登记 `currentBlobOid`；`transcript-executor.ts` 未改，其审计条目不变。

### 测试与变异检查

- `transcriptConfidence.test.ts`（10 项）：见 V-ASRQ-04-1。
- `transcription-confidence-document.test.ts`（6 项）：见 V-ASRQ-04-2。
- 变异检查（草稿脚本临时改动后用备份恢复，恢复后哈希与改前一致，见 `T-ASRQ-04-unit.txt`）：未加权平均、重叠修复后不重算权重、不截正 log 概率、碎片不并入、重复不并入、按未裁剪时长加权、拼接丢失置信度，7 个变异各被至少 1 项用例抓到；去掉回放中的剥离后 `replay.test.ts` 有 11 项（全部产生转写稿的用例）失败，加上剥离后 20 项全部通过，说明置信度是新旧实现之间唯一的差异。

### 偏离

- 写集外修改：`native/overlap-group-splice.ts`（一行条件展开 + 注释），理由见上，已按冻结副本流程登记审计。tasks.md 的写集与 design.md“现状与约束”中的本期 native 文件清单没有包含它，需协调者补记（本任务未修改 tasks.md / design.md）。
- 新增的文档兼容测试放在 `test/subtitle-studio/` 根目录（与现有 `transcription-document.test.ts` 同处），不在写集 `test/subtitle-studio/transcription/` 之下；它只读取 Studio 的文档适配与仓库实现，不修改任何其他文件。
- 执行器的 DTW/接缝修复会重切文字，替换字幕带的是其展开的那个父字幕的置信度，而不是按重叠时长加权平均；设计的加权规则只在后处理器内实现（见“风险”）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-04-1 | 通过 | inline:证据文件 records/T-ASRQ-04-unit.txt；`transcriptConfidence.test.ts` 10 项、`subtitlePostProcessor.test.ts` 85 项、`overlapGroupSplice.test.ts` 30 项、`transcription-confidence-document.test.ts` 6 项，共 131 项通过）。覆盖：单段 `exp(-0.25)×0.99` 输出 0.771 且整段对象精确相等；极端值（(log 概率, no_speech) = (0.4, 0)、(0, 0)、(-0.0004, 0)、(-1, 0.5)、(-30, 0)、(-0.1, 1)、(-745, 0.2)）输出 [1, 1, 1, 0.184, 0, 0, 0]，全部在 0–1 且为三位小数；跨核心边界被裁剪的段保持自身值；跨窗去重按拥有时长 2000/1000 ms 加权得 0.726（未加权为 0.636）；裁剪后为空的边界碎片按 1500/500 ms 并入；裁剪后仍保留的段保持自身值；重叠修复后按 975 ms（而非 1000 ms）加权得 0.707（否则 0.712）；空窗口不影响另一窗口的值，全部为空时仍是原来的 `no_speech_detected`（canonical）结果，没有 NaN 或异常类型；重叠组拼接保留每个保留字幕的置信度，旧字幕不新增该字段。另有 7 个变异各被抓到 |
| V-ASRQ-04-2 | 通过 | inline:证据文件 records/T-ASRQ-04-integration.txt；`test/subtitle-studio-provenance`、`test/subtitle-studio/transcription*`、文档 producer/sink/适配、`boundaries.test.ts`：59 文件通过、5 跳过，1185 项通过、7 跳过，exit 0；含 `replay.test.ts` 20 项、`transcript-executor-replay.test.ts` 23 项、`current-copy-audits.test.ts` 11 项、`transcription-document.test.ts` 27 项。随后 `test/subtitle-studio test/asr-quality` 全量：107 文件通过、58 跳过，1965 项通过、71 跳过，exit 0。跳过的是需要环境变量的 Electron UI、真实运行与 A/B 用例）；file:records/T-ASRQ-04-unit.txt（旧文档：无置信度与部分有置信度的转写稿生成文档、`validateDocument` 通过、写入并由新的 `DocumentRepository` 重开后与原转写稿相等，cue 文本与转写稿一一对应；越界值被拒）；file:records/T-ASRQ-04-static.txt（最后一次修改后：`copy.mjs --check` passed，120 文件；`transcript-executor-copy.mjs --check` passed；`shared-resource-integration.mjs` exact；`npx tsc --noEmit -p tsconfig.json` exit 0 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-03-1 | 通过 | V-ASRQ-04-1, V-ASRQ-04-2 |

## 风险与未执行项

- AC-ASRQ-03-1 说明：本任务部分：新转写稿每段都有 0–1 置信度、无置信度的旧文档正常打开；“只按文本规则标记”属于 T-ASRQ-05 的复核规则，未在本任务验证

- 置信度只是解码器证据，不是准确率。records/model-smoke.md 显示 v1.9.1 这条路径的 no_speech_prob 几乎恒为 1.93e-05，实际值约等于 exp(avg_logprob)，且服务端 avg_logprob 偏高；`low_confidence` 的阈值（design 初值 0.45）必须由 T-ASRQ-09 的真实对照校准。本任务没有在真实模型或真实音频上产生过置信度。
- 执行器 DTW/接缝修复（仅 win32 + CUDA + large-v3 日语路径）重切文字时，替换字幕带的是某一个父字幕的置信度：接缝重叠合并与前缀重叠取右侧字幕的值，包含组各段保留自身的值，多父组与变体组的两段分别取左/右父字幕的值，短起音拆出的两段都取首句的值，DTW 拆句的各段取原句的值。这是近似值，不是加权平均；若复核需要更精确，需要在这些冻结副本中逐个处理（不在本任务写集）。
- `overlap-group-splice.ts` 在写集外，需要协调者在 tasks.md 写集与 design.md 的 native 文件清单中补记；其审计条目与本任务一起提交。
- 新文档的转写稿 JSON 多了 `confidence`，因此同一音频的 `transcriptDigest` 与改动前不同；仓库中只用它做自洽校验与 sink 的冲突检测，不影响旧文档。
- 未运行 Electron UI 测试：本任务没有界面改动，置信度的展示属于 T-ASRQ-05。
- `test/subtitle-studio-provenance/replay.test.ts` 的工作树副本本来就是 CRLF（autocrlf 检出，索引为 LF），编辑保持原样；它不是受审计文件。
- 未提交。`current-copy-audits.{mjs,json}` 同时包含 T-ASRQ-02/03 与本任务的条目，需要一起提交（或按顺序提交并保持条目数与所有者数一致）。
