# 实施记录：T-ASRQ-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-03 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。新增：`test/subtitle-studio/transcription/gatedQuietAudio.test.ts`、`test/subtitle-studio/transcription/quietAudioWindow.test.ts`、`test/subtitle-studio/transcription/quietAudioSignals.ts`、本记录与 `records/T-ASRQ-03-{unit,static,integration,real-gain}.txt`。修改：`electron/main/subtitle-studio/transcription/native/quiet-audio.ts`、`electron/main/subtitle-studio/transcription/native/pcm-window.ts`、`electron/main/subtitle-studio/transcription/native/media-normalizer.ts`、`electron/main/subtitle-studio/transcription/transcript-executor.ts`、`test/subtitle-studio/transcription/productionExecutor.test.ts`、`scripts/subtitle-studio-provenance/current-copy-audits.{mjs,json}`。全部在写集内 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；TypeScript 5.9.3；esbuild 0.21.5（只用于草稿目录里的基线与基准脚本）。本任务的测试不使用 GPU、真实模型、whisper-server 或 FFmpeg；没有下载任何模型 |
| 任务指纹 | 63ff534387ed3ef575bba301e707f96e2de275eb161708ade5c71278fd4880c4 |

## 实际结果

### 增益算法（`native/quiet-audio.ts`）

新增 `LOCAL_SUBTITLE_WHISPER_AUDIO_POLICY` 与 `conditionWhisperPcm16`，按 design 方案 2 实现；`conditionQuietPcm16`、`shouldRetryUnconditionedAudio` 与原有策略常量逐字未动。设计没有写死、由实现确定的细节：

- 帧与门限：160 采样一帧，最后不足一帧的尾帧按实际采样数计算 RMS；“数字静音帧”指帧内采样全为 0。“少于 0.5 s”按采样数计（非静音帧或活动帧合计少于 8000 采样即原样返回）。前 100 ms / 后 250 ms 即 10 / 25 帧。
- 百分位：线性插值（与 numpy 默认相同）。噪底、活动阈值、语音电平与 g0 = clamp(-23 − 语音电平, 0, 30) 按设计；g0 < 3 dB 原样返回。
- 峰值限制：-1 dBFS 取 `10^(-1/20) ≈ 0.8913`（设计中的 0.891 是它的四舍五入），与 `conditionQuietPcm16` 的 `maxPeakDb` 一致。帧峰值本身已高于 -1 dBFS 时公式给出负值，按公式原样实现（该帧被轻微衰减），没有截到 0 dB。
- 平滑：先对 ±2 帧取最小值，再做 3 帧（30 ms）居中滑动平均（dB 域，边缘只平均存在的帧），零相位。逐采样增益在相邻帧中心之间按线性幅度插值，首尾半帧保持端点值。由此每个采样的增益都不超过其所在帧的峰值限制（插值两端的平滑值都只由该帧 ±2 帧内的最小值构成），`tanh` 软膝（与 `conditionQuietPcm16` 同一公式：膝点为上限的 0.9）只作兜底。
- 返回：增益生效时返回新 Buffer 与 `gainDb: g0`（未取整）；原样返回时返回同一个输入 Buffer 与 0。输入校验与 `conditionQuietPcm16` 相同（空、奇数字节、超过 30 s 抛 `TypeError`）；1 个采样这类极短输入、全静音、满幅、正常电平都原样返回。

### 窗口与执行器接线

- `native/pcm-window.ts`：`writeLocalSubtitlePcmWindow` 新增可选 `quietAudioMode: 'gated_v1'`；`conditionQuietAudio` 为真且带该模式时改用 `conditionWhisperPcm16`，否则调用路径与之前完全相同。增益仍以 `gainDb > 0` 写出 `quietAudioGainDb`；头部、帧范围、回读、哈希与身份校验未改。
- `native/media-normalizer.ts`：`materializeWindow` 新增同名可选项；只在定义时才转交给窗口写入（标准窗口的写入调用参数与之前逐项相同）；窗口品牌与 `resolveWindow` 结构不变，没有新增字段。
- 校验（比“与 conditionQuietAudio 一样的类型校验”更严一步，理由是避免模式被静默忽略）：未知模式、或带模式但 `conditionQuietAudio !== true`，`pcm-window` 在创建输出文件前抛 `invalid_configuration`；`media-normalizer` 在开始写窗口前抛 `invalid_configuration`（`runtime_protocol_mismatch` 公共码），归一化媒体不会因此进入故障状态。
- `transcript-executor.ts`：原来只做校验的 `taskAudioProfile(context);` 改为取出 `quietAudioMode`（`LOCAL_SUBTITLE_AUDIO_PROFILES` 中只有 `quiet_whisper_v1` 带 `'gated_v1'`，由 T-ASRQ-02 放在参数表里）；`materializeWindow` 只在 `conditionQuietAudio` 为真时附带该模式。回退原音（`conditionQuietAudio=false`）、分隔候选、前缀/组/短起音等见证窗口原本就传 false，因此永远不会带模式。返回的 `quietAudioGainDb` 沿用现有逻辑：1000 ms VAD 填充与 `shouldRetryUnconditionedAudio` 回退一次，未改。执行器没有新增任何导入，仍只依赖 fork 文件集。

### 审计登记

- `current-copy-audits.mjs`：`CURRENT_COPY_AUDIT_OWNERS` 新增 `native/pcm-window.ts`、`native/quiet-audio.ts`（`FORK_PATH`），共 8 个所有者。
- `current-copy-audits.json`：8 条。新增 `pcm-window.ts`（`copiedSha256 f0f9ee2d…`，`currentSha256 cabd62e1…`）与 `quiet-audio.ts`（`45404a72…` → `10ff51f9…`），`copiedSha256` 取自 `transcription-fork.json` 的 `destinationSha256`；`media-normalizer.ts`（→ `9986999c…`）、`transcript-executor.ts`（→ `8fc37afa…`）、`productionExecutor.test.ts`（→ `3485e89b…`）更新 `currentSha256` 并追加 2026-10-22 T-ASRQ-03 原因句，`copiedSha256` 保持。完整哈希见 `T-ASRQ-03-static.txt`。受审计文件均为 LF（CR 字节数 0）。
- 未改任何组合文件，不需要重新登记 `currentBlobOid`。

### 测试

- `quietAudioSignals.ts`：确定性合成 16 kHz PCM（4 次谐波 + 4 Hz 音节包络 + 10 ms 渐变的“语音”、2 kHz 点击、mulberry32 白噪声噪底），三个固定信号：-65 dBFS 耳语（-90 噪底）、-40 dBFS 中等（-75 噪底）、-45 dBFS 带 4 个 4 ms / -6 dBFS 点击（-80 噪底）。
- `gatedQuietAudio.test.ts`（5 项）：算法性质，见 V-ASRQ-03-1。
- `quietAudioWindow.test.ts`（7 项）：真实 Studio `pcm-window` 写入与 `LocalSubtitleMediaNormalizer`（受控进程运行器，同 `source-media-lifecycle.test.ts` 的做法）。标准窗口的文件哈希常量是在任何源码修改之前，用 68ffd05 的未修改代码对同样三个信号写窗口得到的（草稿脚本输出：耳语 `50cae1b4…`（整窗增益拒绝，与不调理相同）、中等不调理 `b1ef45f9…` / 整窗 12 dB `3396505a…`、瞬态 `e0f87ba0…`（整窗增益拒绝））。
- `productionExecutor.test.ts` 新增 “Studio gated quiet audio” 8 项，并给假媒体请求类型补上 `quietAudioMode`；复制来的既有用例未改。`quietAudio.test.ts` 是 fork 冻结副本，按要求只运行、未修改。
- 变异检查（草稿中临时改动后用备份恢复，恢复后哈希与改前一致）：算法侧 5 个变异（非活动上限 6→12 dB、去掉 100 ms 前导、去掉 250 ms 保持、去掉帧峰值限制、去掉噪底门控）各被至少 1 项用例抓到；执行器侧 3 个变异（从不传模式、回退也传模式、所有预设都传模式）分别使 5、3、5 项用例失败（在补入“无效候选”用例之前运行，当时该组 7 项）。
- 性能（草稿基准，inline 证据）：30 s 窗口（48 万采样）`conditionWhisperPcm16` 中位 17.6 ms、最大 18.2 ms；`conditionQuietPcm16` 中位 4.5 ms。

### 偏离

- 无功能性偏离。比设计多出的一条约束是“模式必须与 `conditionQuietAudio: true` 同时出现”（见上）。design.md 未修改（本任务无界面）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-03-1 | 通过 | inline:证据文件 records/T-ASRQ-03-unit.txt；`gatedQuietAudio.test.ts` 5 项、`quietAudioWindow.test.ts` 7 项、`quietAudio.test.ts` 4 项通过）。覆盖：采样数不变、样本不变号、源 Buffer 不被改写、数字静音段保持全 0、结果可重复；三个信号输出峰值 ≤ 29205（-1 dBFS 向上取整）；中等信号中距语音 ≥ 400 ms 的噪底区逐采样 \|输出\| ≤ \|输入\|×10^(6/20)+0.5，语音段增益与 g0 相差 < 0.5 dB，语音前 50 ms 与后 150 ms 的噪底增益与 g0 相差 < 1 dB；-65 dBFS 耳语窗口 `conditionQuietPcm16` 为 0 dB、门控为 30 dB 且各语音段提升 > 29.5 dB；含强瞬态的 -45 dBFS 窗口 `conditionQuietPcm16` 为 0 dB、门控 > 15 dB，避开点击 60 ms 的语音段增益与 g0 相差 < 0.5 dB，点击段增益不超过 20·log10(0.8913/0.5) dB（帧峰值限制起作用，而不只是软膝）；全静音、满幅方波、1 采样、100 与 7999 采样、只有 0.3 s 语音、正常电平（g0 < 3 dB）、恒定数字噪声原样返回同一对象；空/奇数/超长输入抛 `TypeError` |
| V-ASRQ-03-2 | 通过 | inline:证据文件 records/T-ASRQ-03-unit.txt；`productionExecutor.test.ts` 174 项通过，其中 “Studio gated quiet audio” 8 项；`quietAudioWindow.test.ts` 标准哈希 3 项与归一化器 2 项）。覆盖：quiet_whisper_v1 的窗口以 `{conditionQuietAudio: true, quietAudioMode: 'gated_v1'}` 物化，报告增益时请求带 `vadSpeechPadMs: 1000`；门控未提升（无增益）时用预设 300 ms 且不回退；门控候选过长（12 s）、重复（3 句相同）或无效（重叠段）时恰好回退原音一次（第二次物化为 `{conditionQuietAudio: false}`、填充 300 ms），结果只含原音文本；标准类型与 noisy_music_v1 的物化参数与之前完全相同（无 `quietAudioMode` 键）；分隔候选从不带模式。标准窗口（不调理与整窗调理）的文件哈希与改动前 68ffd05 写出的完全相同，门控窗口字节等于头部 + `conditionWhisperPcm16` 输出、品牌与解析结果带同一增益与哈希；非法模式被拒且不影响后续窗口 |
| V-ASRQ-03-3 | 通过 | inline:证据文件 records/T-ASRQ-03-static.txt；最后一次修改后：`copy.mjs --check` passed，120 文件；`transcript-executor-copy.mjs --check` passed；`shared-resource-integration.mjs` exact；`npx tsc --noEmit -p tsconfig.json` exit 0）；file:records/T-ASRQ-03-integration.txt（`test/subtitle-studio-provenance test/subtitle-studio/transcription test/subtitle-studio/transcription-preferences.test.ts`，另加 `boundaries.test.ts`、`transcription-runtime-lifecycle.test.ts`、`test/asr-quality`：57 文件通过、6 跳过，1182 项通过、8 跳过，exit 0；含 `replay.test.ts` 20 项旧版对拍、`transcript-executor-replay.test.ts` 23 项、`current-copy-audits.test.ts` 11 项。跳过的是需要环境变量的真实运行/UI/A-B 用例 |

补充（不属于验证计划，不作为质量结论）：file:records/T-ASRQ-03-real-gain.txt，对 `test-results/subtitle-quality-review/` 的 5 段只读样本按 30 s 窗口离线比较两种增益（无模型、无服务）。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-01-2 | 通过 | V-ASRQ-03-2 |
| AC-ASRQ-02-1 | 通过 | V-ASRQ-03-1 |
| AC-ASRQ-02-2 | 通过 | V-ASRQ-03-1 |
| AC-ASRQ-02-3 | 通过 | V-ASRQ-03-2 |
| AC-ASRQ-02-4 | 通过 | V-ASRQ-03-2, V-ASRQ-03-3 |

## 风险与未执行项

- AC-ASRQ-01-2 说明：门控增益部分：quiet_whisper_v1 的窗口以 gated_v1 调理；请求字段部分见 records/T-ASRQ-02.md

- 真实样本上的门控效果有限（`T-ASRQ-03-real-gain.txt`）：这几段日语 ASMR 素材的活动帧占 59–69%，加上 100/250 ms 保持后 81–97% 的帧拿到完整 g0，只有 2–16% 的帧被限制在 6 dB。负对照 B-noise 被门控提升 15.2 dB（80.8% 的帧），高于现有整窗策略的 12 dB；independent 各窗口 17.6–22.4 dB（现有 12 dB）。反之，低音量样本 B 的活动电平第 80 百分位为 -32.7 dBFS，门控只给 9.7 dB，低于现有的 12 dB。这只是电平统计，不是识别质量结论：B-noise 是否新增文字、预设是否推荐，由 T-ASRQ-09 的 A/B 与用户听审决定。按需求“不做开放式调参”，本任务没有调整任何参数。
- 帧峰值已高于 -1 dBFS 的帧按公式得到负增益（被轻微衰减），属于按设计原样实现；如果认为应该“只提升不衰减”，需要改设计。
- 模式校验比现有 `conditionQuietAudio` 更严（必须同时为 true）。仓库内调用方只有执行器；T-ASRQ-01 的 `test/asr-quality/ab-comparison-harness.ts` 只是包装并原样转交，未受影响（`test/asr-quality` 用例已随集成运行通过）。
- 标准窗口哈希常量依赖 `quietAudioSignals.ts` 的生成器；以后若改生成器，必须用改动前的实现重新计算这些常量（同内容的旧版 `electron/main/local-subtitle/pcm-window.ts` 受 boundaries 规则限制，不能从 `test/subtitle-studio/` 导入）。
- 未在真实模型或 whisper-server 上运行门控路径（不在本任务验证计划内，属于 T-ASRQ-09）。用户允许下载到 D 盘的 3 个模型用于 T-ASRQ-10，本任务没有下载。
- 未提交。`transcript-executor.ts`、`productionExecutor.test.ts`、`current-copy-audits.{mjs,json}` 同时包含 T-ASRQ-02 与本任务的改动，审计哈希按合并后的内容登记，两者需要一起提交（或按顺序提交并重新登记）。T-ASRQ-04 修改 `subtitle-post-processor.ts` 时需再加一个所有者（条目数 9）。
