# 媒体转换与压缩：调研与方案评估

日期：2026-10-26（调研于 2026-10-25 启动）

## 用户原始描述

> 可以着手开发v0.6.0版本了。我想在这个版本引入媒体格式转换工具，满足个人用户日常的便捷的高质量的音频、视频格式转换和大小压缩的需求。需要参考一下业界比较好的此类工具的实现 要求覆盖常见的媒体格式 压缩功能尤其是视频压缩更加重要 要做的好一些 尽可能在保留画质的前提下压缩更多空间（当然可以提供一些选项或配置，可以提供简单的选项（比如画质优先还是空间压缩优先之类的）和高阶用户可以用的配置（比率码率？动态码率？等等 总之可以尽可能用上业界一流的领先的技术来实现）可以先梳理清楚设计好 先写文档再开发

## 调研方法

9 路并行调研，均为只读：

| 方向 | 内容 |
| --- | --- |
| 代码 × 4 | 渲染进程（工具注册、页面组件、队列 UI、i18n）、主进程（ffmpeg 解析与校验、进程管理、IPC 安全、文件发布）、打包与许可（macOS/Windows ffmpeg 来源、打包契约、安装包体积）、项目约定（Spec 格式、测试、Agent 接入、发布流程） |
| 网络 × 4 | 业界工具（HandBrake、Shutter Encoder、Permute、ab-av1、Av1an 等 20 余款）、视频压缩技术（SVT-AV1、硬件编码器、VMAF 目标、目标大小）、音频转换（Opus/AAC/MP3、元数据、响度）、ffmpeg 工程实践与许可 |
| 本机实测 × 1 | 用随附 ffmpeg 在本机（i5-13600KF + RTX 4070 Ti SUPER，无核显）以 Idle 优先级做能力探测和码率-画质实验，单次编码 < 25 s，合计约 3 分钟 CPU |

代码结论以文件路径核对；网络结论附来源；实测结论附命令与数值。凡标「推断」的内容未经验证。原始调研报告保存在会话临时目录，未入库；本文是摘要。

## 已有事实与代码依据

### 随附的 ffmpeg

**Windows 可直接复用。**

- 来源：BtbN `ffmpeg-n8.1.2-21-gce3c09c101-win64-lgpl-8.1.zip`，许可 LGPL-3.0-or-later（`--enable-version3`），未启用 GPL 与 nonfree。
- 文件位置：`build/subtitle-studio-resources/transcription/win-x64/media/ffmpeg.exe` 与 `ffprobe.exe`，各约 112 MB。
- 来源记录：`build/subtitle-studio-resources/transcription/licenses/FFmpeg-n8.1.2-windows-x64-btbn-source.json`。
- 安装后一定存在，不需要下载。打包时随 `electron-builder.subtitle-studio.json` 的 `extraResources` 放入 `resources/subtitle-studio/transcription`。
- 使用前校验：`electron/main/subtitle-studio/transcription/native/resource-path.ts` 的 `verifyLocalSubtitleRuntimeBundle({environment, scope:"media"})` 检查 SHA-256、体积、架构和文件身份，约耗时 1 秒，可按会话缓存。
- 现成先例：`electron/main/subtitle-studio/cue-audio-clip.ts`（`selectCueAudioFfmpeg`）复用了这套校验，并用同目录的 `media-process.ts`（`runLocalSubtitleMediaProcess`、`buildLocalSubtitleMediaEnvironment`）运行 ffmpeg。

**这个 Windows 构建能做什么（实测）。**

- 视频编码器：
  - 软件：`libsvtav1`（SVT-AV1 v4.1.0-125）、`libaom-av1`、`librav1e`、`libvpx(-vp9)`、`libkvazaar`（HEVC，仅 8-bit）、`libvvenc`、`libopenh264`（无 CRF、无 10-bit）。
  - 硬件：`h264/hevc/av1` 的 `_nvenc`、`_qsv`、`_amf`、`_mf`、`_d3d12va`、`_vulkan`。
- 音频编码器：`aac`（原生）、`aac_mf`、`libopus`、`libmp3lame`、`libvorbis`、`flac`、`alac`、`pcm_*`、`ac3/eac3`、`wavpack`。
- 滤镜：`libvmaf`（内置 `vmaf_v0.6.1`、`vmaf_v0.6.1neg`、`vmaf_4k_v0.6.1` 模型，无需模型文件）、`xpsnr`、`ssim`、`psnr`、`zscale`、`libplacebo`、`tonemap`、`loudnorm`、`bwdif`/`yadif`、`nlmeans`、`atadenoise`、`bbox`、`idet`。
- 缺少的部分：
  - x264、x265、fdk-aac。
  - GPL 滤镜：`cropdetect`、`hqdn3d`、`mpdecimate`、`delogo`、`eq` 等。
- 编译进了网络协议：`schannel`、`srt`、`rist`、`ssh`。因此输入必须限制协议（见「安全」）。

**macOS 当前不能用于转换。**

- 构建脚本：`scripts/subtitle-studio/transcription/runtime/build-ffmpeg-macos-arm64.mjs`。
- 配置为 `--disable-everything --disable-swscale`，只有音频解码器，唯一的编码器是 `pcm_s16le`，唯一的封装格式是 `wav,null`。
- 脚本拒绝 `--enable-gpl`、`--enable-nonfree` 和 `--enable-version3`，许可为 LGPL-2.1-or-later。
- 结论：macOS 要做转换，必须另外构建一个能处理视频的 ffmpeg。

**冻结副本与审计。**

- `electron/main/subtitle-studio/transcription/native/*` 与 `electron/main/local-subtitle/*` 是受溯源审计的冻结副本，只能 import，不能修改。
- 改动 `electron/main/index.ts` 或 `electron/preload/index.ts` 后，要在两个审计 JSON 中重新登记 blob：
  - `scripts/subtitle-studio-provenance/current-composition-audits.json`
  - `resources/speech-resources/provenance/current-integration-audits.v1.json`
- 版本号升到 0.6.0 时，要在 `scripts/subtitle-studio-provenance/current-source-audits.json` 中重新登记 `package.json`。

**现有进程封装 `runLocalSubtitleMediaProcess` 的限制（会影响长时编码）。**

- stdin 设为 `ignore`。
- stderr 超过上限（默认 64 KB）会**终止进程**。
- 超时上限是 12 小时。
- 不能设置进程优先级。

因此转换工具要用自己的进程封装，但沿用其中的安全约束：`shell:false`、`windowsHide`、精简环境变量、命令参数上限。

### 渲染进程与 IPC

**工具注册。**

- 工具元数据在 `src/pages/Tools/_shared/toolMeta.ts`：`ToolKey` 是封闭联合类型，`category` 只有 `subtitle|rename|text`。
- 路由在 `src/App.tsx`（`/tools/<category>/<name>`），页面标题映射在 `src/constants/router.ts` 的 `ToolNameMap`。
- 工具目录 `src/pages/Tools/index.tsx` 分三组：`FEATURED_TOOLS`、`CLASSIC_TOOLS`、`EXPERIMENTAL_TOOLS`。
- 相关测试约束：
  - `src/agent/capability-catalog.test.ts` 要求经典与精选两组的工具都有 Agent 能力条目（数量写死为 7）。
  - `test/e2e.spec.ts` 要求经典网格恰好两行，实验组恰好只有 `textTranslator`。
- 结论：新增「媒体工具」分区可以避开这些约束。

**参照页面。**

- 页面结构参照 `src/pages/Tools/Subtitle/SubtitleConverter/index.tsx`。
- 共用组件在 `src/pages/Tools/_shared/ui/`：`ToolDetailLayout`、`ToolConfigPanel`、`ToolConfigDisclosure`、`ToolFilePickerSurface`（配合页面级 `useToolFileDropTarget`）、`ToolPanel`、`ToolStatBar`、`ToolRadioButtonGroup`、`ToolSwitchRow`、`ToolOutputPathPicker`。
- 队列行参照字幕工作台的 `StudioTaskQueueRow` 与 `StudioFileName`。
- 视觉约定：`.agents/skills/fusionkit-ui-design/references/visual-contract.md`。

**IPC 模式。**

- 参照长文本翻译：
  - `src/long-text/channels.ts`（只依赖 zod）
  - `electron/preload/long-text-api.ts`
  - 遗留桥前缀拦截
  - `electron/main/fs/trusted-sender.ts` 的 `isTrustedAppSender`
  - 带 sequence 的推送事件
- 拖放路径的取得：预加载里同步调用 `webUtils.getPathForFile`，主进程再经 `electron/main/subtitle-studio/drop-input-service.ts` 的 `resolveDroppedInputPaths` 处理。这一步会把 Explorer 放在 `%TEMP%` 的临时副本还原为原始文件。

**i18n。**

- 四种语言：zh（源）、en、ja、zh-Hant。
- 新命名空间要在 `src/i18n/constants.ts` 与 `src/i18n/resources.ts` 中登记，并通过 `pnpm run i18n:check`。

### 体积与发布

- Windows 0.5.2 安装包 267 MB，安装后约 879 MB，已超过 PRE-006 的 850 MB 守卫。安装包里有两份相同的 ffmpeg（经典转写与字幕工作台各一份）。
- Windows 复用现有 ffmpeg 不会增加体积。若随安装包附带 GPL 构建，预计安装包增加 35–45 MB（推断）。

## 业界工具调研摘要

| 工具 | 可借鉴 | 不足 |
| --- | --- | --- |
| HandBrake | 恒定质量（RF）为默认；预设分族；SVT-AV1 10-bit 预设（RF 30.5–43，preset 4–7）；Social 25/10 MB 用 2-pass ABR | 预设和术语过多；不提供体积预估；「目标大小」按固定时长档位设定码率，没有用真实时长 |
| Shutter Encoder | 按功能列出；「不转换」类操作（换封装、无损裁剪）；可锁定目标文件大小；VMAF/响度分析；硬件加速默认关闭 | 偏剪辑用户，简单模式弱 |
| Permute / Compresto | 拖放即用；显示节省比例（如 32.1 MB → 13.3 MB −59%） | 实测硬件 HEVC 体积是软件的 2.7 倍（457 MB vs 168 MB） |
| VEED / UniConverter / 手机 App | 「更小 ↔ 更清晰」滑块配实时体积预估；20 s 预览 | 码率控制很粗糙，预估常不准 |
| 8mb.video | 按目标大小一键压缩（8/10/20/25/50 MB） | 需要上传到服务器 |
| ab-av1 / Av1an | 采样编码 + 插值二分搜索 CRF，达到目标 VMAF；预测体积与耗时 | 只有命令行，没有面向普通用户的界面 |
| Adobe Media Encoder | CBR / VBR 1-pass / 2-pass | 体积预估「总是不准」 |
| 格式工厂 | 上手简单 | 广告与捆绑软件 |

**空白点：** 没有一款面向普通用户的图形工具同时做到「按用途选择 + 按真实时长计算目标大小 + 感知画质（VMAF）目标 + 采样预览对比」。ab-av1/Av1an 技术最好但没有界面，VEED、手机 App 界面最好但码率控制粗糙。FusionKit 的定位就是把两者合起来，并且全部在本机完成。

要避免的做法：

- 广告、付费才能用的「强力」档、水印。
- 上传到服务器。
- 固定码率档位。
- 不准的预估。
- 因为 1–2% 的超标就放弃「目标大小」功能。
- 简单模式里堆上百个术语预设。
- 静默的损害：能换封装却重新编码、放大分辨率、有损转无损、覆盖原文件、丢掉元数据和字幕。

## 本机实测（Windows 随附 ffmpeg）

> 测试素材是 Windows 锁屏 CG 图片生成的 1080p30 6 s 平移缩放片段，加了合成噪点。不是真实拍摄画面，结论只用于方向判断，正式参数要用真实样片校准（见 T-ENCODE-05）。

### 硬件编码器探测

每个编码器用 1 s `testsrc2` 720p 编码到 null：

| 编码器 | 结果 |
| --- | --- |
| `h264/hevc/av1_nvenc` | 成功（RTX 4070 Ti SUPER） |
| `*_qsv` | 失败：`Error creating a MFX session: -9`（本机没有核显） |
| `*_amf` | 失败：`amfrt64.dll failed to open` |
| `h264_mf`（默认） | 成功，但用的是微软软件 MFT |
| `*_mf -hw_encoding 1` | 成功（走 NVIDIA MFT） |
| `*_d3d12va` | 失败 |
| `av1_vulkan` | 能运行，但**输出无法解码** |

- 失败在 0.1–0.25 s 内返回，成功在 0.3–0.7 s 内返回。
- 结论：`-encoders` 列表不能说明编码器可用，必须实测。`d3d12va` 和 `vulkan` 应排除。

### 码率-画质实验

画质用 VMAF v0.6.1 衡量：

| 编码器与设置 | 码率 kbps | VMAF 均值 | 最低帧 | 编码 fps（Idle） |
| --- | --- | --- | --- | --- |
| SVT-AV1 p6 crf35 10-bit | 203 | 95.10 | 93.47 | 46 |
| SVT-AV1 p6 crf35 8-bit | 231 | 94.82 | 93.60 | 64 |
| SVT-AV1 p4 crf35 | 224 | 95.06 | 93.40 | 29 |
| SVT-AV1 p8 crf35 | 303 | 93.38 | – | 约 90 |
| av1_nvenc p7 uhq cq35 10-bit | 355 | 94.30 | 92.94 | 113 |
| hevc_nvenc p7 uhq cq28 | 1008 | 95.46 | 94.15 | 约 95 |
| h264_nvenc p7 hq cq23 | 6485 | 95.07 | – | 150 |
| libkvazaar medium qp18 | 592 | 94.49 | – | 约 80 |
| libopenh264 high+cabac 4M | 4002 | 94.00 | **82.47** | 145 |
| h264_mf 软件 quality 70 | 1827 | 91.77 | 90.78 | 约 160 |

方向性结论：

- SVT-AV1 preset 6 是性价比拐点：preset 4 只小约 3%，耗时却是 2.2 倍；preset 8/10 损失明显。
- CRF 的效果随 preset 变化，所以 CRF/VMAF 搜索必须用与最终编码相同的 preset。
- 同一 CRF 下，10-bit AV1 比 8-bit 小约 12%，画质还更高。
- NVENC AV1 UHQ 达到同等 VMAF 需要约 2 倍码率，但速度快 2–3 倍。
- NVENC 在 CQ 模式下开启 AQ，码率膨胀到 4.6 倍，VMAF 只多 0.25。
- 没有 x264 时 H.264 是短板：openh264 的最低帧画质很差，Media Foundation 的码率控制会偏离 25–50%。

### 码率控制

- SVT-AV1 用 ffmpeg 的 `-pass 1/2 -passlogfile` 做 2-pass，误差在 +1% 到 +4.6% 之间。1-pass VBR 偏差为 −43% 到 +64%。
- `-svtav1-params passes=2` 只打印错误、退出码仍是 0，实际按 1-pass 编码。
- SVT-AV1 在随机访问模式下不支持 CBR，但支持「带上限的 CRF」（`-crf N -maxrate -bufsize`）。
- 未知的 `-svtav1-params` 键只打日志不报错。高级参数因此必须用白名单校验，并检查 stderr。
- NVENC VBR + multipass 偏低约 48%，目标大小模式需要修正。
- libvpx-vp9 的 2-pass 结果准确。

### VMAF 计算开销

1080p 180 帧：

| 设置 | 耗时 |
| --- | --- |
| `n_threads=8` | 1.94 s |
| `n_threads=8` + `n_subsample=5` | 1.19 s（分数差 0.005） |

1 线程需要 16.75 s。

### 其他验证

- `-progress pipe:1` 每块以 `progress=continue|end` 结尾；`out_time_ms` 的值其实是微秒；`bitrate` 和 `speed` 带前导空格。
- 输出参数 `-color_primaries/-color_trc` 在 libsvtav1 上会被静默丢弃，改用 `-vf setparams=...` 能写全色彩标记。
- 重新编码时，HDR10 的 Mastering Display 与 Content Light Level 会被 libsvtav1 和 hevc_nvenc 自动带过去。
- zscale + tonemap 的 HDR→SDR 链可用，但缺少色彩标记时要显式给出输入色彩参数。
- 流复制可行：AV1+Opus 进 MP4/WebM；HEVC 加 `-tag:v hvc1` 进 MP4。

## 方案评估

### 视频编码路线

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A：只用现有 LGPL 构建，以 SVT-AV1 为主、硬件编码器负责 H.264/HEVC | 不改打包、不改许可；AV1 压缩率最高；有 libvmaf | 只有 CPU 的机器上 H.264/HEVC 输出偏大 | **推荐，用于 v0.6.0** |
| B：另行提供可选下载的 GPL 构建（x264/x265） | CPU 上 H.264/HEVC 画质最好 | 要承担 GPL 源码提供义务和许可审查；需要单独的下载、校验和卸载流程；macOS 没有现成构建 | 暂不做，留作 Q-03 |
| C：「使用自己的 ffmpeg」 | 零分发责任 | 违背项目「不走 PATH、只用随附且校验过的二进制」的约定（FK-PIT-0023），也无法保证能力 | 不采用 |

### 压缩模式

| 模式 | 技术 | 增量 |
| --- | --- | --- |
| 恒定质量（三档） | SVT-AV1 CRF / NVENC CQ / QSV ICQ / AMF QVBR，按档映射初值 | I1 |
| 目标大小 | 用真实时长计算码率 + 真 2-pass + 按每像素比特自动降分辨率 + 超标重编 | I2 |
| 感知画质目标 | 参照 ab-av1：采样、插值二分搜索 CRF、VMAF 加低分位保护、预测体积与耗时 | I2 |
| 预览对比 | 采样片段编码 + 同帧截图滑动对比 + VMAF | I2 |
| 高级 | 码控模式（CRF/CQ、VBR 1/2-pass、带上限 CRF、CBR）、preset/tune、GOP、10-bit、胶片颗粒合成、滤镜、音频处理 | I3 |

### macOS（Q-02）

| 方案 | 说明 |
| --- | --- |
| a | 新增独立的 `media-tools` 运行时，用 LGPL-2.1 构建：VideoToolbox/AudioToolbox 系统框架，加 SVT-AV1、dav1d、Opus、LAME、libvpx、zimg、libvmaf。由用户在 Mac 上执行构建脚本 |
| b | 作为可下载资源 |
| c | v0.6.0 只支持 Windows |

推荐 a，放在 I4。I1–I3 期间 macOS 隐藏入口，不放占位磁贴。

## 目标、范围与非目标

**目标：**

- 本机完成常见音视频的格式转换、视频压缩和音频提取。
- 视频压缩以「保留画质、尽量更小」为核心。
- 简单模式三档即可用；高阶用户能控制码率模式与编码参数。

**非目标（v0.6.0）：**

- 剪辑与时间线编辑。
- 加字幕烧录、水印。
- 监视文件夹自动转换。
- 网络与流媒体输入：URL、HLS、DVD/蓝光目录、录屏、录音。
- 微信 SILK 语音解码：遇到时给出明确提示。
- AI 超分辨率与插帧。
- 分布式或分段并行编码（Av1an 式），因为 SVT-AV1 本身已经多线程。
- 杜比视界 Profile 5 的重新编码：给出提示，不处理。

## 阻断问题

见 `spec.json` 的 decisions：

- **Q-01（已决定）**：「压缩视频」默认用什么编码输出。当时推荐 AV1。用户在 2026-10-26 选了选项 B：有 HEVC 硬件编码器时默认 HEVC，否则默认 H.264；AV1 作为「最小体积」，由用户主动选择。
- **Q-02（阻断 I4）**：macOS 方案。
- **Q-03（不阻断）**：是否引入 GPL 编码器扩展包。
- **Q-04（阻断发布）**：许可与编解码专利。
  - QA-005 至今未关闭：外部库的逐项声明、BtbN 提交对应的源码提供、专利审查都还没完成。
  - Cisco 的 OpenH264 专利许可只覆盖 Cisco 自己分发的二进制。随附的 ffmpeg 里是 BtbN 从源码静态编译的 openh264，不在覆盖范围内。libkvazaar 同样没有专利许可。
- **A-07**：编码参数校准需要用户提供真实样片。缺样片只阻断校准和 I1 验收，不影响开始开发。

## 文档评审（2026-10-26）

规格初稿完成后，从 5 个角度做了对抗式评审：ffmpeg 参数正确性（用随附构建实测）、与代码库的集成可行性、需求质量、产品体验、安全与许可。评审共提出 91 条问题，每条都由独立核查者复核，最终全部成立（1 条阻断、39 条重要、51 条次要），已全部并入文档。对照表见 [records/spec-review-2026-10-26.md](records/spec-review-2026-10-26.md)。

实测推翻了初稿中的几处技术假设：

- hevc_nvenc 使用 `-tune uhq` 时不能加 `-bf 3`，否则驱动拒绝打开编码器。
- MF 硬件编码器只接受 nv12。h264_mf 默认输出 Baseline profile，需要指定 `-profile:v 100`。
- kvazaar 的参数要用逗号分隔，不能用冒号；输出宽高必须是 8 的倍数。
- `-n` 遇到已存在的文件时会以 0 退出、不写任何内容，所以临时文件的处理流程改为「先占位，再用 `-y` 写入」。
- 播放列表类解复用器即使只放行 `file` 协议，也会去读取别的本地文件。因此改用 `-format_whitelist` 限制可用的解复用器。
- 杜比视界 Profile 5 往往不标 PQ，要靠流级的 DOVI 记录来识别。
- `-loglevel error` 会把参数被静默替换的警告藏起来，所以统一改用 `level+warning`。

## 结论与下一增量

1. **I1：Windows 端到端主链路。**
   - 媒体探测、能力探测（含硬件编码器实测）、主进程队列。
   - 安全输出：临时文件、原子发布、不覆盖原文件、不变大保护。
   - 三种任务：压缩视频（三档 × 三类编码目标）、转换格式（优先无损换封装）、提取音频（优先无损）。
   - 四语界面。
2. **I2：智能压缩。** 目标大小、VMAF 画质目标、压缩前预估、采样预览对比、完成后画质报告。
3. **I3：高阶设置。** 码控与编码器参数、滤镜与音频处理、自定义预设、GIF/WebP、无损裁剪时长。
4. **I4：macOS 媒体引擎。**
5. **I5：Agent 接入（内置 + MCP）与 0.6.0 发布收尾。**
