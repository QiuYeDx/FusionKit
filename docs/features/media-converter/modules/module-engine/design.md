# engine 设计

本文详细设计当前增量 I1。I2 的采样与测量（R-ENGINE-08）和 I4 的 macOS 引擎（R-ENGINE-09）只在需求中写了方向，进入对应批次前再细化。2026-10-26 的评审结论已并入本文，对照见 [records/spec-review-2026-10-26.md](../../records/spec-review-2026-10-26.md)。

## 现状与约束

**ffmpeg 来源（Windows）**

- 打包后位于 `resources/subtitle-studio/transcription/win-x64/media/ffmpeg.exe` 与 `ffprobe.exe`；开发时位于 `build/subtitle-studio-resources/transcription/...`（已加入 gitignore，需要先暂存）。运行时清单是 `manifests/subtitle-studio-runtime.v1.json`。
- 校验入口：`electron/main/subtitle-studio/transcription/native/resource-path.ts:312` 的 `verifyLocalSubtitleRuntimeBundle({environment, scope, signatureVerifier?})`，返回带品牌标记的 `LocalSubtitleVerifiedRuntimeBundle`（含 `artifactPaths`、`runtimeGeneration`）。
- 版本固定在 `media-normalizer.ts:83` 的 `LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions`。
- 复用先例：`electron/main/subtitle-studio/cue-audio-clip.ts:21` 的 `selectCueAudioFfmpeg`。

**现有进程封装不适合长时间编码**

`media-process.ts:110` 的 `runLocalSubtitleMediaProcess` 有以下限制：

- stdin 为 `ignore`；
- stderr 超过上限时会终止进程；
- 超时上限 12 h；
- 不能设置优先级。

其中 `buildLocalSubtitleMediaEnvironment`（`:70`）可以复用。它生成精简环境：PATH 只含 media 目录与 System32。

**冻结副本**

`transcription/native/*` 由 `resources/subtitle-studio/provenance/transcription-fork.json` 约束，只能 import，不能修改。可以复用的导出有：

- 拖放还原：`electron/main/subtitle-studio/drop-input-service.ts:10` 的 `resolveDroppedInputPaths`。它返回字幕工作台的错误码（`access_denied` / `invalid_input` / `document_unavailable`）；当同一批中有无法还原的 `%TEMP%` 路径时，它会把整批拒绝。
- 文件身份：`filesystem-object-identity.ts` 的 `localSubtitleFilesystemObjectIdentityForPath` / `ForHandle` 与 `sameLocalSubtitleFilesystemObjectIdentity`。Windows 上的身份是「卷序列号 + 128 位 FileId」；比较函数会把全零 FileId 也当作有效值。

**其他可复用的模式**

- 发布模式参考 `electron/main/subtitle-studio/export-service.ts`：用 `open(...,'wx+')` 占位并记录身份，发布或删除前再次核对身份（`:41-42`、`:57`、`:76-77`）。
- 诊断脱敏参考 `electron/main/local-subtitle/server-diagnostics.ts:437-446` 的路径脱敏模式。
- IPC 范式参照长文本翻译：`src/long-text/channels.ts`（只依赖 zod）与 `electron/preload/long-text-api.ts`；遗留桥的前缀拦截要同时写进 `assertLegacyIpcChannelAllowed` 与 `assertLegacyListenChannelAllowed`；主进程用 `electron/main/fs/trusted-sender.ts:13` 的 `isTrustedAppSender` 再加一次主窗口比对；结果统一为 `{ok:true,value} | {ok:false,error:{code}}`。
- 关停：`electron/main/index.ts` 中 `createSharedResourceApplicationShutdown({runtimes:[...]})` 统一处理 `app_quit` 与 `update`。
- 原子写：`electron/main/translation/atomic-file.ts:14` 的 `atomicWriteUtf8File`。

**本机实测得到的约束**

- 随附构建编译了 `schannel`、`srt`、`rist`、`ssh`、DASH（libxml2）。播放列表类解复用器即使只用 `file` 协议，也会打开其中引用的其他本地文件或 UNC 路径。
- `-n` 写入一个已存在的文件时，ffmpeg 输出「already exists」后以 0 退出，不产生任何进度。
- `+faststart` 在写尾部时会重写整个文件，这段时间没有进度输出。
- `-loglevel error` 会隐藏这几类关键警告：`auto-selecting format`（像素格式被静默替换）、kvazaar 与 SVT 的 `Invalid option`/`Error parsing option`、`only the last -af`。
- NVENC 的最小帧宽约为 144（108×192 与 128×128 失败；144×256 与 160×120 成功）。
- MF 硬件编码器只接受 nv12 输入。

**已知坑**

- FK-PIT-0023：只用随附的 ffmpeg。
- FK-PIT-0036：Windows 工作目录要短，stdio 要显式设置。
- FK-PIT-0040：进度用有界的行解析。
- FK-PIT-0042：探测元数据不可信，需要 `-t`/`-fs` 上限。
- FK-PIT-0044：先写 `.partial`，再以不覆盖的方式发布。
- FK-PIT-0071：Windows 上 `rm` 要重试。
- FK-PIT-0077：进度 IPC 要节流。
- FK-PIT-0099：拖放路径的权威来源。

## 方案与取舍

### 1. 运行时（R-ENGINE-01）

`engine/runtime.ts` 提供 `MediaRuntime.acquire(): Promise<MediaTools>`，步骤如下：

1. 调用 `verifyLocalSubtitleRuntimeBundle({environment, scope:"media"})`。`environment` 与 `subtitle-studio/index.ts:72` 的构造方式相同。
2. 在 `artifactPaths` 中各取唯一一个 `kind:"ffmpeg"` 和 `kind:"ffprobe"`。两者必须在同一目录，版本与固定版本一致。
3. 运行 `ffmpeg -hide_banner -version`，核对第一行版本号。
4. 缓存校验结果。每次使用前用 `lstat` 比对体积与修改时间，有变化就重新校验；出现 `spawn_error` 时也重新校验一次再重试。

在 macOS 上，`registerMediaConverter` 照常注册全部通道，但每个处理函数都直接返回 `platform_unsupported`。预加载用 `process.platform === "win32"` 导出同步常量 `supported`。

**取舍：** 不新增打包内容，体积和许可证义务（LGPL）都不变。代价是转换工具的 ffmpeg 版本跟随转写运行时，升级时两边要一起评审。另外，转换工具是第一个把这个构建中的外部编码器（libopenh264、libkvazaar、原生 aac、libmp3lame、libopus 等）直接交给用户使用的功能。仓库中尚未关闭的 QA-005（Windows 外部库声明、BtbN 提交 ce3c09c1 的源码提供、编解码专利审查）因此覆盖面更大了，见 spec.json 的 Q-04。

### 2. 探测（R-ENGINE-02）

`engine/probe.ts` 的处理顺序如下。

**1. 预检。** 扩展名为 `.m3u8`、`.m3u`、`.mpd`、`.ffconcat`、`.sdp`、`.txt` 时直接拒绝。读取文件头 10 字节，识别 SILK（`#!SILK_V3`，以及前面多一个 `0x02` 的变体）。

**2. 主探测。**

```
ffprobe -hide_banner -v error -format_whitelist <ALLOWED_DEMUXERS> -protocol_whitelist file \
  -show_format -show_streams -show_chapters -show_error -of json file:<path>
```

`ALLOWED_DEMUXERS` 是代码常量，只包含真实媒体容器的解复用器短名：`mov`、`matroska`、`avi`、`asf`、`flv`、`mpegts`、`mpeg`、`mp3`、`aac`、`wav`、`flac`、`ogg`、`aiff`、`ape`、`amr`、`ac3`、`eac3`、`dts`、`caf`、`wv`、`tta`、`rm`、`mxf`、`w64`、`mpegvideo`、`h264`、`hevc`。`hls`、`dash`、`concat`、`sdp`、`tee`、`image2`、`*_pipe`、`lavfi` 不在其中。报错 `Format not on whitelist` 时，原因码为 `container_not_allowed`。

**3. HDR10 静态元数据（仅当传递特性为 PQ/HLG）。** 用 `-f <已探测的解复用器>` 固定解复用器，读取首帧：`-select_streams V:0 -read_intervals %+#1 -show_frames -show_entries frame=side_data_list`，取得 Mastering Display 与 Content Light Level。

**4. 规范化为 `MediaInfo`**（类型定义在 `src/media-converter/contract.ts`）：

- `container`：`{demuxer, formatName, majorBrand?, matroskaDocType?, extension, identity}`。`identity` 由以下规则推出：
  - `major_brand` 为 `qt  ` → `mov`；
  - `isom`、`iso2`、`mp41`、`mp42`、`avc1` → `mp4`；
  - `M4A `、`M4B ` → `m4a`；
  - Matroska 的 DocType 区分 `webm` 与 `matroska`；
  - 以上都没有时按扩展名推断。
- `kind`：`video`、`audio`、`unsupported`。主视频流按 `V` 选择器的语义选取，排除 `attached_pic` 和 `avg_frame_rate=0/0` 的流。
- 时长：依次取 `format.duration`、流的 `duration`、`tags.DURATION`。音频码率缺失时取 `tags.BPS`。
- `bitDepth`：由像素格式描述表推出。`rotation`：取 Display Matrix，规范化到 0/90/180/270。`isVfr`：`r_frame_rate` 与 `avg_frame_rate` 相差超过 0.5% 时为真。
- `hdr`：
  - 杜比视界从流级侧数据 `DOVI configuration record` 读取，与传递特性无关。`dv_profile` 为 5，或 `dv_bl_signal_compatibility_id` 为 0 时，记为 `dolby_vision`，`compatible=false`。
  - 其他情况按传递特性判断：`smpte2084` 为 `hdr10`，`arib-std-b67` 为 `hlg`，否则为 `none`。
- 字幕：
  - 文本类：`subrip`、`ass`、`ssa`、`webvtt`、`mov_text`、`text`；
  - 图形类：`hdmv_pgs_subtitle`、`dvd_subtitle`、`dvb_subtitle`、`xsub`。
  - 对 ASS/SSA 字幕，额外抽取最多 200 条事件，检查是否含 `\pos`、`\move`、`\an`、非默认样式或时间重叠，结果记为 `styled`。不能抽取时，按 styled 处理。
- 附件数量（`codec_type=attachment`）。

**并发与缓存。** 探测并发上限为 4（信号量）。探测结果按身份缓存；身份不可用（例如 FileId 全零）时，退回「规范化路径 + 体积 + 修改时间」。

### 3. 能力探测（R-ENGINE-03）

`engine/capabilities.ts` 分两部分：软件能力和编码器实测。

**软件能力：** 解析 `-encoders`、`-muxers`、`-filters`。

**编码器实测：** 对每个候选编码器，以及它在 encode 模块中可能用到的每组（位深, tune），用真实参数做一次测试：

1. 参数来源：调用 encode 模块的 `probeArgs(encoder, variant)`。它与 `toFfmpegArgs` 共用参数表，保证测试的就是生产参数。
2. 测试命令：

   ```
   ffmpeg -hide_banner -loglevel level+warning -nostdin -f lavfi -i color=black:s=1280x720:r=30 -frames:v 3 \
     <probeArgs> -f matroska -y file:<work>/probe-<enc>-<variant>.mkv
   ```

3. 判定：退出码非 0，或 stderr 出现 `auto-selecting format`、`Invalid option`、`Error parsing option`，均判为失败。成功时再用 ffprobe 核对 `codec_name`、`pix_fmt`、`profile`，不符合预期按 `params_rejected` 处理。

候选顺序如下：

| 序号 | 编码器 | 位深 |
| --- | --- | --- |
| 1 | `h264_nvenc` | 8 |
| 2 | `hevc_nvenc` | 8 与 10，各测 `uhq`、`hq` 两种 tune |
| 3 | `av1_nvenc` | 10，各测 `uhq`、`hq` |
| 4 | `*_qsv`、`*_amf` | 同上 |
| 5 | `h264_mf` 硬件 | nv12 |
| 6 | `hevc_mf` 硬件 | nv12 |
| 7 | `h264_mf` 软件 | nv12 |

**失败分类：**

| stderr 特征 | 类别 |
| --- | --- |
| `Driver does not support the required nvenc API version` | `driver_too_old` |
| `No capable devices found`、`MFX session` | `no_device` |
| `amfrt64.dll`、`could not find any MFT` | `runtime_missing` |
| `OpenEncodeSessionEx failed: out of memory`、`incompatible client key` | `session_limit` |
| `InitializeEncoder failed: invalid param`、`auto-selecting format`、ffprobe 核对不符 | `params_rejected` |
| 其他与超时 | `unknown` |

**执行方式：** 串行，以低优先级运行；单项超时 15 s，总预算 30 s，超出预算的候选记为 `unknown`。

**缓存（`capabilities.json`，原子写）：**

- 键是 ffmpeg 版本加显卡信息。显卡信息取 `app.getGPUInfo('basic')` 中的显卡厂商/设备 ID 与驱动版本（实现时以实测字段为准）。取不到驱动信息时，键只用 ffmpeg 版本，缓存 7 天后过期。
- 只持久化确定的结论：可用、`driver_too_old`、`no_device`、`runtime_missing`、`params_rejected`。`session_limit`、`unknown` 和超时只在本会话有效。
- 有硬件编码任务运行时，「重新检测」不可用。

**输出：** `Capabilities` 是 encode 模块 `plan/types.ts` 中定义的 `PlannerCapabilities`，引擎负责产出它。内容包括：

- 每个编码器在各种（位深, tune）下是否可用；
- `uhq` 是否可用；
- NVENC 最小宽高前置条件，取实测值：宽 ≥ 144、高 ≥ 120；
- 会话内的降级集合。

**取舍：** 测试只用 3 帧，每个约 0.3–0.7 s。它比「只看 `-encoders`」可靠得多，并且发现了评审中实测到的问题：`hevc_nvenc` 用 `uhq` 加 `-bf 3` 会被驱动拒绝；`hevc_mf` 的 10-bit 会被静默降为 8-bit。

### 4. 进程封装（R-ENGINE-04）

由 `engine/process.ts` 与 `engine/progress.ts` 实现。

**启动**

- 调用 `spawn(ffmpeg, args, {cwd, env, shell:false, windowsHide:true, stdio:["ignore","pipe","pipe"]})`，不使用 `detached`。
- Windows 上，libuv 把子进程放进「关闭即终止」作业对象，Electron 崩溃时 ffmpeg 也会结束。macOS 上没有这种保证，见 R-ENGINE-09。
- `env` 用 `buildLocalSubtitleMediaEnvironment` 生成，临时目录指向 `userData/media-converter/work/<id>`。

**优先级与低占用模式**

- `spawn` 事件后立即执行 `os.setPriority(pid, PRIORITY_BELOW_NORMAL)`。
- 开启低占用模式时：
  - 优先级用 `PRIORITY_LOW`（Windows 上即 IDLE）；
  - 再执行一次 PowerShell `(Get-Process -Id <pid>).ProcessorAffinity = <mask>`，把 CPU 亲和性限制在约一半的逻辑核上。混合架构 CPU 优先选编号靠后的核，通常是能效核；
  - SVT-AV1 附加 `lp=1`。

  这里不依赖 SVT 的 `lp`/`pin`，因为 `lp` 是「并行级别」，并不能限制线程数。
- 设置失败只记录日志，任务照常进行。

**统一参数前缀**

```
-hide_banner -nostdin -nostats -loglevel level+warning -stats_period 0.5 -progress pipe:1
```

每个输入写成 `-f <demuxer> -protocol_whitelist file -i file:<path>`。

**进度解析**

- 按 `key=value` 逐行解析，每行上限 16 KB。一个进度块以 `progress=continue|end` 结束。
- 需要兼容的情况：`out_time_ms` 的值实际是微秒；`speed`、`bitrate` 带前导空格；值可能是 `N/A`。
- 输出 `{outTimeUs, totalSize, speed, fps, frame, ended}`。

**stderr**

- 在内存中用 256 KB 环形缓冲保存。
- 提供 `redactedTail(maxBytes)`，供外部取用脱敏后的日志尾部。脱敏规则：已知的输入路径、临时文件路径、输出路径、工作目录路径（带或不带 `file:` 前缀）分别替换为 `<input>`、`<output>`、`<work>`；其余绝对路径按 `server-diagnostics.ts` 的模式处理。

**停滞判定**

每 10 s 检查一次，按阶段区分：

| 阶段 | 判定 |
| --- | --- |
| `before_first_output`：还没有 `frame > 0` 的进度 | 超过 300 s 判为停滞；低占用模式下为 600 s |
| `encoding` | 120 s 内 `outTimeUs` 与 `totalSize` 都没有增长 |
| `finalizing`：`outTimeUs` ≥ 预期时长 − 1 s | 预算为 120 s + `totalSize` ÷ 20 MB/s |

超过阈值时终止进程，错误码 `encoder_stalled`。

**取消**

- Windows：`child.kill()`，即 TerminateProcess。
- 等到 `close` 事件后再清理文件。

**成功判定**

同时满足 AC-ENGINE-04-5 的全部条件才算成功。几种特殊情况：

- `-fs` 截断时 ffmpeg 仍报告成功，所以要判断 `totalSize` ≥ 上限 − 64 KB，命中即视为触顶。
- stderr 出现 `No space left on device` 或进程报 `ENOSPC`：记为 `disk_full`。
- stderr 出现 `already exists` 或 `Error opening output file`：记为 `output_open_failed`。

**超长滤镜**

单个流的滤镜超过 8 KB 时，写入 `work/<id>/filter-v0.txt`，改用 `-/filter:v:0 <file>`（音频用 `-/filter:a:N`），避免 Windows 命令行 32,767 字符的上限。`-/filter_complex` 留给 I2 的多输入滤镜图。

### 5. 执行器（R-ENGINE-03/04/06）

`engine/executor.ts` 负责把一个条目从头跑到尾，是 engine 与 encode 真正接在一起的地方。步骤如下：

1. 调用 `MediaRuntime.acquire()`。
2. 前置检查：
   - 输入文件的身份、体积、修改时间未变，否则为 `input_missing` 或 `input_changed`；
   - 目标路径不是任何输入（`output_is_input`）；
   - 同批的目标名冲突改为自动编号；
   - 目标目录可写；
   - 按卷汇总磁盘空间与输出上限的预留量；
   - 检查 FAT32 的 4 GiB 限制。
3. 对计划中的每个输出：
   - 在 `partials.json` 中记录临时文件，用 `wx` 占位并记录身份；
   - 用 `toFfmpegArgs` 生成参数，交给 `process.ts` 运行；
   - 按成功判定检查结果，并重新探测输出；
   - 压缩任务比较输出与源文件的体积（`not_smaller`）；
   - 发布，或清理临时文件。
4. 硬件编码器在第一个 `frame > 0` 的进度之前失败时：调用 `markDegraded(encoder)`，然后 `buildPlan(media, frozenSettings, currentCaps)` 重新生成计划，再试一次。计划摘要追加 `encoder_fallback {from, to}`。
5. 一个条目有多个输出（提取全部音轨）时，每个输出单独发布。全部成功时条目为 `succeeded`；有任何失败时为 `failed`，结果中列出已发布的输出，界面显示「部分完成 m/n」。

执行器通过接口注入 `runtime`、`process`、`output`、`clock`，便于测试。队列只依赖执行器的接口，单元测试中使用假执行器。

### 6. 队列与生命周期（R-ENGINE-05）

由 `queue/queue.ts`、`queue/state-store.ts`、`queue/types.ts` 实现。

**状态机**

```
idle → queued → running{phase} → succeeded | skipped{reason} | failed{code, partial?} | cancelled
idle/queued → input_changed | failed{input_missing}（运行前核对）
（应用重启）queued/running → interrupted → retry
unsupported{reason}（探测失败，不可开始）
```

- `phase`：`preparing` | `encoding` | `pass1` | `pass2` | `finalizing`；I2 增加 `analyzing`。
- `start {itemIds, settings, output, confirmed}` 的处理：
  1. 用 zod 校验请求；
  2. 对每个条目调用 `buildPlan`。计划要求确认（`lossy_to_lossless`）、但条目不在 `confirmed.lossyToLossless` 中时，返回 `confirmation_required`；
  3. 选择覆盖策略时，返回 `wouldReplace`（将被替换的已有文件显示名）供界面确认；
  4. 通过后冻结设置与计划，条目进入 `queued`。
- `retry {itemIds, override?}`：`override` 可以是 `not_smaller` 或 `already_target`，用于「仍然转换」。重试前重新探测，并重新生成计划。
- 调度：`concurrency` 取 1 或 2（默认 1），按顺序取出排队条目。条目进入运行前，再核对一次输入身份。

**队列选项**

`{concurrency, lowUsage}` 只保存在主进程的 `state.json`。

**持久化**

- `state.json` 的内容：条目、结果摘要（含脱敏后最多 16 KB 的日志尾部）、队列选项、最近 5 个输出目录 `{id, path}`、版本号。
- 写入防抖 500 ms，经 `atomicWriteUtf8File` 写盘。
- 启动时：`queued`/`running` 改为 `interrupted`；`idle` 条目重新核对身份。
- 条目上限 500，`state.json` 损坏时改名备份。

**事件**

- 事件为 `media-converter:changed {sequence, kind}`，`kind` 取 `items`、`progress`、`engine`、`options`、`batch-finished`。
- 进度按条目合并，每 250 ms 最多发一次。
- 渲染进程先取快照 `get-snapshot`，之后只应用 sequence 更大的事件。

**批次**

从队列由空闲转为运行开始，到没有排队或运行中的条目为止，算一批。一批结束时发出一次 `batch-finished {succeeded, failed, skipped, savedBytes}`。

**关停**

`registerMediaConverter` 返回 `{shutdown(reason)}`，在 `electron/main/index.ts` 中加入 `runtimes`。关停顺序：

1. 停止调度；
2. 取消运行中的条目；
3. 等待每个进程关闭，最多 4 s；
4. 删除临时文件；
5. 写盘。

**电源**

有条目运行时调用 `powerSaveBlocker.start('prevent-app-suspension')`，空闲或关停时停止。

**通知**

由渲染进程的控制器单例在 `batch-finished` 时发出：仅当 `document.hasFocus()` 为 false 时，调用 `showSystemNotification`（遵循通知设置）。

### 7. 输出发布（R-ENGINE-06）

由 `engine/output.ts` 实现。

**命名**

encode 模块给出基础名与扩展名。目录取源文件旁，或用户指定目录的 id 在主进程中映射出的路径。

**临时文件**

1. 生成 `.fusionkit-media-<8 位 hex>.partial`；
2. 先在 `partials.json` 中记录 `{path, volume, expectedName}`（原子写）；
3. 用 `open(path,'wx')` 占位，关闭后记录身份；
4. ffmpeg 以 `-f <muxer> -y file:<partial>` 写入，打开时截断，文件身份不变；
5. 发布或删除前核对身份。2-pass 日志放在 `work/<id>/`。

**发布（自动编号）**

- 先尝试 `fs.link(partial, candidate)`，`EEXIST` 时换下一个编号（最多 10,000 次）；成功后 `unlink(partial)`。
- `link` 返回 `EEXIST` 以外的任何错误时（exFAT 上实测为 `EISDIR`；也包括 `EPERM`、`ENOTSUP`、`EXDEV`），改走占位流程：
  1. `open(candidate,'wx')` 占位并记录身份；
  2. `rename(partial, candidate)` 替换占位文件；
  3. rename 失败时，只删除仍为 0 字节且身份未变的占位文件；
  4. FAT 卷上 rename 后，按体积核对结果。

**发布（覆盖）**

1. 开始前已向用户确认 `wouldReplace` 清单；
2. 发布时用 `shell.trashItem(existing)` 把旧文件移到回收站，失败则报 `overwrite_trash_failed`，不永久删除；
3. 再执行 `rename(partial, final)`。

被同一批中其他条目占用（已发布或已认领）的目标名不会被覆盖，改为自动编号并附 `output_name_collision`。

**防止覆盖输入**

开始前和发布前各检查一次：把目标路径与队列中所有输入逐一按身份比较。身份不可用时，比较规范化后的真实路径（不区分大小写）。

**输出上限与磁盘**

- encode 模块的 `outputCapBytes(plan, media)` 为每个输出给出硬上限：
  - 压缩任务且开启不变大保护：0.98 × 源体积。触顶即 `skipped{not_smaller}`，提前结束，节省时间。
  - 其他任务：见 encode 设计 §7。
- 每个输出带 `-fs <上限>`。探测时长已知时，再带 `-t <max(时长×1.05, 时长+10 s)>`。
- 开始前用 `fs.statfs(dir, {bigint:true})` 检查空间：剩余空间 ≥ 本卷所有运行中条目的上限之和 + 本条目上限 + 512 MB。
- 目标卷为 FAT32、且上限超过 4 GiB 时，拒绝 `file_too_large_for_volume`。卷类型用 `fsutil` 或 Win32 `GetVolumeInformation` 判断，实现时选其一。

**重试**

`rename`/`unlink`/`trashItem` 遇到 `EBUSY`/`EPERM` 时退避重试，最多 5 次，共约 2 s。

**启动清理**

逐条处理 `partials.json` 的记录：

- 卷未挂载：保留记录；
- 文件不存在：移除记录；
- 名称与身份都匹配：删除文件，成功后移除记录；
- 删除失败：保留记录。

然后用 `fs.rm(work, {recursive:true, force:true, maxRetries:5})` 清空工作目录。

### 8. IPC、预加载与输入授权（R-ENGINE-07）

**新建**

- `src/media-converter/channels.ts`：前缀、通道和事件 schema，只依赖 zod。
- `src/media-converter/contract.ts`：`MediaInfo`、`ConversionSettings`、`PlanSummary`、`ItemSummary`、`EngineStatus`、`QueueOptions` 的 schema，以及全部原因码的封闭枚举。
- `electron/preload/media-converter-api.ts`：
  - 拖放 API 接收 `File[]`，在任何 `await` 之前同步调用 `webUtils.getPathForFile`；
  - 导出 `supported`；
  - `onChanged` 用 schema 校验事件，不合格的丢弃。
- `electron/preload/media-converter-channel-policy.ts`。
- `electron/main/media-converter/ipc.ts`：信任判定为 `isTrustedAppSender(event) && event.sender === getWindow()?.webContents`，每个请求都 `safeParse`。
- `electron/main/media-converter/index.ts`：`registerMediaConverter({getWindow, environment, userDataPath, platform})`。

**修改**

- `electron/preload/index.ts`：在遗留桥的两个检查中加入前缀拦截，并调用 `exposeInMainWorld('mediaConverter', ...)`。
- `src/vite-env.d.ts`。
- `electron/main/index.ts`：注册，并加入关停。

**通道（I1）**

| 通道 | 请求 | 结果 |
| --- | --- | --- |
| `get-snapshot` | `{}` | `{sequence, engine, items, options, outputDirectories, resolvedEncoders, defaults:{compressCodec}}` |
| `add-dropped-files` | `{paths}`（只由预加载从 File 取得） | `{added, duplicates, rejected:[{displayName, code}], truncated}` |
| `pick-files` | `{filter: video\|audio\|all}` | 同上 |
| `pick-output-directory` | `{}` | `{directory:{id, displayName}}` 或取消 |
| `preview-plan` | `{itemId, settings}` | `PlanSummary` 或 `{code}` |
| `start` | `{itemIds, settings, output:{mode, directoryId?, conflict}, confirmed:{lossyToLossless: itemId[], replaceExisting: boolean}}` | `{started, needsConfirmation?:{lossyToLossless, wouldReplace}, rejected:[{itemId, code}]}` |
| `cancel` / `remove` | `{itemIds}` | `{affected}` |
| `retry` | `{itemIds, override?: not_smaller\|already_target}` | `{affected}` |
| `clear` | `{scope: finished\|all_idle}` | `{removed}` |
| `reveal-output` | `{itemId, outputIndex?}` | `{}` |
| `set-options` | `{concurrency?, lowUsage?}` | `options` |
| `redetect-capabilities` | `{}` | `{}` 或 `{code: busy}` |

`resolvedEncoders` 是按编码目标（av1/hevc/h264）× GPU 开关算出的实际编码器及其友好名，界面用它显示提示，不必在渲染进程里重复实现降级链。

**拖放封装（`engine/inputs.ts`）**

1. 调用 `resolveDroppedInputPaths(paths)`；
2. 整批被拒（`access_denied`）时：位于 `os.tmpdir()` 之外的路径按原样重新逐个校验并加入；`%TEMP%` 中的路径拒绝，代码 `temporary_copy_unresolved`；
3. 原因码映射：`invalid_input` → `not_a_regular_file`，`document_unavailable` → `file_unavailable`；目录 → `folder_not_supported`。

`inputs.ts` 只把显示名和文件夹名交给渲染进程。

**取舍：** 队列属于应用而不是窗口，所以按长文本翻译的模式，以「受信任的主窗口」为边界，不采用字幕工作台那种每个窗口一份能力令牌的模式。路径从不经过渲染进程的 JavaScript，错误日志也先脱敏。

### 9. 测试开关（只在测试中生效）

由 `electron/main/media-converter/test-hooks.ts` 实现。只有同时满足 `!app.isPackaged` 且以 `vite build --mode=test` 构建（判定方式与仓库中现有的 `FUSIONKIT_TEST_*` 开关一致，实现时以 `system/index.ts` 的做法为准）时才读取环境变量：

| 变量 | 取值 | 作用 |
| --- | --- | --- |
| `FUSIONKIT_TEST_MEDIA_CAPS` | `cpu_only` \| `nvenc` \| `unavailable:<code>` \| `detecting_ms:<n>` | 覆盖能力探测结果 |
| `FUSIONKIT_TEST_MEDIA_FAIL` | `<code>:first_attempt` | 每个条目的第一次运行注入失败，并附合成的 stderr 尾部 |
| `FUSIONKIT_TEST_MEDIA_REVEAL` | `record` | 「在文件夹中显示」改为记录调用，不真正打开 |

打包后一律忽略，并有单元测试证明。

## 代码落点

| 路径 | 作用 |
| --- | --- |
| `electron/main/media-converter/index.ts` | 注册与关停 |
| `electron/main/media-converter/ipc.ts` | 通道与信任 |
| `electron/main/media-converter/test-hooks.ts` | 测试开关 |
| `electron/main/media-converter/engine/runtime.ts` | 运行时校验与缓存 |
| `electron/main/media-converter/engine/probe.ts` | 预检、探测、规范化 |
| `electron/main/media-converter/engine/capabilities.ts` | 能力探测与持久化 |
| `electron/main/media-converter/engine/process.ts` | 进程封装、优先级与亲和性、停滞、脱敏 |
| `electron/main/media-converter/engine/progress.ts` | 进度解析（纯函数） |
| `electron/main/media-converter/engine/inputs.ts` | 输入登记、身份、拖放封装 |
| `electron/main/media-converter/engine/output.ts` | 临时文件、发布、覆盖、上限与空间、启动清理 |
| `electron/main/media-converter/engine/executor.ts` | 单个条目的完整执行 |
| `electron/main/media-converter/queue/queue.ts` | 调度、状态机、事件、电源、批次 |
| `electron/main/media-converter/queue/state-store.ts` | 持久化 |
| `electron/main/media-converter/queue/types.ts` | 队列类型 |
| `src/media-converter/channels.ts` | 通道与事件 schema |
| `src/media-converter/contract.ts` | 共享类型、schema、原因码枚举 |
| `electron/preload/media-converter-api.ts` | 预加载 API |
| `electron/preload/media-converter-channel-policy.ts` | 遗留桥拦截 |
| `electron/preload/index.ts` | 暴露（需重新登记审计 blob） |
| `electron/main/index.ts` | 注册与关停（需重新登记审计 blob） |
| `src/vite-env.d.ts` | Window 类型 |
| `scripts/subtitle-studio-provenance/current-composition-audits.json` | 审计 |
| `resources/speech-resources/provenance/current-integration-audits.v1.json` | 审计 |
| `test/media-converter/` | 单元、组件、集成测试 |

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-ENGINE-01 | §1：校验、选择与核对、macOS 统一返回 `platform_unsupported`、`supported` 常量 |
| R-ENGINE-02 | §2：预检、`-format_whitelist`、DOVI 流级识别、容器标识、ASS 样式检测、身份兜底、并发 |
| R-ENGINE-03 | §3：真实参数实测、`level+warning`、ffprobe 核对、分类、预算、持久化规则；§5：首包前失败时降级重试 |
| R-ENGINE-04 | §4：前缀与解复用器固定、优先级与亲和性、进度、分阶段停滞、取消、成功判定、触顶与磁盘写满、脱敏 |
| R-ENGINE-05 | §6：状态机、运行前核对、队列选项归主进程、持久化、批次、关停、电源；§5：执行器 |
| R-ENGINE-06 | §7：记录、占位、身份、硬链接与占位回退、回收站覆盖、批内冲突、上限、预留、FAT32、启动清理 |
| R-ENGINE-07 | §8：信任、zod、预加载同步取路径、拖放封装与原因码、脱敏、显示输出 |

## 验证与风险

**验证**

- **纯函数单元测试：**
  - 进度解析；
  - 探测规范化，夹具覆盖：竖屏、HDR10、HLG、DV5（传递特性未知）、DV8、VFR、封面、PGS、带样式的 ASS、TS 偏移、无时长、FileId 全零；
  - 容器标识；
  - 能力分类与持久化规则；
  - 脱敏；
  - 输出命名与冲突。
- **真实 ffmpeg 集成测试：** 以低优先级运行，素材是测试时生成的 2 s lavfi 小样。覆盖：
  - 运行时的四种错误；
  - 播放列表哨兵：引用目录外文件的播放列表被拒绝，调试日志中没有打开该文件；
  - 取消后清理；
  - 三个阶段的停滞判定（注入阈值）；
  - 优先级与亲和性回读；
  - 执行器全流程：发布、`not_smaller`、硬件失败降级重试（测试开关注入）、`disk_space_low`、触顶、`output_is_input`、批内冲突、两条音轨中第二条失败。
- **组合测试：** 预加载暴露、遗留桥拦截、注册与关停接线、darwin 下返回 `platform_unsupported`。之后运行审计检查。

**风险**

- **ffmpeg 升级联动：** 转写运行时升级 ffmpeg 时，转换工具的参数要一起复核。缓解：能力探测本身就用生产参数测试，参数被拒绝会表现为 `params_rejected`，不会让任务大面积失败；参数表有快照测试。
- **硬件差异：** 本机只能验证 NVENC。QSV/AMF 的生产参数靠真实参数测试兜底（被拒就跳过），校准要在 Intel/AMD 机器上完成。
- **网络盘与可移动盘：** 硬链接、回收站、文件身份在网络盘与可移动盘上的行为可能不同。已设计回退与按体积核对，但网络盘未实测。
- **CPU 争用：** 字幕工作台转写与转换可能同时运行。I1 只靠优先级与低占用模式缓解，不做跨模块调度。
- **许可：** 转换工具让 QA-005 的覆盖面变大（Q-04）。I1 开发不受影响，但发布前必须处理。
