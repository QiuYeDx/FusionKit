# 本地字幕转写工具调研与 Final Design

> 日期：2026-07-16
>
> Feature Slug：`local-subtitle-transcriber`
>
> 状态：调研完成，待评审；尚未进入代码实现
>
> 产品定位：使用本地算力把批量音频/视频转成可直接翻译的 SRT/LRC 字幕
>
> 参考项目：`C:\Users\Administrator\Documents\GitHub\temp\faster-whisper-GUI-main`

---

## 0. 结论先行

FusionKit 应新增一个独立的“本地字幕转写”工具，而不是扩展、切换或复用现有远端 API `AudioTranscriber` 的任务合同。

最终建议如下：

1. 新工具归入“字幕”分类，建议路由为 `/tools/subtitle/local-transcriber`，名称为“本地字幕转写”。
2. 现有 `/tools/audio/transcriber` 保持原样，继续承担 OpenAI/MiMo 等外部 API 的通用音频转文本；不得向其中加入本地模型、设备、GPU、批处理字幕或模型下载逻辑。
3. 新工具拥有独立页面、Store、类型、preload bridge、IPC 命名空间、任务队列、模型管理器、本地运行时和导出器。两者只复用无业务语义的基础设施与实现经验，例如工具页布局、文件授权模式、输出目录授权模式、按钮组和错误展示组件。
4. 首版统一推理后端推荐 `whisper.cpp`，而不是把 Python `faster-whisper` 直接嵌入 FusionKit：
   - Windows x64 可使用 NVIDIA CUDA，并保留 CPU fallback。
   - macOS Apple Silicon 可使用 Metal；Intel Mac 提供 CPU fallback，但不承诺与 Apple Silicon 相同的速度。
   - 同一后端可运行 Whisper `large-v3`，并支持量化模型、VAD、进度回调、段/词时间戳。
5. 不把上游 `whisper-cli` 的控制台文本当作正式协议。FusionKit 应维护一个很薄的原生 sidecar runner，固定链接经过验证的 `whisper.cpp` 版本，通过 JSONL 与 Electron main 通信。
6. 首版核心产物是标准 SRT 和标准行级 LRC；VTT、TXT、详细 JSON 可作为扩展导出。增强型逐词 LRC 单独标记，不直接送入现有字幕翻译器。
7. 转写完成后必须提供“一键送入字幕翻译”能力，但通过一次性字幕产物 token 交接；本地转写工具不得直接读写字幕翻译器 Store，也不得自动开始产生外部 API 费用。
8. 模型不放进安装包。模型、VAD 模型和可选 Windows 加速包按需下载到 `app.getPath("userData")` 下，支持断点续传、校验、删除和导入本地模型。
9. `faster-whisper-GUI-main` 仅作为行为与参数研究来源，不复制代码。该参考项目为 AGPL-3.0，而 FusionKit 当前为 PolyForm-Noncommercial-1.0.0；直接复制或改造其代码会引入明显的许可证风险。

## 1. 背景、目标与边界

### 1.1 现有工作流

当前“烤肉”流程是：

```text
音频/视频
  → 在 faster-whisper-GUI-main 中使用本地 GPU 转写
  → 导出 SRT/LRC
  → 打开 FusionKit 字幕文件翻译
  → 添加字幕文件并生成双语字幕
```

能力已经能串起来，但模型管理、批处理、任务状态、文件选择和结果交接分散在两个桌面软件中，Windows 与 macOS 的体验也不一致。

### 1.2 目标

1. 在 FusionKit 内选择多个本地音频/视频文件，使用本地 Whisper 模型批量转写。
2. Windows 优先使用 NVIDIA GPU，macOS Apple Silicon 使用 Metal，同时保留 CPU fallback。
3. 支持 Whisper `large-v3`，并允许用户显式选择资源占用更低的量化或 turbo 变体。
4. 生成带稳定时间轴的 SRT/LRC，可直接进入 FusionKit 字幕翻译。
5. 支持语言自动检测、初始提示词、VAD、段级/词级时间戳、字幕整形、取消和逐文件失败隔离。
6. 模型只下载一次；同一批任务复用已加载模型，避免每个文件重复装载 `large-v3`。
7. 本地媒体内容、模型路径、真实文件路径和转写中间数据不进入 renderer 持久化或普通日志。
8. 让未来增加 Windows `faster-whisper`、Apple MLX 或其他本地引擎成为可控扩展，而不是重写页面和任务合同。

### 1.3 非目标

1. 不改造现有外部 API 音频转文本工具。
2. 首版不做实时麦克风字幕；现有实时字幕工具有独立产品定位。
3. 首版不做 WhisperX 强制对齐、说话人聚类、Demucs 人声分离或完整字幕时间轴编辑器。
4. 首版不支持任务在单个文件中间断点续跑；应用重启后可保留已完成产物，但未完成文件从头开始。
5. 首版不自动启动字幕翻译，不在用户确认前调用任何外部模型 API。
6. 不承诺所有 Windows AMD/Intel GPU 在首版都获得稳定加速；首版保证 CPU fallback，Vulkan 可作为后续加速包。

## 2. 与现有远端 ASR 的强制隔离边界

现有 `src/pages/Tools/Audio/AudioTranscriber/index.tsx` 是外部 API 工具：它从独立音频 API 配置中解析 provider route，通过 `src/services/audio/audioTranscriptionService.ts` 和 `electron/main/audio/ipc.ts` 调用 OpenAI/MiMo adapter。它的输入大小、响应格式、stream、timestamp 字段均受远端 route 约束。

本地字幕转写的架构不同：需要原生可执行文件、GPU 后端探测、模型下载、媒体转码、长任务队列、模型驻留、字幕整形与本地产物管理。把两者合并会让 provider route、模型 route、字段显隐、Store 迁移、IPC 安全和取消逻辑互相污染。

### 2.1 必须独立的模块

| 层级 | 新工具建议 | 明确不得复用为同一合同的现有模块 |
| --- | --- | --- |
| Route | `/tools/subtitle/local-transcriber` | `/tools/audio/transcriber` |
| Tool key | `localSubtitleTranscriber` | `audioTranscriber` |
| Renderer page | `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/` | `src/pages/Tools/Audio/AudioTranscriber/` |
| Store key | `fusionkit-local-subtitle-transcriber` | `fusionkit-audio-transcriber` |
| Types | `src/type/localSubtitle.ts`、`localSubtitleIpc.ts` | `src/type/audio.ts`、`audioIpc.ts` |
| Preload API | `window.localSubtitleApi` | `window.audioApi` |
| IPC prefix | `local-subtitle:*` | `audio:*` |
| Main runtime | `electron/main/local-subtitle/*` | `electron/main/audio/*` |
| 配置 | 本地引擎/模型/设备/字幕偏好 | Audio API profile/assignment/provider route |
| 输出 | SRT/LRC 字幕产物 | API 原始 text/json/srt/vtt 响应 |

### 2.2 可以复用的内容

- `ToolDetailLayout`、`ToolConfigSection`、`ToolFileDropZone`、`ToolRadioButtonGroup` 等通用 UI。
- sender-bound 文件 token、输出目录 token、过期与撤销重试的设计经验。
- 不经 renderer 传递真实路径的安全原则。
- i18n、错误卡片、toast、Electron 视觉验收和前端服务清理规范。
- 字幕翻译器已有的 `OutputConflictPolicy`、源目录/自定义目录产品概念，但新工具保留自己的类型和 Store。

复用必须通过提取真正通用的小模块完成，不能让本地字幕任务调用 `AudioIpcService.transcribe()`，也不能让本地模型伪装成一个 audio provider preset。

## 3. FusionKit 当前可对接状态

### 3.1 字幕翻译器

当前 `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`：

- 支持同时添加多个文件。
- UI 当前接受 `.lrc,.srt`。
- 支持源目录或自定义输出目录。
- 支持双语/仅译文、语言选择、任务队列、失败恢复和冲突策略。

因此新工具的最小交付格式必须是 SRT 和标准 LRC。虽然 `SubtitleFileType` 还包含 VTT，但当前字幕翻译入口没有接收 VTT，不能把“能导出 VTT”描述成“已打通翻译”。

### 3.2 Electron 文件安全基础

音频工具已实现：

- preload 使用 `webUtils.getPathForFile()` 获取用户真实选择的路径。
- main 发放 sender-bound 输入文件 token 与输出目录 token。
- renderer 只持有受限 token，不把路径拼进任意 IPC 请求。
- generic invoke 使用精确 public allowlist，preload-only 内部 channel 留在私有闭包。

本地字幕工具应复制这套安全模式的原则和测试，不共享 audio token registry。新工具的 token TTL、批量文件数量、媒体格式和任务生命周期不同，应由 `LocalSubtitleFileAuthorizations` 独立管理。

### 3.3 打包现状

当前 `electron-builder.json` 只打包 `dist-electron` 和 `dist`，还没有 native sidecar、FFmpeg 或多架构资源。macOS 产物名也未包含 `${arch}`。新增本地运行时时必须同步设计 `extraResources`、可执行权限、签名、公证、Windows DLL 和多架构产物命名，不能只让开发目录中的二进制“恰好可运行”。

## 4. 参考项目审计

### 4.1 技术栈与状态

本地快照的主要依赖为：

- PySide6 GUI。
- `faster-whisper==0.10.0`。
- `CTranslate2>=3.21.0`。
- `torch==1.13.1+cu117`、`torchaudio==0.13.1+cu117`。
- PyAV、FFmpeg Python wrapper、PyAudio、webvtt。
- 内置一份 WhisperX 代码，并接入时间戳对齐和说话人分离。

这套版本明显偏旧，而且 CUDA 11.7、旧 Torch、旧 CTranslate2 与当前上游要求已经存在代际差异，不适合作为 FusionKit 新功能的依赖锁定基线。

### 4.2 核心数据流

```text
LoadModelWorker
  → WhisperModel(model path, device, compute type, workers)
  → TranscribeWorker
      → ThreadPoolExecutor 遍历文件
      → model.transcribe(...)
      → segment_Transcribe 保存段/词时间戳
      → 临时 SRT
  → 可选 WhisperX 对齐/说话人分离
  → OutputWorker
      → SRT/LRC/VTT/TXT/ASS/SMI/JSON
```

关键文件：

- `faster_whisper_GUI/modelLoad.py`：模型路径、device、device index、compute type、CPU threads、workers。
- `faster_whisper_GUI/transcribe.py`：批处理、转写参数、取消标志、格式导出。
- `faster_whisper_GUI/seg_ment.py`：段与词时间戳中间模型。
- `faster_whisper_GUI/whisper_x.py`：WhisperX 对齐与说话人分离。
- `whisperx/SubtitlesProcessor.py`：基于词时间戳和标点的字幕切分。
- `fasterWhisperGUIConfig.json`：模型、VAD、转写和输出偏好。

### 4.3 值得保留的产品能力

1. 批量添加媒体文件，模型只加载一次。
2. 默认单 worker，明确提示单 GPU 增加线程通常不会提高吞吐，反而增加显存占用。
3. 支持语言自动检测、transcribe/translate、beam、temperature fallback、初始提示词、VAD、词时间戳和幻觉静音阈值。
4. 输出 SRT/LRC/VTT/TXT/ASS/SMI/JSON。
5. LRC/VTT 可携带逐词时间戳，适合卡拉 OK/歌词场景。
6. 转写后保留统一 segment/word 中间数据，输出器不需要重复推理。
7. 可选的字幕切分、时间戳编辑、对齐和说话人信息为后续版本提供了产品方向。

### 4.4 不应照搬的实现

1. **取消不可靠**：`TranscribeWorker.stop()` 只设置布尔标志；已经提交到线程池和底层 CUDA 的工作不一定立即停止，也没有强制释放模型/子进程的边界。
2. **错误隔离弱**：线程池 map、控制台输出和 UI 状态混在一起，单文件失败、批次失败和取消没有稳定错误码。
3. **中间结果主要驻留内存**：大量长媒体会持续持有 segment/word 对象，没有明确的内存水位与按文件提交策略。
4. **输出非原子**：直接写最终文件，没有 `.partial`、冲突策略、写后校验和崩溃清理合同。
5. **时间格式实现存在边界风险**：`secondsToHMS()` 四位小数取整后没有统一截断到毫秒，可能生成不规范的 SRT 时间文本；新实现必须用整数毫秒作为唯一事实来源。
6. **参数墙过重**：几乎所有底层参数都直接暴露，普通用户很难知道哪些参数共同生效。FusionKit 应提供少量预设和折叠的高级设置。
7. **模型兼容补丁过时**：加载 large-v3 后手动修改 mel filter，属于旧版本兼容逻辑，不能迁移到新后端。
8. **凭据风险**：参考项目配置文件中存在明文保存外部访问 token 的行为。本文不记录其值；FusionKit 不得复制这种做法。
9. **许可证风险**：参考项目根许可证是 AGPL-3.0。应只参考可观察行为和公开参数，独立实现代码与测试。

## 5. 上游技术路线比较

调研日期为 2026-07-16。实现时仍需固定并复核具体 commit、二进制和模型哈希。

| 方案 | Windows NVIDIA | macOS Apple Silicon GPU | 依赖/打包 | 时间戳/VAD | 结论 |
| --- | --- | --- | --- | --- | --- |
| Python `faster-whisper` | 强，CUDA/CTranslate2 | CTranslate2 仅 CPU；无 MPS/Metal 推理 | Python、PyAV、CTranslate2、CUDA/cuBLAS/cuDNN | 支持词时间戳、Silero VAD、batch | 不适合作为跨平台唯一引擎；可做后续 Windows 插件 |
| `whisper.cpp` | CUDA；也有 Vulkan/CPU | Metal，Core ML 可选 | 原生 C/C++，可构建独立 sidecar | C API 有 progress/abort/segment callback，内置 Silero VAD | 推荐首版统一引擎 |
| `mlx-whisper` | 不支持 | 强，Apple MLX | Python、MLX、模型格式、FFmpeg | 支持词时间戳 | 可做未来 macOS 专用高性能引擎，不作为首版唯一实现 |
| 原版 PyTorch Whisper | CUDA | MPS 可用性和稳定性需逐版本验证 | Python/Torch 体积最大 | 功能完整 | 不符合轻量 sidecar 与跨平台维护目标 |

### 5.1 为什么不直接使用 faster-whisper

当前 `faster-whisper` 上游本身是 MIT，能力也成熟：官方示例支持 `large-v3`、batched pipeline、词时间戳和 Silero VAD。但其 GPU 路径要求 NVIDIA CUDA/cuBLAS/cuDNN；CTranslate2 官方硬件文档的 GPU 列表仍是 NVIDIA GPU。它可以在 ARM64 CPU 上运行，却不能满足“macOS 使用本地 GPU”的核心目标。

此外，当前上游要求与参考 GUI 的旧依赖不同：`faster-whisper` 当前 README 要求 Python 3.9+，GPU 路线围绕 CUDA 12、cuBLAS 和 cuDNN 9。把完整 Python 环境、CUDA 动态库和 PyAV 塞进 Electron，会显著增加包体、安装失败面和安全更新成本。

官方资料：

- [`faster-whisper` README](https://github.com/SYSTRAN/faster-whisper)
- [CTranslate2 hardware support](https://opennmt.net/CTranslate2/hardware_support.html)
- [`faster-whisper` releases](https://github.com/SYSTRAN/faster-whisper/releases)

### 5.2 为什么推荐 whisper.cpp

`whisper.cpp` 官方 README 明确列出 Windows、macOS Intel/Arm、CPU、NVIDIA GPU、Vulkan，以及 Apple Silicon 的 Metal/Core ML 优化。它的 C API 提供 progress callback、new segment callback 和 abort callback，适合建立稳定的 FusionKit runner，而不是解析 CLI 日志。

当前上游还提供：

- Silero VAD 与可配置阈值、最短语音、最短静音、最大语音段和 padding。
- SRT、LRC、VTT、TXT、CSV、JSON 等输出参考实现。
- `large-v3`、`large-v3-q5_0`、`large-v3-turbo` 等 GGML 模型。
- MIT 许可证。

官方模型表给出的典型资源量：

| 模型 | 磁盘 | 官方 README 的典型内存说明 | 产品建议 |
| --- | ---: | ---: | --- |
| `large-v3` | 2.9 GiB | large 系列约 3.9 GB | 质量优先，满足本需求的基准模型 |
| `large-v3-q5_0` | 1.1 GiB | 低于完整模型，需实测 | 资源受限设备的显式选项，不冒充无损 |
| `large-v3-turbo` | 1.5 GiB | 需实测 | 速度优先 |
| `large-v3-turbo-q5_0` | 547 MiB | 需实测 | 轻量快速预览 |

官方资料：

- [`whisper.cpp` README](https://github.com/ggml-org/whisper.cpp)
- [`whisper.cpp` model list](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [`whisper.cpp` CLI output implementation](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp)
- [`whisper.h` callbacks and VAD API](https://github.com/ggml-org/whisper.cpp/blob/master/include/whisper.h)
- [`whisper.cpp` MIT license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)
- [OpenAI Whisper repository and model license](https://github.com/openai/whisper)

### 5.3 首版不直接使用 stock whisper-cli

PoC 可以用 `whisper-cli` 验证模型、GPU和输出，但正式产品不应依赖：

- 控制台文案和 stderr 格式不是稳定协议。
- CLI 每个进程通常重新加载模型，不适合批处理复用 `large-v3`。
- 取消、错误分类、增量 segment、日志脱敏和协议兼容难以稳定测试。
- 上游 CLI 的直接 LRC/SRT 输出不包含 FusionKit 自己的字幕整形与产物交接语义。

因此正式架构使用 FusionKit 自有 runner，runner 只做：媒体 PCM 输入、模型驻留、推理、VAD、回调和结构化结果；字幕文件由 TypeScript 侧独立导出。

## 6. 最终架构

```text
Renderer
  LocalSubtitleTranscriber page
  local store / queue view / model manager view
        |
        | fixed preload methods + sender-bound tokens
        v
Preload: window.localSubtitleApi
        |
        v
Electron main: electron/main/local-subtitle/
  LocalSubtitleIpcService
  LocalSubtitleJobManager
  LocalSubtitleFileAuthorizations
  LocalSubtitleModelManager
  MediaNormalizer (FFmpeg)
  LocalSubtitleRunnerSupervisor
  SubtitlePostProcessor
  SrtExporter / LrcExporter / JsonExporter
  SubtitleArtifactRegistry
        |
        | private stdin/stdout JSONL
        v
fusionkit-local-subtitle-runner
  pinned whisper.cpp
  CPU / CUDA / Metal backend
  persistent model context
        |
        v
userData/local-subtitle/
  models/ accelerators/ jobs/ temp/ manifests/
```

### 6.1 模块职责

| 模块 | 职责 |
| --- | --- |
| Page | 配置、批量添加、队列、进度、结果预览和产物操作 |
| Renderer Store | 只持久化无敏感偏好；当前任务、token、路径和 segment 不持久化 |
| IPC Service | 验证请求、owner、token、状态迁移与错误白名单 |
| Job Manager | 串行 GPU 队列、逐文件失败隔离、取消、重试和应用退出清理 |
| Model Manager | 下载、续传、哈希校验、导入、删除、兼容性与占用状态 |
| Media Normalizer | 用 FFmpeg/ffprobe 把音频或视频规范为 16 kHz mono PCM16 WAV |
| Runner Supervisor | 启停 sidecar、协议握手、模型驻留、超时、崩溃恢复 |
| Post Processor | 把引擎段/词转换为稳定 cue，处理标点、长度、最短时长和重叠 |
| Exporters | 从同一 canonical transcript 原子输出 SRT/LRC/JSON |
| Artifact Registry | 发放输出 token、打开目录、交给字幕翻译器 |

### 6.2 引擎适配边界

main 内部保留一个小而稳定的接口，但首版只实现 `whisper_cpp`：

```ts
interface LocalSubtitleEngineAdapter {
  probe(): Promise<LocalSubtitleEngineProbe>;
  loadModel(model: LocalSubtitleModelRef): Promise<void>;
  transcribe(
    input: NormalizedMediaInput,
    options: LocalSubtitleInferenceOptions,
    events: LocalSubtitleEngineEventSink,
    signal: AbortSignal,
  ): Promise<LocalSubtitleTranscript>;
  unloadModel(): Promise<void>;
  shutdown(): Promise<void>;
}
```

该接口不进入 renderer，不在首版 UI 提供“随意切引擎”。它的作用是防止以后增加 Windows faster-whisper/Apple MLX 时重写任务、字幕和页面合同。

## 7. 用户交互设计

### 7.1 首次进入

页面先完成本地环境探测：

1. runner 是否存在、签名/版本/协议是否匹配。
2. 当前平台和架构。
3. 可用 backend：CUDA、Metal、CPU；Vulkan 如未发布则不显示。
4. 已安装模型、模型校验状态和磁盘占用。
5. FFmpeg 是否可用。

状态必须是可执行探测的结果，不展示无法更新的“未验证”徽标。

无模型时显示明确 CTA：

- 下载 `large-v3`。
- 下载较小模型。
- 导入本地 GGML 模型。

参考 GUI 使用的 CTranslate2 模型目录不能直接作为 whisper.cpp GGML 模型使用，UI 必须说明格式不同，不能让用户选择后才得到模糊加载失败。

### 7.2 主工作区

建议双栏结构：

- 左侧配置：模型、设备、语言、质量预设、VAD、输出格式、输出目录。
- 右侧工作区：批量拖拽、任务队列、当前进度、识别片段预览和结果操作。

核心字段：

| 字段 | 默认/规则 |
| --- | --- |
| 模型 | 已安装的 `large-v3` 优先；不自动改成量化模型 |
| 设备 | `auto`；展示实际解析为 CUDA/Metal/CPU |
| 语言 | `auto`，允许显式指定 |
| 任务 | `transcribe`；“翻译为英语”放高级区，避免与 FusionKit 字幕翻译混淆 |
| 质量预设 | `字幕质量优先`、`平衡`、`快速`；具体底层值由 PoC 固化 |
| VAD | 建议默认开启保守预设，最终阈值由真实样本验收确定 |
| 词时间戳 | 标准 SRT/LRC 不强制；启用“智能分句/逐词 LRC”时自动开启 |
| 输出格式 | SRT 默认；可多选 LRC |
| 输出目录 | 源文件目录或自定义目录 |
| 冲突策略 | 默认自动加序号，避免覆盖已有人工字幕 |

高级区只暴露有稳定产品意义的参数：初始提示词、beam size、temperature、VAD 最短静音、最大 cue 长度、每行最大字符、是否使用词时间戳。其余参数保留在内部预设，不复制参考 GUI 的全量参数墙。

### 7.3 批量队列

- 一次可添加多个音频/视频。
- 去重键使用本次授权的文件 identity，不只比较文件名。
- 默认 GPU 并发为 1；模型仅加载一次，文件串行执行。
- 每个任务展示：文件名、时长、状态、阶段、百分比、已用时间、实际 backend、输出格式和错误摘要。
- 一个文件失败不阻断后续文件，除非是 runner、模型损坏、磁盘不足等批次级错误。
- 支持取消当前文件、移除等待任务、重试失败任务、清理已完成任务。

### 7.4 完成操作

每个完成任务提供：

1. 在文件夹中显示。
2. 预览字幕。
3. 复制纯文本。
4. 一键送入字幕翻译。

“送入字幕翻译”默认将标准 SRT/LRC 作为等待任务导入字幕翻译器并跳转页面；它不自动执行翻译。若同时生成 SRT 和 LRC，默认推荐 SRT，并允许用户选择。

## 8. 状态与数据合同

### 8.1 任务状态

```ts
type LocalSubtitleTaskStatus =
  | "queued"
  | "preparing_media"
  | "loading_model"
  | "transcribing"
  | "post_processing"
  | "exporting"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";
```

允许的核心迁移：

```text
queued
  → preparing_media
  → loading_model（模型已驻留时跳过）
  → transcribing
  → post_processing
  → exporting
  → completed

任意运行阶段 → cancelling → cancelled
任意阶段 → failed
```

任务阶段和百分比分开表示，不能把 FFmpeg 30% 与 Whisper 30% 当作同一进度。建议总进度权重仅用于 UI：媒体准备 0–10%、模型装载 10–20%、转写 20–90%、后处理与导出 90–100%。实际事件同时携带 `stage` 和 `stageProgress`。

### 8.2 Canonical transcript

唯一时间事实来源使用整数毫秒：

```ts
interface LocalSubtitleWord {
  startMs: number;
  endMs: number;
  text: string;
  probability?: number;
}

interface LocalSubtitleSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words?: LocalSubtitleWord[];
  confidence?: number;
  speaker?: string;
}

interface LocalSubtitleTranscript {
  schemaVersion: 1;
  source: {
    displayName: string;
    durationMs: number;
  };
  model: {
    engine: "whisper_cpp";
    modelId: string;
    modelHash: string;
    backend: "cuda" | "metal" | "cpu" | "vulkan";
  };
  detectedLanguage?: string;
  languageProbability?: number;
  segments: LocalSubtitleSegment[];
}
```

不得把真实输入路径、模型绝对路径或临时 WAV 路径放进公开结果或 renderer 持久化。

### 8.3 错误合同

错误按稳定 code 分类：

- `runtime_missing`
- `runtime_protocol_mismatch`
- `runtime_crashed`
- `accelerator_unavailable`
- `model_missing`
- `model_incompatible`
- `model_corrupt`
- `model_download_failed`
- `model_disk_full`
- `media_probe_failed`
- `media_decode_failed`
- `unsupported_media`
- `transcription_failed`
- `out_of_memory`
- `output_conflict`
- `output_write_failed`
- `cancel_failed`
- `artifact_expired`

主错误文案可操作；stderr、退出码、backend 和阶段进入折叠技术详情。不得把完整命令行、用户路径、媒体内容或下载授权 header直接显示或写日志。

## 9. Preload、IPC 与权限边界

### 9.1 Renderer API

`window.localSubtitleApi` 只暴露固定方法，不暴露接收任意 channel 的 generic invoke：

```ts
interface LocalSubtitleApi {
  authorizeInputFiles(files: File[]): Promise<LocalSubtitleIpcResult<AuthorizedMedia[]>>;
  revokeInputFile(fileToken: string): Promise<LocalSubtitleIpcResult<{ revoked: boolean }>>;
  selectOutputDirectory(): Promise<LocalSubtitleIpcResult<AuthorizedOutputDirectory>>;
  probeRuntime(): Promise<LocalSubtitleIpcResult<LocalSubtitleRuntimeSummary>>;
  listModels(): Promise<LocalSubtitleIpcResult<LocalSubtitleModelSummary[]>>;
  installModel(request: InstallLocalSubtitleModelRequest): Promise<LocalSubtitleIpcResult<ModelJob>>;
  importModel(file: File): Promise<LocalSubtitleIpcResult<LocalSubtitleModelSummary>>;
  deleteModel(modelId: string): Promise<LocalSubtitleIpcResult<{ deleted: boolean }>>;
  enqueue(request: EnqueueLocalSubtitleBatchRequest): Promise<LocalSubtitleIpcResult<BatchSummary>>;
  cancelTask(taskId: string): Promise<LocalSubtitleIpcResult<{ cancelled: boolean }>>;
  revealArtifact(artifactToken: string): Promise<LocalSubtitleIpcResult<void>>;
  handoffArtifact(artifactToken: string): Promise<LocalSubtitleIpcResult<SubtitleHandoff>>;
  onTaskEvent(listener: (event: LocalSubtitleTaskEvent) => void): () => void;
}
```

文件路径只能由 preload 固定方法使用 `webUtils.getPathForFile()` 取得，再通过 preload-private channel 授权。TypeScript union 不是运行时安全边界。

### 9.2 Main 校验

- 每个 token 绑定 `webContents.id`、资源类型、过期时间和允许操作。
- 输入 token 支持批处理，但每个 task 开始时再次校验文件 identity、存在性和大小。
- 输出目录 token 只允许写入目录内部；最终路径必须 `resolve` 后检查仍在根目录下。
- `modelId` 只从 main 的已验证 manifest 解析，renderer 不能提交任意模型路径。
- 事件只发给任务 owner；窗口销毁时释放 token、取消任务并关闭 runner。
- 所有 request 使用运行时 schema 校验，拒绝未知字段，避免 renderer 偷渡 executable、path、backend flags 或任意 runner 参数。

## 10. Sidecar runner 协议

### 10.1 进程模型

- main 直接 `spawn()` runner，不经过 shell。
- runner 通过 stdin 接收 JSONL，通过 stdout 只输出 JSONL；stderr 只用于受控诊断。
- 一个 runner 同时只执行一个转写，但可跨多个任务保留同一模型 context。
- model/backend 变化时显式 unload/reload。
- main 与 runner 先完成 protocol handshake，版本不匹配立即失败，不尝试“凑合解析”。

### 10.2 协议示例

```json
{"protocol":1,"id":"cmd-1","type":"hello","client":"fusionkit","clientVersion":"0.2.11"}
{"protocol":1,"id":"cmd-2","type":"load_model","modelPath":"<main-private-path>","backend":"auto"}
{"protocol":1,"id":"cmd-3","type":"transcribe","inputPath":"<main-private-temp-wav>","options":{"language":"auto","vad":true,"wordTimestamps":true}}
{"protocol":1,"id":"cmd-3","type":"cancel"}
```

事件：

```json
{"protocol":1,"replyTo":"cmd-1","type":"hello_ok","runnerVersion":"1.0.0","engineVersion":"pinned-commit","capabilities":["metal","cpu","vad","word_timestamps"]}
{"protocol":1,"replyTo":"cmd-2","type":"model_loaded","backend":"metal"}
{"protocol":1,"replyTo":"cmd-3","type":"progress","value":42}
{"protocol":1,"replyTo":"cmd-3","type":"segment","segment":{"startMs":1200,"endMs":4380,"text":"..."}}
{"protocol":1,"replyTo":"cmd-3","type":"completed","detectedLanguage":"ja"}
```

### 10.3 取消与崩溃

runner 使用 `whisper_full_params.abort_callback` 或同版本等价机制检查原子取消标志。取消有两级：

1. 发送 `cancel`，等待短超时内返回 `cancelled`。
2. 未确认则终止 runner 进程，清理临时文件并在下一任务前重启；此时模型需要重新加载。

主进程维护 child handle，不使用参考 GUI 的“只改布尔标志”方案。应用退出、窗口销毁、renderer 崩溃和 update 安装前都执行同一 cleanup。

## 11. 模型与加速包管理

### 11.1 目录

```text
<userData>/local-subtitle/
  models/
    <model-id>/model.bin
    <model-id>/manifest.json
  vad/
  accelerators/
  downloads/*.part
  jobs/
  temp/
```

模型不进入 `localStorage`、asar 或 Git；Store 只保存 `modelId`。

### 11.2 安装流程

1. 从 FusionKit 内置的、版本化的模型 manifest 选择下载源、期望大小和 SHA-256。
2. 下载到 `.part`，支持 HTTP Range；服务端不支持 Range 时从头重新下载。
3. 校验文件大小和 SHA-256。
4. 通过 runner 做只读 metadata/load smoke。
5. 原子改名为最终文件并写 manifest。
6. 校验失败保留可重试状态，但不得把损坏文件标成 ready。

上游模型表提供的是其发布校验值；FusionKit 发布 manifest 仍应使用自己的 SHA-256 并锁定具体文件 URL，不以“同名模型”作为信任依据。

### 11.3 自定义导入

- 支持用户导入已有 GGML Whisper `.bin`。
- main 检查文件头、模型架构、模型大小、语言能力和 runner 可加载性。
- 导入后复制或移动到 managed models 目录，默认复制，避免原文件移动造成惊讶。
- 不支持把 faster-whisper/CTranslate2 模型目录误识别为 GGML。

### 11.4 平台加速包

推荐发布矩阵：

| 平台 | 基础 runner | 加速策略 |
| --- | --- | --- |
| Windows x64 | CPU runner 随应用 | 签名且校验的 CUDA accelerator pack 按需安装；后续 Vulkan |
| macOS arm64 | Metal runner 随应用 | 首版 Metal；Core ML encoder 作为后续可选模型资源 |
| macOS x64 | CPU runner 随应用 | 不承诺 GPU 加速 |

Windows CUDA runtime/DLL 的可再分发范围、包体和签名需要在 PRE PoC 中单独确认。不能把“开发机安装了 CUDA 所以可用”当作发行方案。

## 12. 媒体预处理

### 12.1 为什么需要 FFmpeg

`whisper.cpp` 当前 CLI 可直接处理部分音频格式，官方也提供可选 FFmpeg build；但产品需要稳定支持 mp4/mkv/mov/webm 等视频容器、不同音轨和损坏输入诊断。统一预处理更容易控制行为：

```text
source media
  → ffprobe 获取时长、音轨和 codec
  → ffmpeg 选择音轨
  → 16 kHz / mono / PCM16 WAV 临时文件
  → runner
```

### 12.2 进程规则

- 使用 `spawn(executable, args)`，不拼 shell 字符串。
- 使用 FFmpeg `-progress` 机器可读输出计算媒体准备进度。
- 关闭 stdin，避免隐藏式交互等待。
- 临时文件名使用 task UUID，不使用原文件名直接拼接。
- 转码成功后校验 WAV 头、采样率、通道数和非零时长。
- 取消、失败和下次启动时清理超期 temp。

### 12.3 FFmpeg 许可证

FFmpeg 二进制必须固定来源、构建选项、许可证文本和源码获取方式。优先使用独立进程方式和经过法务/许可证清单确认的构建，不随意采用未知来源的“静态包”。本文不是法律意见；发布前必须完成依赖许可证审计。

## 13. 字幕整形与导出

### 13.1 独立 canonical pipeline

runner 输出结构化段/词，不直接把上游生成的 `.srt/.lrc` 当最终产物：

```text
engine segments
  → normalize integer timestamps
  → trim/merge whitespace
  → punctuation-aware split/merge
  → enforce monotonic cues
  → SRT/LRC exporters
  → parse-back validation
  → atomic commit
```

这样可以让 Windows/macOS 和未来不同引擎生成一致格式，也方便测试时间边界。

### 13.2 字幕整形原则

- 不复制参考项目 `SubtitlesProcessor.py` 的 AGPL 实现。
- 使用全新的规则与测试：按语言选择 CJK/空格分词策略，在标点和词边界处分割。
- cue 的 `startMs >= 0`、`endMs > startMs`、整体单调不倒退。
- 相邻 cue 的轻微重叠按策略裁剪；不能静默制造负时长。
- 默认限制单 cue 时长和文本长度；短 cue 合并需同时满足间隔和阅读长度。
- 有词时间戳时在真实词边界分割；无词时间戳时按字符比例估时只作为 fallback，并在详细 JSON 标记 `estimatedTiming=true`。
- 整形预设和底层参数必须记录到任务 metadata，便于复现。

### 13.3 SRT

- 使用 `HH:MM:SS,mmm`。
- 序号从 1 开始。
- UTF-8，无 BOM 为默认；如以后支持 BOM，作为显式选项。
- 导出后由独立 parser 回读，验证块数、时间格式和顺序。

### 13.4 LRC

首版默认标准行级 LRC：

```text
[00:01.20]原文
[00:04.38]下一句
```

这与现有 `LRCTranslator` 的逐行翻译和双语同时间标签输出最兼容。

增强逐词 LRC 可作为显式高级格式：

```text
[00:01.20]<00:01.20>word <00:01.56>word
```

增强格式不能默认送入字幕翻译器，因为 LLM 翻译可能破坏内部逐词标签。若用户点击交接，UI 应提示改用标准 LRC 或 SRT。

### 13.5 原子写入与冲突

1. 写入同目录 `.partial`。
2. flush/close。
3. parse-back 校验。
4. 根据冲突策略覆盖或生成带序号文件名。
5. 原子 rename 为最终产物。

多格式输出应以一个 transcript 为源，各格式独立提交；一个格式失败不能删除已经成功的另一个格式，但任务需显示“部分完成”。

## 14. 与字幕翻译器的一键交接

### 14.1 不共享 Store

本地转写完成后，main 在 `SubtitleArtifactRegistry` 注册：

```ts
interface GeneratedSubtitleArtifact {
  artifactToken: string;
  ownerId: number;
  format: "SRT" | "LRC";
  displayName: string;
  outputPath: string; // main-private
  expiresAt: number;
}
```

本地工具调用固定 `handoffArtifact()`：

1. main 校验 owner、文件存在、扩展名和内容格式。
2. 创建一次性 `translationImportToken`。
3. renderer 把 token 放入非持久化的字幕 artifact inbox，然后导航到字幕翻译页。
4. 字幕翻译页通过自己的固定 IPC 消费 token，读取内容并创建 `WAITING` 任务。
5. token 消费后立即失效；字幕翻译器从此拥有自己的任务状态。

本地工具不调用 `useSubtitleTranslatorStore.addTask()`，也不读取模型 API Key、目标语言或翻译配置。

### 14.2 用户费用与控制

- 导入后展示源语言、目标语言、双语/仅译文、输出目录和预计费用。
- 用户确认“开始翻译”后才进入现有 translation execution service。
- 若字幕翻译配置缺失，显示现有配置 CTA，不回到本地转写工具修改。
- 交接失败不影响已经生成的字幕文件。

## 15. 持久化、恢复与资源清理

### 15.1 Renderer 持久化

只保存：

- 最近模型 ID。
- device preference（建议 `auto`）。
- 语言、VAD、质量预设、字幕整形和输出格式偏好。
- 输出模式和安全的目录显示名，不保存授权 token。

不保存：

- `File`、真实路径、输入 token、输出 token。
- segment/word 全量结果。
- runner stderr、临时 WAV 路径。

### 15.2 任务恢复

首版任务队列为会话级。异常退出后：

- 已原子提交的 SRT/LRC 保留。
- `.partial` 与临时 WAV 在下次启动清理。
- 未完成任务显示为上一会话中断的诊断摘要，用户需重新选择/授权源文件后从头重试。
- 不声称支持文件中间断点续跑。

### 15.3 内存与显存

- runner 每完成一个文件就把 canonical transcript 交给 main 并释放 PCM。
- main 导出后不长期持有全部批次的 word 数组；结果预览可分页或只保留摘要。
- 同一模型跨任务驻留；用户切模型、显存不足、空闲超时或应用进入更新时卸载。
- GPU 队列默认并发 1。CPU 并发属于后续高级能力，不能与 `num_workers` 混为一谈。

## 16. 打包与发布

### 16.1 建议资源布局

```text
resources/local-subtitle/
  win-x64/cpu/fusionkit-local-subtitle-runner.exe
  win-x64/cpu/*.dll
  mac-arm64/metal/fusionkit-local-subtitle-runner
  mac-x64/cpu/fusionkit-local-subtitle-runner
  ffmpeg/<platform>-<arch>/...
  licenses/...
```

开发环境和 packaged 环境统一通过一个 `resolveLocalSubtitleResourcePath()` 解析，不在业务代码散落 `process.cwd()` 或相对路径。

### 16.2 electron-builder

- 使用 `extraResources` 放到 asar 外。
- macOS 保留可执行位，并在签名/公证前放入最终 app bundle。
- Windows runner、DLL、FFmpeg 和许可证一起进入资源清单。
- 多架构产物名增加 `${arch}`，避免 mac-arm64/mac-x64 或不同 runner 资源互相覆盖。
- 不构建一个同时塞入所有平台二进制的超大通用安装包。

### 16.3 更新兼容

- app version、runner protocol、runner build、engine commit、model manifest version 分开记录。
- 新 app 启动时先检查 runner protocol，再允许任务。
- 模型兼容时保留；不兼容时提示重新下载或迁移，不静默删除数 GB 模型。
- accelerator pack 必须签名并校验，下载后的任意可执行文件不能只靠 SHA 文件名判断可信。

## 17. 安全、隐私与许可证

1. 推理全程默认离线；只有模型/加速包下载访问网络。
2. 下载 UI 显示来源、大小、版本和校验状态。
3. 不上传媒体、文本、时间戳或模型使用信息，除非未来另有明确 opt-in 设计。
4. 诊断日志对用户路径只显示 basename 或稳定 hash；不记录媒体内容。
5. runner 不监听 TCP 端口，使用父子进程 stdio。
6. sidecar 只接收 main 生成的私有路径；renderer 无法让它执行任意 binary 或参数。
7. `faster-whisper-GUI-main` 为 AGPL-3.0，只做 clean-room 行为参考。
8. `whisper.cpp` 与 `faster-whisper` 上游为 MIT；模型、FFmpeg、CUDA runtime、VAD 模型和发布二进制仍需逐项进入 `THIRD_PARTY_NOTICES` 与许可证审计。
9. 参考项目本地配置中出现的明文 token 不得复制到文档、测试 fixture 或提交历史。

## 18. 分期实施建议

本次只产出设计，不直接开始大规模实现。确认设计后再建立独立 execution plan。

### PRE-001：跨平台技术 PoC

- 固定 `whisper.cpp` 版本/commit。
- 在 Windows x64 NVIDIA、macOS arm64 Metal、CPU fallback 上运行同一批样本。
- 验证 `large-v3`、VAD、词时间戳、progress、abort 和模型重复使用。
- 验证 FFmpeg 音频/视频转码、中文/日文路径和长路径。
- 产出真实 RTF、峰值内存/显存、启动时间、准确度和包体数据。
- 决定 Windows CUDA runtime 是随包、可选 pack 还是要求系统环境。

只有 PRE-001 通过后才冻结正式架构中的 runner build 和模型清单。

### CORE-001：类型、协议与安全边界

- `localSubtitle.ts`、`localSubtitleIpc.ts`。
- fixed preload API、private file authorization channels。
- owner/token/schema/allowlist 测试。
- fake runner JSONL contract tests。

### BE-001：本地任务运行时

- Job Manager、Runner Supervisor、状态机、取消、退出清理。
- 模型驻留和单 GPU 串行队列。
- 稳定错误码和脱敏诊断。

### MODEL-001：模型管理

- 下载/续传/SHA-256/导入/删除/磁盘空间。
- `large-v3`、`large-v3-q5_0`、turbo 清单。
- VAD 模型管理。

### MEDIA-001：媒体规范化

- ffprobe/FFmpeg sidecar。
- 音轨选择、进度、取消、临时文件和格式错误。
- 音频/视频格式矩阵。

### SUB-001：字幕整形与导出

- canonical transcript。
- 全新 SRT/LRC formatter、parse-back、golden tests。
- 多语言分句、冲突策略、原子写。

### FE-001：独立工具页

- 新 route/tool metadata/menu/i18n。
- 模型状态、配置、批量队列、预览、错误和完成操作。
- 两种窗口尺寸和键盘可访问性。

### LINK-001：字幕翻译交接

- `SubtitleArtifactRegistry`、一次性 import token、artifact inbox。
- 导入 `WAITING` 任务，不自动调用外部 API。
- 交接失败与 token 过期处理。

### QA-001：真实发布矩阵

- Windows installer、macOS arm64、macOS x64 fallback。
- 签名、公证、asar 外资源、更新后模型保留。
- 真实长音频/视频、取消、OOM、磁盘不足、runner crash、批量部分失败。

## 19. 验证与验收策略

### 19.1 PoC 对比语料

使用用户实际“烤肉”场景构建脱敏样本集：

- 日语动画/访谈。
- 英语播客/演讲。
- 中文对话。
- 含 BGM、长静音、多人抢话、专有名词、低音量和噪声的样本。
- 短文件、1 小时以上长文件、视频容器和非 ASCII 路径。

同一 `large-v3`、尽量等价参数下对比现有 faster-whisper-GUI 基线：

- CER/WER。
- 语言检测。
- cue 数量、边界偏差、时间轴单调性。
- 实时系数 RTF。
- 峰值 RAM/VRAM。
- 模型首次/再次加载时间。

建议初始门槛：完整 `large-v3` 的 CER/WER 不比现有基线恶化超过 2 个百分点；所有输出格式 100% 可回读；声明支持的 GPU 目标机 RTF 小于 1。若硬件不满足速度门槛，UI 必须如实标记 CPU/低性能 fallback，不伪装成 GPU 成功。

### 19.2 单元与合同测试

- 时间戳毫秒转换：0、59.999、1 小时以上、浮点边界。
- SRT/LRC golden fixtures 与 parse-back。
- CJK/Latin 分句、标点、空文本、超长词、重叠和缺失词时间戳。
- 状态机非法迁移。
- task cancellation race、runner late event、旧 generation 事件丢弃。
- token owner、过期、重复消费、路径越界。
- 模型 `.part`、断点续传、哈希失败、磁盘不足。
- FFmpeg progress parser 和错误分类。
- fake runner protocol mismatch、乱码、非 JSON、崩溃和超时。

### 19.3 实施后的项目验证

```text
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vitest run test/local-subtitle src/store/tools/subtitle
node_modules/.bin/vite build --mode=test
git diff --check
```

原生 runner 另有 CMake build/test matrix；不能用 TypeScript 测试代替 native ABI、CUDA/Metal 和 packaged 资源验证。

Electron 视觉/交互验证必须等待 preload loading 完全退出。若启动 Vite/Electron，结束会话前关闭服务并确认无残留 runner、FFmpeg 或前端进程。

## 20. 主要风险与决策

| 风险 | 决策 |
| --- | --- |
| 把新工具做成 AudioTranscriber 的 local provider | 禁止；独立 route、Store、IPC、runtime、队列和配置 |
| macOS faster-whisper 无 GPU | 首版统一使用 whisper.cpp；Apple Silicon 用 Metal |
| Windows CUDA 运行库导致包体和安装失败 | PRE-001 验证签名可选 accelerator pack；CPU runner 保底 |
| 每个文件重载 large-v3 太慢 | 持久 runner，批次内模型驻留 |
| 解析 stock CLI 日志随上游变化 | 自有 JSONL runner 协议，固定 engine commit |
| 模型数 GB 拉大安装包 | 按需下载、续传、SHA-256、用户可删除/导入 |
| 视频格式复杂 | FFmpeg 统一转 16 kHz mono PCM16，保留机器可读进度 |
| 字幕分句效果不稳定 | canonical segment/word + 独立整形预设 + 真实语料 golden tests |
| LRC 逐词标签被翻译破坏 | 交接仅支持标准 LRC/SRT；增强 LRC 明确隔离 |
| 长任务取消卡住 | abort callback，超时后杀 runner 并重启 |
| renderer 注入任意路径/参数 | fixed preload methods、private channels、sender-bound token、拒绝未知字段 |
| AGPL 参考代码污染 | 只参考行为和参数，独立实现与测试，不复制代码 |
| FFmpeg/CUDA/model 许可证遗漏 | 发布前完整第三方清单和许可证审计 |
| Intel Mac 性能不足 | 提供 CPU fallback并明确性能边界，不承诺 GPU 等价体验 |

## 21. 不得违反的实现约束

1. 不得把本地字幕转写加入现有 `/tools/audio/transcriber` 页面或 `audio:*` IPC。
2. 不得复用 Audio API profile、assignment、provider route 或 route constraints 表达本地模型。
3. 不得让 renderer 提交真实路径、任意 executable、任意模型路径或任意 backend flags。
4. 不得在公开 preload bridge 暴露可调用内部 channel 的 generic invoke。
5. 不得把模型、CUDA 包、FFmpeg 或临时 WAV 放进 localStorage、asar 或默认安装包主体。
6. 不得每个文件启动一个会重新加载 `large-v3` 的独立 CLI 进程作为正式批处理架构。
7. 不得解析上游人类可读日志作为唯一进度和结果合同。
8. 不得用浮点字符串作为字幕时间轴事实来源；统一使用整数毫秒。
9. 不得直接复制 AGPL 参考项目的输出器、字幕切分器或 GUI 代码。
10. 不得自动启动字幕翻译并产生 API 费用；交接后由用户确认。
11. 不得把“模型文件存在”当作 ready；必须校验哈希和 runner 加载。
12. 不得把开发机 CUDA/FFmpeg 环境当作 packaged app 已支持。
13. 不得用 macOS CPU 可运行来宣称 macOS GPU 已支持；Apple Silicon Metal 必须真实验收。
14. 不得让一个文件失败清空整个批次已完成的字幕产物。
15. 不得在任务结束后遗留 runner、FFmpeg、临时文件或未撤销 capability。

## 22. 推荐下一步

先做 `PRE-001`，不要直接展开完整页面开发。PoC 最少回答五个问题：

1. 同一份 `large-v3` GGML 模型在目标 Windows NVIDIA 和 macOS Apple Silicon 上的准确度、RTF、RAM/VRAM 是否满足预期。
2. Metal/CUDA runner 如何进入签名后的 Electron 安装包，Windows CUDA runtime 最终采用哪种分发方式。
3. persistent runner 的 progress、segment、abort 和模型复用是否稳定。
4. FFmpeg 处理目标视频格式、中文/日文路径和长媒体是否稳定，许可证方案是否可发布。
5. 标准 SRT/LRC 经过新 formatter 后是否能无损进入当前字幕翻译器，并通过一次性 artifact token 完成导入。

PoC 通过后，再基于本文创建 `local-subtitle-transcriber_execution_plan.md`，按第 18 节拆分工作包实现。
