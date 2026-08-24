# 工作包 SUB-001：字幕后处理与 canonical transcript

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`SUB-001`
- 目标：在格式化和导出前冻结 segment-only v1 的结构窗口、raw transcript quality gate、overlap merge 与 canonical shaping 合同
- 验证状态：已完成提交级聚焦/全量测试、TypeScript、三段 Vite test build、manifest/validator、diff 与进程清理门禁

## 本次认领边界

- 包含：16 kHz structural root/retry planner、main-only attempt graph、raw response assessment、bounded retry decision、verified no-speech、owned-boundary merge、canonical cue shaping、processing report/warnings，以及 canonical domain/IPC schema 补充。
- 不包含：真实媒体解码、PCM/WAV header/bytes/frame identity、main-only branded window 的签发、HTTP/Supervisor/Job Manager 调度、SRT/LRC formatter、parse-back、原子写与 Artifact Registry。
- 后续职责：`MEDIA-001` 生成并验证 immutable branded PCM window；`BE-002` 把 brand 绑定到 exact structural window/attempt/epoch/generation/response；`SUB-002` 消费 canonical transcript 完成标准产物。

## 本次实现内容

### Structural root plan 与 attempt graph

- 新增 16 kHz frame-authoritative root planner，按 PRE-006 的 30 秒窗口、5 秒 overlap 覆盖 half-open interval `[0,totalFrames)`；`durationMs` 只由 `Math.round(totalFrames * 1000 / 16_000)` 派生，禁止从毫秒反向取整重建 frame coverage。duration/frame 超过 CORE v1 上限时在分配大数组前失败。
- 每个 descriptor 保存稳定 `rootPlanId`、`rootWindowKey`、`windowKey`、可选 `parentWindowKey`、retry depth、frame range、owned core 与对应整数毫秒；root plan 和 retry children 都按纯 planner 复算并 exact compare。
- `windowAttempt` 定义为 root-plan-local 唯一正整数 dispatch ID。child ID 必须大于 parent，允许有间隔；缺失 root attempt 的错误只携带已知 root identity，不伪造 `windowAttempt/processEpoch/requestGeneration=0`。
- 每次 attempt 绑定 Supervisor `processEpoch`、dispatch `requestGeneration` 与 response generation；generation 必须完全相等，`processEpoch:requestGeneration` 不能被复制到其他 attempt。task mode 同样绑定：`transcribe → transcribe`，`translate_to_english → translate`。
- 退化 parent 只有在全部 exact retry children 存在时才被替代；accepted leaves 的 owned core 必须无 gap/overlap 覆盖全部 source。odd-half-millisecond retry 仍以 frame 为事实并允许 rounded millisecond descriptor 通过 exact graph validation。

### Raw quality gate 与 retry

- raw gate 位于 trim、dedup、split、merge 和 formatter 之前，检查 strict contract、正时长、顺序/重叠、窗口边界、15 秒单段上限，以及同文连续 8 cue 的首尾 wall-clock span 是否达到 15 秒。
- 空 segment 只有在 response duration 为正、与窗口时长在 100 ms 内一致且顶层 text/segment text 同时为空时，才形成 verified no-speech terminal；`durationMs=0` 或正文矛盾不能填补执行覆盖。
- 正常 `split` 是 main-only structured control，不产生公开 task error。逐窗 quality retry 只有 `retry_exhausted` / `unsplittable` 映射 `transcript_quality_failed`；contract shape/task/generation 问题映射 protocol mismatch。merge/shaping/canonical 的全局质量失败仍可独立返回 `transcript_quality_failed`。
- policy provenance 分层：30,000/5,000/depth 3 属 PRE-006 strategy；100 ms、15,000 ms、8 cue + 15,000 ms span、4,000/2,000/1.25 retry 与 500 ms + CJK 2 / Latin 4 属 PRE-004 oracle；300 ms short-cue merge 和 fingerprint/grapheme 规则是 SUB-001 clean-room policy v1。

### Boundary merge 与 provenance

- 只在相邻 owned core、实际 window overlap、两侧 raw observation 均进入 overlap 时执行 destructive boundary handling；prefix trim 还要求两侧 raw interval 真实相交。
- crossed-midpoint observation 按确定性 ownership 保留，避免同一个边界片段被两窗同时丢弃；duplicate/empty-prefix absorption 后更新到最新边界 provenance，支持后续相邻窗口继续比较。
- raw decoder-loop fingerprint 使用 `NFKC + lowercase` 并忽略 punctuation/symbol/whitespace；会删除正文的 boundary fingerprint 保留 symbol，只忽略 punctuation/whitespace。命名明确为 `nfkc-lowercase-*`，不宣称 Unicode full casefold。
- boundary prefix 比较使用线性 KMP-style matching；NFKC 映射回原文时只能在完整 source grapheme 边界裁剪，不切断组合字符、emoji sequence 或 surrogate pair。

### Canonical shaping、Unicode 与 warning 边界

- v1 固定 `segment_only_v1`，VAD/非 VAD 均不消费 words。segment 无需拆分时保留真实时间；因 cue duration/text limit 必须拆分时按 grapheme-safe 比例估时，并标记 `estimatedTiming: true`。
- `LocalSubtitleSegment` 新增 `estimatedTiming?: true`；strict schema 要求它与 `words` 互斥，并继续校验 segment/word 单调、范围和 transcript 总量上限。
- 文本在 post processor 中把 CRLF/CR/U+2028/U+2029 统一为 LF；post processor、server parser 与 canonical strict schema 拒绝 unpaired UTF-16 surrogate，以及不受支持或会破坏结构的 C0/C1 控制字符。canonical payload 只接受 LF 换行。
- source boundary tolerance 内可 clamp 并记录 main-only `timeline_boundary_clamped`；按比例拆分记录 main-only `estimated_timing_used`。clamp 后零时长（包括纯边界 `[-100, 0]` / `[duration, duration+100]`）以结构化质量失败终止，不能静默丢弃为 no-speech。
- shared `LocalSubtitleCompletionResult.warnings` v1 保持只有 `cancelled_after_partial_commit`。若未来公开 processing warning，必须升级 CORE shared contract，不由 `SUB-002` 临时扩张。

## 修改文件

- `electron/main/local-subtitle/subtitle-post-processor.ts`
- `electron/main/local-subtitle/server-contract.ts`
- `src/type/localSubtitle.ts`
- `src/type/localSubtitleIpc.ts`
- `src/type/localSubtitleIpc.test.ts`
- `test/local-subtitle/subtitlePostProcessor.test.ts`
- `test/local-subtitle/serverContract.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- 本实施记录

## 接口、状态或数据结构变化

- 新增 `LOCAL_SUBTITLE_POST_PROCESSING_POLICY`、`createSubtitlePostProcessPolicy()`、`planLocalSubtitleRootWindows()`、`planLocalSubtitleRetryChildren()`、`assessLocalSubtitleRawWindow()`、`decideLocalSubtitleWindowRetry()` 与 `postProcessLocalSubtitleTranscript()`。
- 新增 root/window/attempt/retry decision、raw assessment、post-processing report/warning 和 structured error types；图错误只暴露实际已知 lineage/generation 字段。
- `LocalSubtitlePostProcessingWindowAttempt.response` 必须携带与 dispatch 相同的 `requestGeneration`，并要求 reusable session disposition。
- `LocalSubtitlePostProcessingRequest` 绑定 source frame summary、model summary、task mode、policy、root plan 与完整 attempts，而不是只接收最终叶窗数组。
- canonical `LocalSubtitleSegment` 增加 literal `estimatedTiming?: true`；`words` 与 estimated timing 互斥。
- 没有新增 public IPC channel、task status、error code 或 public warning code。

## 安全、隐私与许可证检查

- structural plan、attempt graph 和普通对象不拥有文件/媒体 authority；生产接线仍必须持有 `MEDIA-001` module-private brand，不能从路径或 descriptor 推导权限。
- post-processing input/output 不含 raw media/model/temp path、endpoint、port、token、capability、API Key 或命令行；错误只携带受控 reason、lineage、计数和 assessment。
- processing report/warnings 保持 main-only，不进入 renderer completion payload、Store 或持久化 session。
- 没有新增依赖，没有修改 `package.json` / `pnpm-lock.yaml`，没有执行裸 `pnpm`，没有复制 AGPL 参考实现。

## 验证结果

最终收口命令：

```text
node_modules/.bin/vitest run test/local-subtitle/subtitlePostProcessor.test.ts test/local-subtitle/serverContract.test.ts src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- 聚焦覆盖：segment-only server bridge、root/recursive retry graph、root-plan duration guard、odd-half-millisecond retry、attempt/epoch/request-response lineage、task mode mismatch、missing root identity、verified no-speech、raw degeneration wall-clock span、boundary provenance/KMP/NFKC/grapheme、100/101 ms boundary、boundary-only zero duration、Unicode controls/surrogates/LF-only、estimated timing 与 canonical schema。
- 聚焦 Vitest：4 files / 174 tests 全部通过（subtitlePostProcessor 67、serverContract 26、localSubtitle 41、localSubtitleIpc 40）。
- 全量 Vitest：117 passed + 2 skipped files / 1223 passed + 2 skipped tests（119 files / 1225 tests）。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、validator 17/17 与 `git diff --check` 通过。
- 本工作包没有启动 Vite dev server、Electron 或 native server；收口检查无 Vitest/Vite/Electron/runner/FFmpeg 残留。

## 未完成事项与风险

- `MEDIA-001` 尚未生成真实 PCM/WAV 与 module-private branded window；SUB-001 的 structural frame/window validation 不能证明文件 bytes、WAV header 或 file identity。
- `BE-002` 尚未把 branded window、structural descriptor、attempt/epoch/generation 与 Supervisor response 原子绑定；接线必须覆盖 swap、reuse 和 stale response fault matrix。
- `SUB-002` 尚未实现 SRT/LRC formatter、parse-back、原子提交、full/partial/none-success 与 Artifact Registry；不能从 canonical transcript 已完成推导出用户产物已可用。
- v1 没有可信 word producer。未来 non-VAD words 必须通过新的 server contract version/capability/provenance 工作包，不得向现有 post processor 偷渡 optional words。
- raw quality gate 只证明没有已知 decoder loop/时间轴退化，不声明 CER/WER；真实中日长媒体内容仍须在集成与 packaged QA 中人工 smoke。

## 下一步建议

- 可优先认领 `MEDIA-001`，产出可与本 graph contract exact 绑定的 branded PCM window；或认领已解锁的 `SUB-002`，从 strict canonical transcript 完成标准 SRT/LRC 原子产物。
- `BE-002` 继续等待 `MEDIA-001`、`SUB-002`、`MODEL-001`；开始接线时把 immutable brand/window/attempt/generation/response 作为单一 execution binding，不要只传 path + response。
- 非 VAD word timeline 继续 deferred；先完成 segment-only v1 的最小端到端闭环。
