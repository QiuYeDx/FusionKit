# 本地字幕转写预发布说明

> 文档状态：预发布基线（2026-08-06）
>
> 适用范围：FusionKit v0.2.11 开发分支
>
> 发布状态：功能代码已经形成完整流水线，但 Windows/macOS 最终安装包、目标 GPU、稳定性、许可与隐私发布验收尚未全部完成。本文不表示该功能已经作为 stable 版本发布。

## 功能范围

本地字幕转写是独立于“音频转文本”远端 API 工具的字幕工具。它在 Electron main 中使用随应用提供的固定 `whisper.cpp` runtime 和 FFmpeg/ffprobe，把本地音频或视频转换为 SRT/LRC 字幕。

当前代码路径包含：

- 一次选择 1～100 个音频或视频文件，逐文件探测媒体与选择音轨。
- 使用 managed `large-v3-q5_0` GGML 模型，以 CPU、macOS Metal 或 Windows CUDA 候选 backend 执行本地转写。
- 原文转写或 Whisper 内置“翻译为英语”模式。
- 可选固定 Silero v6.2.0 VAD；VAD 与非 VAD 都使用段级时间轴，不开放逐词时间戳。
- 输出 SRT、LRC 或两者；支持源目录/自定义目录、自动编号和受控覆盖。
- 默认只导出；也可显式加入字幕翻译队列，或在确认翻译配置和外部 API 费用后只启动本次交接新增的任务。
- 批内逐文件失败隔离、取消、重试、确认式 GPU→CPU 新任务 generation、结果预览、复制、定位文件和结构化错误详情。

本功能不提供实时麦克风字幕、说话人分离、WhisperX 对齐、单文件中途断点续跑或 Linux/macOS x64/Windows arm64 支持。

## 发布候选平台矩阵

| 平台 | 候选执行路径 | 当前证据边界 |
| --- | --- | --- |
| Windows x64 | CPU runtime 随应用提供；CUDA 12.4 加速包按需安装；失败时只能由用户确认创建新的 CPU generation | runtime/component 与开发侧 packaged consumption 已验证；真实 installer 生命周期、目标 NVIDIA 产品验收和 CUDA 分发许可尚未闭环 |
| macOS arm64 | 默认 Metal，同一架构保留显式 CPU | runtime/component 与开发侧 packaged consumption 已验证；Developer ID、公证、Gatekeeper accepted 和完整产品验收尚未闭环 |
| 其他平台/架构 | 不支持 | 应返回稳定的 `unsupported_platform` 或 `unsupported_architecture`，不得尝试相近架构或系统 runtime |

在最终 QA 记录完成前，不应把上表中的候选 backend 写成已发布或已保证性能的能力。当前没有可对外承诺的最低 GPU 型号、绝对耗时或 RTF 数值。

## Runtime、下载与磁盘

| 资源 | 获取方式 | 固定体积 | 说明 |
| --- | --- | ---: | --- |
| whisper-server、FFmpeg、ffprobe | 随对应平台应用包提供 | 以安装包 manifest 为准 | 位于 asar 外并按平台、架构、大小和 SHA-256 校验；用户无需安装系统 FFmpeg |
| `large-v3-q5_0` | 首次使用时按需下载，或导入完全匹配内置清单的 GGML 文件 | 1,081,140,203 bytes（约 1.01 GiB） | 不进入 Git 或默认安装包；下载支持续传、校验和失败清理 |
| Silero VAD v6.2.0 GGML | 按需下载 | 885,098 bytes（约 0.84 MiB） | 启用 VAD 前必须处于 ready 状态并通过 load smoke |
| Windows CUDA 12.4 候选包 | 按需下载 | 下载 677,887,125 bytes（约 0.63 GiB）；安装后 1,199,083,008 bytes（约 1.12 GiB） | 安装过程至少需要约 1.75 GiB 的 archive + installed payload 空间；当前分发许可门禁未关闭，不得对外提供该包 |

媒体处理还会在受控临时目录创建源快照和 16 kHz mono PCM16 WAV。应用会在任务前检查预计空间并额外保留 64 MiB 安全余量；长媒体所需临时空间不包含在上表资源体积中。磁盘空间不足时任务必须在提交产物前失败，不能改用系统 FFmpeg 或任意用户 executable。

下载只接受内置 manifest 的固定 `resourceId`、URL host allowlist、体积和 SHA-256。renderer 不能提交任意下载 URL、模型路径、runtime 路径、backend flag 或 executable。相关固定清单：

- [模型清单](../../../resources/local-subtitle/manifests/local-subtitle-models.v1.json)
- [VAD 清单](../../../resources/local-subtitle/manifests/local-subtitle-vad.v1.json)
- [Windows CUDA 候选包清单](../../../resources/local-subtitle/manifests/local-subtitle-windows-cuda-pack.v1.json)
- [平台 runtime staging 清单](../../../resources/local-subtitle/manifests/local-subtitle-staging.v1.json)

## 隐私与外部网络

- 本地转写默认离线。普通推理不上传媒体、字幕、时间戳、模型使用信息或用户路径。
- 只有用户发起模型、VAD 或加速包安装时，应用才访问固定 allowlist 中的下载源。
- `whisper-server` 只监听 main 管理的私有 loopback 地址；端口、私有 request path、模型路径和临时 WAV 路径不进入 renderer。
- renderer 持久化只保存经过白名单清洗的偏好；不保存真实路径、文件/目录 token、初始提示词、字幕正文、segment/word、runner diagnostics 或 API Key。
- 本地转写的会话摘要只保存脱敏任务标签、状态、阶段、格式、backend/build、时间和稳定错误码，不保存媒体或字幕正文。
- 选择“加入并开始翻译”会使用用户当前配置的第三方文本模型 API，并可能产生费用。默认 `export_only` 不调用外部翻译 API；自动模式只启动本次不可变交接回执中的新增任务。
- 已启动的字幕翻译任务为支持失败恢复，可在本地 v2 checkpoint 的 `manifest_fragments` 中保存字幕文本分片。checkpoint 不含音视频字节、绝对路径、capability/token、API Key、header 或模型凭据；最终译文提交成功后删除内容 checkpoint，只保留脱敏完成摘要。尚未启动的仅入队任务不创建 checkpoint。

## 恢复、取消与用户产物

- 已原子提交的 SRT/LRC 是用户产物；取消、失败、更新、降级或卸载不会主动删除它们。
- 本地转写任务队列为会话级。应用异常退出后，未完成文件需要用户重新选择并从头开始；上一会话只显示不含路径/正文的诊断摘要。
- 正常失败和取消会清理受控临时文件。若进程恰好在用户输出目录写入与清理之间崩溃，可能留下隐藏的 `.fusionkit-local-subtitle-*.partial`；应用不会持久化并全局扫描用户输出路径。
- 受控覆盖事务如需跨重启恢复，会显示 path-free recovery 条目，并要求用户重新选择输出目录后再验证；应用不会从历史 raw path 静默恢复权限。
- 已经交给字幕翻译器的任务由字幕翻译器拥有。本地转写批次取消不会取消已经入队的翻译任务，用户需要在字幕翻译页单独处理。

## 更新、卸载与空间回收

- 应用更新会重新验证 runtime manifest、协议、架构和资源完整性；兼容的 managed 模型继续保留，不兼容时提示迁移或重新下载，不静默删除数 GB 数据。
- Windows installer 当前配置为 `deleteAppDataOnUninstall: false`。卸载应用默认保留 `userData`，其中可能包含 managed 模型、VAD、加速包、恢复状态和字幕翻译 checkpoint。
- 如需回收空间，应在卸载前从本地字幕转写资源面板删除未被任务占用的模型/VAD/加速包，并在字幕翻译页删除不再需要恢复的任务。用户自行导出的 SRT/LRC 和最终译文不随资源删除。
- 安装、卸载、同版本更新、降级与数据保留的最终产品矩阵尚未完成；在对应验收记录完成前，不应对外承诺无条件兼容。

## 第三方组件与许可

当前 runtime 选择、许可证文本和来源记录位于：

- [本地字幕 runtime 第三方说明](../../../resources/local-subtitle/licenses/THIRD_PARTY_NOTICES.local-subtitle.md)
- [whisper.cpp MIT 许可证](../../../resources/local-subtitle/licenses/whisper.cpp-MIT.txt)
- [whisper.cpp v1.9.1 来源记录](../../../resources/local-subtitle/licenses/whisper.cpp-v1.9.1-source.json)
- [FFmpeg 上游许可说明](../../../resources/local-subtitle/licenses/FFmpeg-LICENSE.md)
- [macOS FFmpeg 8.1.2 source offer](../../../resources/local-subtitle/licenses/FFmpeg-8.1.2-source-offer.json)
- [Windows FFmpeg binary/source 记录](../../../resources/local-subtitle/licenses/FFmpeg-n8.1.2-windows-x64-btbn-source.json)

Windows CUDA 候选包清单仍把 NVIDIA CUDA runtime 许可标记为 `pending` 且 `artifactSharingAllowed: false`。完成精确 DLL、notice/source-offer 和 NVIDIA 分发条款复核前，不得公开分享该加速包或把它描述成正式可下载资源。

## 发布前仍需回填

- Windows x64 installer 的安装、卸载、更新、空格/非 ASCII 路径、CPU/CUDA 与数据保留结果。
- macOS arm64 Developer ID、公证、Gatekeeper、Metal/CPU、更新与不支持架构拒绝结果。
- Electron 四语言、主题、宽窄窗口、键盘、取消/交接竞态和长诊断矩阵。
- 真实长媒体、批量、崩溃、OOM、磁盘不足、1h+ soak、日志/持久化隐私扫描和第三方许可闭环。
- 最终可发布版本号、下载链接、最低硬件建议和任何性能声明。

以上证据补齐后，再把本文从“预发布基线”升级为正式发布说明，并同步 [Final Design](local-subtitle-transcriber_final_design.md) 与 [Execution Plan](local-subtitle-transcriber_execution_plan.md) 台账。
