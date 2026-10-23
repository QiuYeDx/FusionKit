# 实施记录：T-ASRQ-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-01 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。本任务只新增文件：`test/asr-quality/ab-config.ts`、`test/asr-quality/ab-report.ts`、`test/asr-quality/ab-report.test.ts`、`test/asr-quality/ab-comparison-harness.ts`、`test/asr-quality/ab-comparison.test.ts`、本记录与 `records/T-ASRQ-01-{unit,integration,skip,smoke}.txt`；未改动任何已有文件（含审计文件、`scripts/subtitle-studio/boundaries.json`） |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；NVIDIA GeForce RTX 4070 Ti SUPER 16 GB（驱动 610.88）；内置运行时 `build/subtitle-studio-resources/transcription`（whisper.cpp v1.9.1，运行时代 3a2ac09dfc9b…，含 FFmpeg）；已安装资源只读使用：`%APPDATA%/FusionKit/speech-resources` 下的 large-v3（SHA-256 64d182b4…）、Silero VAD v6.2.0、CUDA 12.4 包（包代 96eee2a1…）。运行时工作树同时含并行任务 T-ASRQ-02 未完成的改动 |
| 任务指纹 | e37ff9c87dbd52c78a432b5792da9edce352507ec1a830ab63846668e9fd6ce7 |

## 实际结果

### 组成

| 文件 | 内容 |
| --- | --- |
| `ab-config.ts` | 纯函数：样本目录、变体、预算、环境变量解析与门控。6 段既有样本沿用 T08 的路径、字节数与 SHA-256；E 盘 3 段按文件名匹配（`drama`=`01.*.wav`，`pv-zh`=含 ` p01 ` 的 mp4，`pv-ja`=含 ` p02 ` 的 mp4），必须恰好匹配 1 个文件，否则记为缺失 |
| `ab-report.ts` | 纯函数：SRT、时间格式、按时间重叠对齐、置信度分布、请求字段统计、听审区间，以及 summary.md / diff.md / listening.md 的生成 |
| `ab-comparison-harness.ts` | 真实运行：组装、观测、清理、写文本产物 |
| `ab-comparison.test.ts` | `it.runIf(FUSIONKIT_ASR_AB === '1')` 门控；harness 动态导入，未设变量时不加载任何原生模块；输出目录用 `createTestRun`（含 `pruneStaleRuns`） |
| `ab-report.test.ts` | V-ASRQ-01-1 的 19 个单元测试 |

运行方式（默认值即任务要求）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FUSIONKIT_ASR_AB` | 未设置即跳过 | 必须为 `1` |
| `FUSIONKIT_ASR_AB_SAMPLES` | `A,B,C,B-noise,independent,full,drama,pv-zh,pv-ja` | 未知名称直接报错，不静默跳过；缺失的样本记为“缺失”，不算通过 |
| `FUSIONKIT_ASR_AB_VARIANTS` | `standard,quiet_whisper_v1,noisy_music_v1` | |
| `FUSIONKIT_ASR_AB_MODEL` | `large-v3` | 指定下载文件时默认取文件名（去掉 `ggml-` 与 `.bin`） |
| `FUSIONKIT_ASR_AB_MODEL_PATH` | 无 | 下载的模型文件（供 T-ASRQ-10） |
| `FUSIONKIT_ASR_AB_DEVICE` | `cuda` | 额外提供 `cpu` |
| `FUSIONKIT_ASR_AB_RESOURCE_ROOT` / `FUSIONKIT_ASR_AB_EXTERNAL_ROOT` | `%APPDATA%/FusionKit/speech-resources` / `E:/workspace/fusionkit` | 额外提供，便于换机 |

语言按样本固定（`pv-zh` 为 zh，其余 ja）；其他任务配置取 Studio 默认 `DEFAULT_STUDIO_TRANSCRIPTION_CONFIG`（VAD 开、按停顿切窗、束宽 5、温度 0、最短静音 500 ms），变体只在 `advanced.audioProfile` 上不同。

### 生产路径与只读资源

- 每个样本 × 变体新建一个 `createTranscriptionRuntime`（`runtime.ts` 的生产组装：任务服务与 `freezeConfig`、`TranscriptionExecutor`、`LocalSubtitleMediaNormalizer` + 内置 FFmpeg、`LocalSubtitleServerSupervisor` + whisper-server、生产 CUDA 证明器、`createStudioSharedResources` 及其只读 CUDA 校验器），结束时 `shutdown`，因此每个组合都是新的服务进程；JSON 记录进程 PID 并在清理后确认已退出。
- 唯一替换的是应用级 `SpeechResourceService`：换成只读的替身，只返回固定的已安装文件（开始时按目录校验字节数与 SHA-256，每次解析再比对文件身份），安装、导入、删除一律拒绝。没有采用 `real-default-resource-fixture.ts` 的做法（用生产管理器把模型、VAD、CUDA 包复制安装到临时根目录），因为本任务要求只读使用已安装资源，且每次复制 3 GB 模型没有必要；替身的接口面与 T09 共享资源对拍时传入真实服务的位置一致。
- 运行结束时重新哈希全部样本，并比对模型、VAD、CUDA 包每个文件的大小、mtime、dev、ino；任一变化即失败。
- 工作目录在 `%TEMP%/asrab-*`（运行时私有根、文档库、媒体临时文件、服务会话），每个组合结束后删除，整次运行结束再删根目录；`test-results/asr-quality-ab/<run>/` 下只有文本：每组合的 `.json` 与 `.srt`（无内容时为空 SRT）、`summary.md`、`diff.md`、`listening.md`、`report.json`。
- 下载模型（`FUSIONKIT_ASR_AB_MODEL_PATH`）：whisper-server 只从一个受管根目录加载模型与 VAD，因此把下载的模型、已安装 VAD 和 CUDA 包**复制**到临时私有根（逐个核对哈希），运行后删除。没有用硬链接：硬链接会改变已安装文件的链接数与 ctime，可能影响应用对已安装包的校验。

### 观测与报告

- 请求字段：对每次 `beginInference` 的请求调用生产的 `createLocalSubtitleServerInferenceFields`（HTTP 客户端发送前用的同一函数），记录实际 multipart 字段名与值。请求类型沿用 T08：分句租约为“分句候选”，温度不为 0 为“质量重放”，其余为“识别”。
- 每个窗口：起止时间、请求的低音量调理方式（`whole_window` / `off`，T-ASRQ-03 加入 `quietAudioMode` 后记录其值）、实际增益、服务返回的语言、段数、耗时。耗时分为总计（入队到结束）、归一化、加载（批次固定 + 租约）、识别。
- 字幕取自新文档的 `preservation.transcript.segments`（与文档字幕一一对应，代码中断言），有置信度时一并记录（T-ASRQ-04 之后）。
- 变体判定：`transcriptionTaskConfigSchema` 不接受该 `audioProfile` 时记为“未实现”而不运行；接受但没有任何识别请求带 `vad_threshold` 时在摘要中列为“未生效”。
- 对齐（diff.md）：两条字幕重叠达到较短一条的 50% 视为同一句；其余字幕若与对方重叠不少于 min(300 ms, 较短一条的 30%) 则并入重叠最多的那句，否则记为新增/消失；同组文字（去空白与标点、NFKC）不同为“改变”，相同但标点、断句或边界（>250 ms）不同为“细微”，单独列表并注明是哪一种。
  - 决定与原因：初版只用“重叠 ≥ min(300 ms, 30%)”一条规则；真实运行中不同变体的句边界会移动 0.5–1.3 s，A 样本的 5 句被连成一个 24 s 的“改变”组。改成两轮匹配后，同一次运行只剩 1 句“改变”；这组真实时间已写成单元测试。
- listening.md：只列改变/新增/消失，前后各留 0.5 s，相距 1 s 内合并，注明样本文件路径与各变体文字，最后一列“听审结论”留空由用户填写。
- summary.md 的“复核标记”列在 T-ASRQ-05 之前显示“未实现”；B-noise 每个变体的文字单列一节。

### 与设计、任务说明的差异

1. 额外的环境变量 `FUSIONKIT_ASR_AB_DEVICE`、`FUSIONKIT_ASR_AB_RESOURCE_ROOT`、`FUSIONKIT_ASR_AB_EXTERNAL_ROOT`，默认值与任务一致。
2. 资源用只读替身而不是 T08 的资源安装夹具（原因见上）。
3. 另写 `report.json`（整次运行的汇总，不含逐请求明细），便于 T-ASRQ-09 读取。
4. SRT 由 `ab-report.ts` 按应用导出的格式生成（并有单元测试），没有调用 `formatLocalSubtitleSrt`，以免 T-ASRQ-04 修改段结构时把工具一起卡住。
5. 复核标记数暂缺，等 T-ASRQ-05 的规则模块后由 T-ASRQ-09 接上（其写集含 `test/asr-quality/`）。
6. `test/asr-quality/` 不是 `boundaries.json` 的根目录，边界测试不检查它，因此未登记；`boundaries.test.ts` 仍通过（见 skip 记录）。

### 补充冒烟（工具自检，不是质量证据）

见 `file:records/T-ASRQ-01-smoke.txt`。

1. A 与 B-noise × 三个变体：预设字段被识别（`vad_threshold` 等），对齐、差异与听审清单按句给出。**提醒 T-ASRQ-09 / 协调者**：在这个尚未完成的工作树上（T-ASRQ-03 门控增益未实现，B-noise 窗口为整窗增益 12 dB + 1000 ms 填充），B-noise 在 quiet_whisper_v1 与 noisy_music_v1 下都输出了「しっかりと、うらやまして」（00:02–00:06），standard 无文字。只跑了一次，不作结论，但它直接关系到 AC-ASRQ-07-2。
2. 下载模型覆盖：D 盘的 turbo q8_0 在 A 上完成识别（含一次 VAD 关闭的分句候选请求），两个进程都已退出，临时资源根已删除。
3. E 盘外部样本 `pv-zh`（mp4，文件名含 CJK 与全角字符，zh）：235 s、10 个窗口、76 句，样本哈希前后一致。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-01-1 | 通过 | inline:证据文件 records/T-ASRQ-01-unit.txt；`npx vitest run --maxWorkers=4 --minWorkers=1 --reporter=verbose test/asr-quality`：19 passed，门控用例 1 skipped |
| V-ASRQ-01-2 | 通过 | inline:证据文件 records/T-ASRQ-01-integration.txt；`FUSIONKIT_ASR_AB=1`、standard、A 与 B-noise：A 完成 5 句、B-noise 无内容；两个组合各 1 个服务进程，均证明为 CUDA 且清理后已退出；`cleanup` 均为 joined/processesExited/workRemoved；`failures=[]`、`sourcesUnchanged=true`、`workRemoved=true`；运行目录只有 8 个文本文件、0 个子目录；`%TEMP%` 下无 `asrab-*` 残留 |
| V-ASRQ-01-3 | 通过 | inline:证据文件 records/T-ASRQ-01-skip.txt；未设置 `FUSIONKIT_ASR_AB` 时该用例状态为 skipped；同时运行 `test/asr-quality` 与 `test/subtitle-studio/boundaries.test.ts`：27 passed、1 skipped |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-07-1 | 通过 | V-ASRQ-01-1, V-ASRQ-01-2, V-ASRQ-01-3 |

## 风险与未执行项

- 补充检查：类型检查（补充），通过，inline：`tsconfig.json` 不包含 `test/`，另用临时配置（继承 `tsconfig.json`，include `test/asr-quality/*.ts`）运行 `npx tsc --noEmit -p <临时配置>`，退出码 0
- AC-ASRQ-07-1 说明：工具部分完成（每变体 SRT、请求统计、耗时、按时间对齐的差异报告均已在真实运行中产出）；“6 段既有样本与 E 盘样本 × 三变体各运行一次”由 T-ASRQ-09 在集成版本上执行

- 未运行全部 9 段样本 × 三变体（属于 T-ASRQ-09）；`drama`、`pv-ja` 只确认能唯一匹配到文件，尚未真实运行。
- 上述 B-noise 在两个预设下出字的早期信号（见补充冒烟 1），需在 T-ASRQ-02/03 完成后的集成版本上复核。
- 只读替身依赖 `runtime.ts` 与 `shared-resources.ts` 当前使用的 `SpeechResourceService` 接口面；T-ASRQ-07 等改动 `runtime.ts` 若用到更多接口，需要同步补齐替身（会以“方法不存在”报错，不会静默）。
- 观测是给原型方法打补丁，组合按顺序执行；不要与其他会启动 Studio 转写运行时的测试放在同一个 vitest worker 中并行运行。
- 请求类型按温度区分：温度为 0 的“回退原音重识别”会显示为同一窗口上的第二个“识别”请求，而不是“质量重放”。
- 加载耗时受文件缓存与 GPU 状态影响（同一配置观测到 4.3–10.7 s），不宜作为性能结论。服务返回的窗口语言是原始值（B-noise 空结果返回过 `english`），仅供参考。
- `pruneStaleRuns` 会在下次运行时删除一小时前的旧运行（保留最新一个）；T-ASRQ-09 需把结论写进 record，或设置 `FUSIONKIT_KEEP_TEST_RUNS=1`。
- 本次真实运行使用含并行任务未完成改动的工作树；standard 在 A 上 4 次运行得到相同的 5 句，只是观察，不替代 T-ASRQ-02 的回放与请求字段测试。
- 未运行 provenance 与仓库级 `npx tsc --noEmit -p tsconfig.json`：本任务没有改动任何受审计文件或 `src/`、`electron/` 下的文件。
