# 本地字幕转写工具调研与 Final Design

> 日期：2026-07-16
>
> Feature Slug：`local-subtitle-transcriber`
>
> 状态：调研与 Final Design 已完成，Execution Plan 已建立；尚未进入代码实现
>
> 产品定位：使用本地算力把批量音频/视频转成可直接翻译的 SRT/LRC 字幕
>
> 参考项目：`C:\Users\Administrator\Documents\GitHub\temp\faster-whisper-GUI-main`
>
> 2026-07-16 修订：补充“仅导出 / 自动加入字幕翻译队列 / 自动加入并开始翻译”三种后处理模式及配置快照边界
>
> 2026-07-16 计划：已创建 `local-subtitle-transcriber_execution_plan.md`，细化为 36 个实现/验收工作包

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
7. 转写完成后既可只导出 SRT/LRC，也可选择自动加入字幕翻译任务列表，并进一步选择是否自动开始翻译。交接必须通过会话级 `artifactRef`、一次性 `translationImportToken` 和字幕翻译模块自有的导入协调器完成；本地转写工具不得直接读写字幕翻译器 Store。自动执行默认关闭，只有用户显式选择“自动加入并开始翻译”时才允许产生外部 API 费用。
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
9. 支持把转写、字幕导出、字幕翻译排成可选的连续流水线，同时保证任一翻译交接或执行失败不影响已经成功导出的字幕产物。

### 1.3 非目标

1. 不改造现有外部 API 音频转文本工具。
2. 首版不做实时麦克风字幕；现有实时字幕工具有独立产品定位。
3. 首版不做 WhisperX 强制对齐、说话人聚类、Demucs 人声分离或完整字幕时间轴编辑器。
4. 首版不支持任务在单个文件中间断点续跑；应用重启后可保留已完成产物，但未完成文件从头开始。
5. 首版不默认自动启动字幕翻译；只有用户在本地转写批次中显式启用“自动加入并开始翻译”后，才可按字幕翻译工具的配置调用外部模型 API。
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

字幕翻译任务在加入队列时会固化任务执行模型、源/目标语言、双语/仅译文、切片策略、输出目录、冲突策略和分片并发等字段。当前这些“当前配置”分散在 `useSubtitleTranslatorStore`、`useModelStore`、页面局部 state 和若干 `subtitle-translator-*` localStorage key 中；要支持转写页在字幕翻译页未挂载时自动入队，`LINK-001` 必须先把安全的字幕翻译偏好收敛到字幕翻译模块自有的配置 Store/读取服务，再由导入协调器一次性取快照。本地转写模块不能直接读取这些 Store 或 localStorage key。

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
| Subtitle Translation Import Coordinator | 由字幕翻译模块拥有；获取当前翻译配置快照、消费一次性 import token、精确入队并按选项只启动本次导入任务 |

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
| 翻译衔接 | 默认“仅导出”；可选“自动加入翻译队列”或“自动加入并开始翻译” |
| 送翻译格式 | 只生成一种标准字幕时使用该格式；同时生成 SRT/LRC 时默认 SRT，可改为标准 LRC |

高级区只暴露有稳定产品意义的参数：初始提示词、beam size、temperature、VAD 最短静音、最大 cue 长度、每行最大字符、是否使用词时间戳。其余参数保留在内部预设，不复制参考 GUI 的全量参数墙。

### 7.3 批量队列

- 一次可添加多个音频/视频。
- 去重键使用本次授权的文件 identity，不只比较文件名。
- 默认 GPU 并发为 1；模型仅加载一次，文件串行执行。
- 每个任务展示：文件名、时长、状态、阶段、百分比、已用时间、实际 backend、输出格式和错误摘要。
- 一个文件失败不阻断后续文件，除非是 runner、模型损坏、磁盘不足等批次级错误。
- 支持取消当前文件、移除等待任务、重试失败任务、清理已完成任务。

#### 7.3.1 本地批次配置快照

点击“开始批次”时必须同时冻结成员列表和独立的 `LocalSubtitleBatchConfigSnapshot`：managed `modelId` + manifest/hash、device preference、语言、质量预设展开值、VAD/词时间戳/整形参数、输出格式、输出模式、冲突策略、`handoffFormat` 和 post-action mode。等待任务全部引用该不可变 snapshot；页面中途改模型、语言或预设只影响下一个批次，不能让同批文件悄悄使用不同参数。首版运行中新增的文件进入新的 draft batch，不加入 active batch；移除等待任务只做取消/释放，不改变其余成员的 snapshot。

`custom` 本地输出目录在 main 派生 batch-scoped write lease，和翻译目录 lease 分 registry、分权限、分生命周期；仅在同 owner/document session、批次 active 时有界续期。`source` 输出模式不伪造一个全局 lease，而是在每个文件开始前从其 authorized file identity 私下派生父目录写入目标并做权限/containment 检查；某一父目录不可写只失败该文件并给“选择自定义目录”CTA，不影响其他目录的文件。模型删除/替换、custom lease 过期或 snapshot 对应 manifest 改变属于批次级阻塞，停止启动新的等待项并给出重选/重新校验 CTA，不能切到其他模型或目录继续。失败任务默认按原 snapshot 重试；用户若要采用当前新配置，必须显式“用当前配置新建任务”，产生新 task generation。

### 7.4 完成操作

每个完成任务提供：

1. 在文件夹中显示。
2. 预览字幕。
3. 复制纯文本。
4. 一键送入字幕翻译。

批次配置区提供两个有依赖关系的开关：

1. `转写完成后自动加入字幕翻译任务列表`：默认关闭。开启后，每个文件的目标字幕产物导出成功即自动交接，无需等待整批转写结束。
2. `加入后自动开始翻译`：默认关闭，且只有第一个开关开启时才可用。开启时必须显示当前字幕翻译配置摘要和“将调用外部模型 API、可能产生费用”的明确提示。

组合后的产品语义只有三种，不允许出现“未加入但自动开始”的无效状态：

| 模式 | 导出字幕文件 | 加入字幕翻译列表 | 自动执行翻译 |
| --- | --- | --- | --- |
| `export_only`（默认） | 是 | 否 | 否 |
| `enqueue_translation` | 是 | 是 | 否 |
| `enqueue_and_start_translation` | 是 | 是 | 是，仅启动本次成功导入的任务 |

完成卡片中的“一键送入字幕翻译”继续保留，供 `export_only` 后手动补交，或自动交接失败后重试。每个文件每次交接只允许选择一个 `handoffFormat`，且必须属于本批启用的标准输出格式；若同时生成 SRT 和 LRC，默认推荐 SRT，并允许用户改选标准 LRC，增强型逐词 LRC 不得自动交接。多格式部分成功时只看所选格式：所选格式原子提交成功即可交接，所选格式失败则不拿另一个格式静默替代，并在完成卡提示用户改选后手动重试。

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

字幕翻译交接不是本地转写状态机的运行阶段。导出成功后本地任务即为 `completed`，交接另行记录，避免外部 API 配置或网络错误把已经成功的本地转写误标为失败：

```ts
type SubtitleTranslationHandoffMode =
  | "export_only"
  | "enqueue_translation"
  | "enqueue_and_start_translation";

type SubtitleTranslationImportStatus =
  | "not_requested"
  | "pending"
  | "importing"
  | "queued"
  | "skipped"
  | "failed";

type SubtitleTranslationStartStatus =
  | "not_requested"
  | "requesting"
  | "started"
  | "waiting"
  | "failed";

interface LocalSubtitlePostActionState {
  mode: SubtitleTranslationHandoffMode;
  preferredFormat?: "SRT" | "LRC";
  importStatus: SubtitleTranslationImportStatus;
  startStatus: SubtitleTranslationStartStatus;
  importReceiptId?: string;
  translationTaskId?: string;
  importErrorCode?:
    | "config_invalid"
    | "artifact_expired"
    | "duplicate"
    | "import_failed";
  startFailureReason?:
    | "estimate_failed"
    | "profile_unavailable"
    | "authorization_expired"
    | "start_rejected";
}
```

import 与 start 必须分开记录：任务成功加入但启动失败时保持 `importStatus = "queued"`、`startStatus = "failed"`，完成卡应跳转/重试该 `translationTaskId`，不能重新导入制造重复任务；只有没有 `translationTaskId` 的 import 失败/过期才直接显示“重新交接”。“查看任务”时由字幕翻译模块按 ID 查询存在性；若用户已删除任务，保持原回执不可变，显示“任务已移除”，用户明确点击重新交接后创建新 snapshot/handoffKey。`started`/`waiting` 仅表示字幕翻译队列接受了启动请求，本地工具不镜像后续翻译成功/失败状态。

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
  revealArtifact(artifactRef: string): Promise<LocalSubtitleIpcResult<void>>;
  handoffArtifact(artifactRef: string): Promise<LocalSubtitleIpcResult<SubtitleHandoff>>;
  onTaskEvent(listener: (event: LocalSubtitleTaskEvent) => void): () => void;
}
```

文件路径只能由 preload 固定方法使用 `webUtils.getPathForFile()` 取得，再通过 preload-private channel 授权。TypeScript union 不是运行时安全边界。

### 9.2 Main 校验

- 每个 token 绑定 `webContents.id`、main 为当前 document/frame 签发的 `ownerSessionId`、资源类型、过期时间和允许操作。`ownerSessionId` 只保存在 preload 私有闭包，由固定 API 隐式附加，renderer 不能自填；reload、主框架导航、frame/window 销毁时立即失效，不能仅靠 `webContents.id` 区分新旧文档。
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

### 10.4 Backend 解析与 fallback

- `devicePreference = "auto"` 在批次 commit 前根据签名 artifact manifest、真实 runner probe、accelerator pack 和模型兼容性解析为 CUDA/Metal/CPU，并把 `resolvedBackend` 明确展示并写入批次 snapshot；没有可用加速时可解析为 CPU，但用户在点击开始前必须看得到。
- 用户显式选择 CUDA/Metal 时不可回退 CPU。auto 已 commit 后若 GPU load/OOM/driver/crash，批次暂停且不启动后续文件；UI 提供“以 CPU 新 generation 重试”，需要用户确认预期性能变化，不能在后台把长任务静默改跑 CPU。
- 每个 runner event 和最终任务 metadata 携带实际 backend/build ID。probe 声称 GPU 但执行证据不一致视为 `backend_mismatch`，不得显示成功加速。

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

模型不进入 `localStorage`、asar 或 Git；renderer Store 只保存 `modelId`。`modelId` 由 main 通过受信 manifest 解析到 managed models 目录中的文件，不保存用户最初选择的外部 `.bin` 绝对路径，也不允许 renderer 在运行时传入任意模型路径。

### 11.2 内置清单下载与安装流程

模型管理页提供单次用户操作即可开始的下载 CTA；安装 FusionKit、首次启动应用或只是打开工具页都不得自动下载模型。用户发起下载后，应用在后台完成以下受控流程：

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
- 导入后复制或移动到 managed models 目录，默认复制，避免原文件移动造成惊讶；选择移动必须显式确认，且仍先完成受管临时复制、校验和原子提交，只有提交成功后才删除源文件，任一步失败都保留源文件。
- 原子提交后，运行时只依赖 managed file，不继续引用原始外部路径。默认复制会同时占用原文件和 managed copy 的磁盘空间，导入前必须展示空间预检与预计新增占用。
- 不支持把 faster-whisper/CTranslate2 模型目录误识别为 GGML。

### 11.4 平台加速包

推荐发布矩阵：

| 平台 | 基础 runner | 加速策略 |
| --- | --- | --- |
| Windows x64 | CPU runner 随应用 | 签名且校验的 CUDA accelerator pack 按需安装；后续 Vulkan |
| macOS arm64 | Metal runner 随应用 | 首版 Metal；Core ML encoder 作为后续可选模型资源 |
| macOS x64 | CPU runner 随应用 | 不承诺 GPU 加速 |

Windows CUDA runtime/DLL 的可再分发范围、包体和签名需要在 PRE PoC 中单独确认。不能把“开发机安装了 CUDA 所以可用”当作发行方案。

### 11.5 模型支持范围与加载生命周期

内置下载能力使用版本化 allowlisted manifest，不把“whisper.cpp 上游存在某个模型”直接等同于“FusionKit 已支持一键下载”。首版计划验证并提供以下候选：

| 模型 | 定位 | 首版文档口径 |
| --- | --- | --- |
| `large-v3` | 质量优先基准 | 计划内 |
| `large-v3-q5_0` | 较低磁盘与内存占用 | 计划内，必须说明量化取舍 |
| `large-v3-turbo` | 速度优先 | 计划内，性能与质量需 PoC 固化 |
| `large-v3-turbo-q5_0` | 轻量快速预览 | 候选，需 PoC 后决定是否进入首发下载清单 |

`tiny`、`base`、`small`、`medium` 等其他 Whisper GGML 模型可在 runner 兼容、manifest 来源/哈希和真实质量验收完成后加入；在此之前不得笼统宣称支持所有 Whisper 或 whisper.cpp 模型。用户导入的兼容 GGML 模型通过 header、架构、大小、语言能力和 load smoke 后可以形成 managed model，但“允许自定义导入”不等于该型号自动进入 FusionKit 内置下载清单。

模型生命周期固定为：

1. 安装、更新或启动应用时不把数 GB 模型打进安装包，也不急切加载推理模型；启动阶段只做 schema/manifest 兼容检查与孤儿资源清理。
2. 打开本地字幕转写页时只探测 runner/backend、FFmpeg、已安装模型状态与磁盘占用；不得仅因进入页面就发送 `load_model`。
3. 下载或导入完成时允许 runner 做一次受控 load smoke 来判定 ready，校验结束后立即释放，不把它当成会话推理模型驻留。
4. 用户开始批次时，main 根据冻结的 `modelId` + manifest/hash 解析 managed file，并向 runner 发送 `load_model`；同一 model/backend 已驻留时跳过装载阶段。
5. 同一 runner 跨本批及后续兼容任务复用已加载模型。切换 model/backend、空闲超时、显存不足、窗口销毁、应用退出或进入更新时显式卸载/关闭。
6. 应用重启后内存中的模型 context 不存在；只恢复最近 `modelId` 偏好，下一次真正开始任务时重新加载。

因此产品语义是“managed model + 持久化 `modelId` + 按任务加载并跨任务复用”，不是“只记录用户原始 `.bin` 路径并在每次打开应用或工具页时自动加载”。

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

### 12.2 音轨选择

- ffprobe 只向 renderer 返回脱敏的音轨摘要：受控 `streamId`、default disposition、语言、标题、codec、声道和采样率，不返回媒体路径或可注入的 FFmpeg selector。
- 默认 `auto`：优先容器中唯一标记为 default 的音轨；没有或存在多个 default 时选第一条音轨，并在任务启动前显示“自动选择了第 N 轨”。无音轨直接返回 `no_audio_stream`。
- 多音轨文件允许用户在启动前按文件覆盖；renderer 只提交 probe 返回的 `streamId`，main 必须校验它仍属于同一 authorized file identity。批量偏好只保存 `auto`，不能把某个文件的 stream index 持久化给其他文件。
- probe 与 ffmpeg 启动之间若文件 identity 或流表变化，拒绝执行并要求重新 probe，不能让旧 streamId 指向新内容。

### 12.3 进程规则

- 使用 `spawn(executable, args)`，不拼 shell 字符串。
- 使用 FFmpeg `-progress` 机器可读输出计算媒体准备进度。
- 关闭 stdin，避免隐藏式交互等待。
- 临时文件名使用 task UUID，不使用原文件名直接拼接。
- 转码成功后校验 WAV 头、采样率、通道数和非零时长。
- 取消、失败和下次启动时清理超期 temp。

### 12.4 FFmpeg 许可证

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

## 14. 与字幕翻译器的可选自动衔接

### 14.1 不共享 Store

本地转写完成后，main 在 `SubtitleArtifactRegistry` 注册：

```ts
interface GeneratedSubtitleArtifactRecord {
  artifactRef: string;
  ownerId: number; // main-private
  ownerSessionId: string; // main-private
  format: "SRT" | "LRC";
  displayName: string;
  outputPath: string; // main-private
  byteSize: number; // main-private integrity metadata
  sha256: string; // main-private integrity metadata
  expiresAt: number;
}

interface GeneratedSubtitleArtifactSummary {
  artifactRef: string;
  format: "SRT" | "LRC";
  displayName: string;
  expiresAt: number;
}
```

main 只把 `GeneratedSubtitleArtifactSummary` 返回 renderer，record 的 owner、路径、size/hash 不跨信任边界。`artifactRef` 是 owner-bound、operation-checked、可撤销的会话级引用，可供结果卡 reveal 或请求交接，但不包含路径且不持久化；清除结果、窗口销毁、应用退出或 TTL 到期即失效。每次 `handoffArtifact(artifactRef)` 都由 main 以 no-follow/containment 方式重新打开文件，核对 identity、大小、SHA-256、格式、UTF-8、cue 数和固定最大字节数；不一致返回 `artifact_changed`/`content_too_large`，不得导入被替换内容。校验成功后把不可变字幕文本快照放进短 TTL、one-shot `translationImportToken` 对应的 main 内存记录，不再让 token 消费阶段重读路径。消费成功或失败后 token 都不能复用；自动/手动重试必须在 artifactRef 仍有效时重新校验并申请新 token。这样既允许完成卡重试，又不把可重放的跨工具 token 长期留在 renderer。

`displayName` 必须由 main 对最终 `outputPath` 取安全 leaf 后生成，拒绝路径分隔符、`.`/`..`、控制字符、设备名和超长名称；renderer 传回的 fileName 只用于显示，不能参与路径拼接。字幕翻译写入器使用 registry 中的安全 stem，在 target directory 下重新 `resolve` 并做 containment/symlink 检查后再原子写入。

本地工具只把一次性 token 和用户选择的交接模式交给字幕翻译模块公开的 `GeneratedSubtitleImportCoordinator`；它不调用 `useSubtitleTranslatorStore.addTask()` / `startAllTasks()`，也不读取模型 API Key、目标语言、输出目录或任何 `subtitle-translator-*` localStorage key。

### 14.2 “当前配置”的定义与快照时机

“使用字幕文件翻译工具当前的配置”定义为：用户开始本地转写批次时，由字幕翻译模块一次性读取并冻结的配置；同一批次后续逐文件完成时都使用该快照，避免用户中途修改翻译页导致同一批文件使用不同语言或模型。对已经完成的任务手动点击“一键送入字幕翻译”时，则在点击当下重新取一次快照。

快照字段包括：

```ts
interface SubtitleTranslationImportConfigSummary {
  snapshotId: string;
  createdAt: number;
  handoffMode: Exclude<SubtitleTranslationHandoffMode, "export_only">;
  taskProfileId?: string;
  taskProfileLabel?: string;
  sourceLang: TranslationLanguage;
  targetLang: TranslationLanguage;
  translationOutputMode: TranslationOutputMode;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  outputMode: OutputPathMode;
  outputDirectoryLabel?: string;
  conflictPolicy: OutputConflictPolicy;
  concurrentSlices: boolean;
}
```

- `outputMode === "source"` 时，由 main 根据私有 artifact 的父目录派生任务级输出目录 capability；`custom` 时使用字幕翻译工具通过修复后的目录选择器取得、当前仍有效的 translator-owned capability。公开摘要只包含 `outputDirectoryLabel`，不得包含 token 或真实路径。
- 现有持久化 `outputURL` 在分阶段迁移中只用于保持旧版/手动任务行为，不能被自动提升为目录 capability，也不能复制进新配置 Store。先把脱敏 label 和 `needsDirectoryAuthorization` 安全写入新 Store，待新目录 picker、task target ref 和回滚测试全部通过后，再从旧 Store/localStorage 删除 raw path；任一步失败都保留 legacy 源值并禁用自动 `custom`，不得处于“旧值已删、新值不可用”的半迁移状态。应用重启、capability 过期或授权被撤销后，`custom` 自动交接必须要求用户重新选择目录；不得把旧 raw path 发送到内部授权 channel 重新换取权限。
- 创建快照时，字幕翻译模块从当前 `taskExecution` profile 解析任务执行模型，并沿用现有 `createSubtitleTaskModelFields()` 逻辑生成私有模型字段。私有快照可在协调器内存中包含执行所需密钥，但不得持久化、不得返回本地转写模块；本地转写 Store 只持有上面的脱敏摘要和不透明 `snapshotId`。
- Whisper 检测到的语言只作为差异提示，不静默覆盖字幕翻译工具配置的 `sourceLang`。用户选择的翻译配置始终优先。
- 页面需要把当前分散的安全偏好迁移到字幕翻译模块自有的 `useSubtitleTranslatorConfigStore`（或等价读取服务）；API Key 仍归 `useModelStore`，不得复制进该持久化配置 Store。
- `prepareBatch` 必须显式等待字幕配置 Store 和 `useModelStore` 完成 hydrate/migration，再读取一次原子快照；超时或迁移失败返回 `configuration_not_ready` 并阻止批次进入自动交接模式，不能把初始化默认值误当成用户“当前配置”。
- 快照摘要至少展示模型名称、源语言→目标语言、双语/仅译文、切片模式和输出位置。若自动执行所需配置不完整，`enqueue_and_start_translation` 不可启用，并提供前往字幕翻译/模型设置的 CTA。
- `custom` 模式在 `prepareBatch` 时从当前目录 capability 派生 snapshot-bound batch lease；用户随后修改字幕翻译页目录不会改变已启动批次。lease 只能在同 owner、窗口存活且批次仍 active 时由 main 有界续期，并设最大墙钟寿命；过期后后续文件交接失败并要求重新授权，不能从 label/旧路径续权。
- 私有快照生命周期绑定本地转写批次，批次结束、取消、窗口销毁或超时即释放；它不能放进 localStorage。当前首版不续跑未完成文件，因此应用重启后不得尝试使用已经失效的快照静默自动翻译。

### 14.3 导入与精确启动流程

1. 批次启动先校验 draft 成员并暂存模型锁和输出 lease，再由字幕翻译导入协调器做配置预检；成功后把不透明 `snapshotId`/摘要写进不可变本地 batch snapshot，最后一次性 commit 为 active。任一环节失败都按逆序释放 start-scoped translation snapshot/local lease/model lock，不能留下“翻译快照已占用但本地批次未启动”的半提交状态；仍显示在 draft 中的 input refs 回到 draft 所有权，方便修复配置后重试，只有用户清空/离页时才撤销。
2. 每个文件完成标准 SRT/LRC 原子导出后，main 在 `SubtitleArtifactRegistry` 注册产物并校验 owner、文件存在、扩展名和内容格式。
3. `handoffArtifact()` 创建一次性 `translationImportToken`；协调器以该 token 和 `snapshotId` 消费产物。
4. main 消费 token 后生成候选 `taskId`/`handoffKey`，只向协调器返回已校验的字幕内容、展示名、无路径 source 标记和不透明 target 引用，不返回真实路径；协调器必须使用该 `taskId` 构造字幕翻译任务、尝试计算初始费用估算并通过字幕翻译队列的批量导入 API 入队，最后返回包含新增、未启动、等待、已启动及失败明细的 `SubtitleTranslationImportReceipt`。
5. `enqueue_translation` 到此结束，任务保持 `NOT_STARTED`，用户可稍后在字幕翻译页检查、编辑和开始。
6. `enqueue_and_start_translation` 只能调用新的 `startImportedTasks(addedTaskIds)`（或逐一调用等价精确 API），沿用现有最大并发与 `WAITING` 队列；不得调用 `startAllTasks()`，否则会意外启动用户此前手动放在列表中的任务。
7. import token 消费后立即失效。只有 `addedTaskIds` 对应的 target handle 才把所有权转给字幕翻译器；duplicate、校验失败、add 失败或协调器异常的候选 handle 必须立即撤销，不能等待 TTL。导入不要求自动跳转页面，但完成卡片应提供“查看翻译任务”。

本地批次取消只停止尚未完成的转写和未来交接，不取消已经出现在 `addedTaskIds` 的字幕翻译任务；这些任务已由字幕翻译器拥有，用户需在字幕翻译页单独取消。取消与 import commit 竞态以原子回执为界：commit 成功则保留并展示 taskId，commit 前取消则撤销候选 handle 且不入队，不能出现“实际已入队但本地 UI 显示未入队”的未知状态。

导入 API 必须返回实际新增任务身份，`SubtitleTranslatorTask` 必须增加稳定 `taskId`；`fileName` 只用于展示，不能再承担 queue operation、active-task tracking 或重复判定。main 为每个 artifact/format/snapshot 组合生成不含路径的 `handoffKey`，同一交接重试只允许入队一次。handoffKey 的提交必须与任务入队原子完成：入队前失败不占用 key，允许新 token 重试；任务已入队但回执丢失时，同 owner/snapshot 的精确重试返回缓存的原始不可变回执，既不再建任务也不再次发起 start；同 key 但 task/content/owner 不一致则作为冲突拒绝。receipt registry 至少在 snapshot 生命周期内保留该 key，即使用户删除已入队任务也不能让自动重试静默重建。不同路径的同名文件、同一基名的 SRT/LRC 或用户明确创建新快照后重新交接都不能被误判为旧任务。自动执行只使用 `addTask` 回执中的 `addedTaskIds`。

建议的协调器与回执合同：

```ts
type AutomaticSubtitleTranslationHandoffMode = Exclude<
  SubtitleTranslationHandoffMode,
  "export_only"
>;

type PrepareGeneratedSubtitleImportResult =
  | {
      ok: true;
      snapshot: SubtitleTranslationImportConfigSummary;
      canAutoStart: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      code:
        | "configuration_not_ready"
        | "directory_authorization_required"
        | "profile_required";
      warnings: string[];
    };

interface GeneratedSubtitleImportCoordinator {
  prepareBatch(
    mode: AutomaticSubtitleTranslationHandoffMode,
  ): Promise<PrepareGeneratedSubtitleImportResult>;
  importArtifact(request: {
    translationImportToken: string;
    snapshotId: string;
  }): Promise<SubtitleTranslationImportReceipt>;
  releaseBatch(snapshotId: string): Promise<void>;
}

interface SubtitleTranslationImportReceipt {
  receiptId: string;
  snapshotId: string;
  addedTaskIds: string[];
  startedTaskIds: string[];
  waitingTaskIds: string[];
  notStartedTaskIds: string[];
  startFailures: Array<{
    taskId: string;
    reason:
      | "estimate_failed"
      | "profile_unavailable"
      | "authorization_expired"
      | "start_rejected";
  }>;
  skipped: Array<{
    displayName: string;
    reason:
      | "duplicate"
      | "unsupported_format"
      | "artifact_expired"
      | "artifact_changed"
      | "content_too_large"
      | "invalid_content";
  }>;
}

interface GeneratedSubtitleTranslationTaskRefs {
  taskId: string;
  handoffKey: string;
  source: {
    kind: "generated_content";
    displayName: string;
  };
  target: {
    kind: "authorized_directory";
    token: string;
    displayLabel: string;
  };
}
```

`export_only` 不创建翻译快照。其余两种模式只在 `prepareBatch` 成功时获得 snapshot，且 `handoffMode` 在 snapshot 内冻结；`importArtifact` 故意不接收 `autoStart`，调用方不能把 enqueue-only 快照临时升级为付费执行。预检失败时 UI 可让用户修复配置，或明确改选较低权限模式并重新 prepare；不能静默降级后继续显示原模式。`releaseBatch` 必须 await，失败时沿用 capability cleanup 的有界重试；它撤销 snapshot、batch lease 和未转移候选 handle，但不得撤销已经出现在 `addedTaskIds`、所有权已转给字幕任务的 target handle。

回执必须满足集合不变量：`startedTaskIds`、`waitingTaskIds`、`notStartedTaskIds` 两两不交且并集恰好等于 `addedTaskIds`；`startFailures[].taskId` 只能出现在 `notStartedTaskIds`，`skipped` 项不能伪造 taskId。`enqueue_translation` 的全部新增任务进入 `notStartedTaskIds`；`enqueue_and_start_translation` 才允许出现 started/waiting，任何竞态或部分失败都通过同一不可变回执表达，不能靠 UI 猜测队列状态。`started` 只表示执行请求已被接受，不表示翻译成功；请求接受后的 API/解析/写入失败走原有任务失败状态，不回写或篡改导入回执。

`taskId`、`handoffKey` 和 target handle 都由 main 在消费 import token 后一次性生成，协调器不得替换 ID 或把 handle 绑定到另一个任务。生成任务的 `source` 只是“内容来自已校验生成产物”的无路径标记；字幕文本已在消费一次性 `translationImportToken` 时读入会话级任务，后续执行不再需要 source path 或第二个 source token。`target.token` 才是 main 随导入签发的 task-scoped directory handle，和一次性 import token 不是同一个 token。它绑定 owner、`taskId`、写操作和有界会话租约；任务未入队、终态、删除、窗口销毁或租约超时即撤销，写入前仍要重新校验目录和 owner。租约过期后启动任务必须返回 `authorization_expired`；字幕翻译页提供固定的“重新授权输出目录”，main 只允许为同 owner、仍在队列且未终态的同一 `taskId` 原子轮换 target handle，成功后立即撤销旧 handle。不得用显示名、历史路径或快照静默续权，也不得借重授权改变 `taskId`/`handoffKey`。

生成字幕任务在 renderer/Store 中只保存上述无路径 source 标记和不透明 target 引用；真实 target path 只在 main 的翻译执行适配层解析，source path 从不进入任务。现有手动/历史恢复任务可在兼容期继续使用 path 字段，但 schema 必须禁止 generated source 或 authorized target 同时携带 path 和 token，且自动交接不得通过“先换出 raw path、再填旧字段”绕过该边界。生成任务的恢复清单不得持久化 artifact path 或 capability token；已启动任务一律使用自包含的 `manifest_fragments` 保存恢复输入，renderer 侧的 `checkpointPath` 替换为 main 签发的 owner/session-bound `checkpointRef`。跨重启时用户通过固定恢复文件选择/扫描入口重新取得 ref，并重新授权目标目录；main 只返回展示信息和恢复摘要，不返回 manifest/output path。尚未启动的 `enqueue_translation` 任务沿用现有字幕翻译队列的会话级语义：应用重启后不恢复该队列，已导出的 SRT/LRC 仍保留，用户可重新手动导入。缺少自包含分片或新目录授权时，把任务标记为需要重新导入/授权，而不是猜测路径或静默扩权。

### 14.4 用户费用、失败与重试

- 默认始终是 `export_only`；记住自动执行偏好时仍应在每个新批次开始前展示模式，不得把一次授权升级为全局静默调用外部 API。
- `enqueue_and_start_translation` 是对当前批次的明确授权。启动前展示配置摘要和费用提示；得到字幕内容后的精确预计费用写入字幕翻译任务并可在翻译页查看。
- `enqueue_translation` 可以在未配置任务执行模型时使用，但摘要需提示“加入后需配置模型”；`enqueue_and_start_translation` 必须有可用的任务执行 profile 和 API Key。
- `enqueue_translation` 的费用估算失败不阻止入队，任务保留 `costEstimate.loading = false` 和可重试提示。`enqueue_and_start_translation` 若精确估算或启动前校验失败，任务仍保留在 `NOT_STARTED`，写入 `notStartedTaskIds`/`startFailures`，不得调用外部 API，也不得撤销已入队任务仍持有的 target handle。
- 导入失败、token 过期、重复项、翻译启动失败或后续翻译失败，都不回滚、不删除已导出的 SRT/LRC，也不把本地转写任务从 `completed` 改为 `failed`。
- 自动导入失败时保留完成卡片和有效 `artifactRef` 的可重试路径；用户可修复字幕翻译配置后，按当时的当前配置重新 prepare，并申请新的 one-shot import token 执行手动交接。
- 一批中只对成功导入的项请求启动；部分失败不阻断其余项，也不清空字幕翻译器原有队列。
- `enqueue_translation` 只保证加入当前会话的现有内存队列；应用重启不会恢复尚未启动的自动导入任务。产品必须在模式说明和完成回执中明确这一点，不能把“加入列表”表述为跨重启持久化。

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

## 18. 分期实施建议（高层阶段）

本节保留架构层面的阶段划分；可认领的工作包、依赖、状态、验证和实施记录以 `local-subtitle-transcriber_execution_plan.md` 为唯一执行台账。Execution Plan 已于 2026-07-16 建立，当前所有实现工作包仍为 `未开始`。

其中本节原先汇总为一个 `PRE-001` 的跨平台 PoC，在 Execution Plan 中拆为 `PRE-001`～`PRE-006`，以避免把基准、CPU runner、Windows CUDA、macOS Metal、FFmpeg/打包许可和最终技术冻结塞进一个无法单会话闭环的工作包。其余高层包也在执行计划中按安全边界和可验证纵向切片进一步拆分。

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

- `SubtitleArtifactRegistry`、一次性 import token、字幕翻译模块自有的导入协调器。
- 收敛字幕翻译当前偏好并生成批次级配置快照；本地转写侧只持有脱敏摘要和不透明 `snapshotId`。
- 生成任务使用无路径 source 标记和 main-only 解析的不透明 target 引用；旧 `outputURL` 不得自动升级为目录授权，恢复清单不持久化路径或 capability。
- 实现 `export_only`、`enqueue_translation`、`enqueue_and_start_translation` 三种模式。
- 自动执行只启动当前 import receipt 实际新增的 `taskId`，不调用 `startAllTasks()`。
- 批量导入返回稳定任务 ID；自动模式只启动本次成功导入任务，不触碰原有待执行队列。
- 覆盖配置缺失、重复项、部分导入失败、token 过期、启动失败与手动重试。

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
- 三种翻译衔接模式、批次配置快照、配置中途修改不影响已开始批次。
- 自动执行只启动 import receipt 中的任务；原有 `NOT_STARTED` 任务、重复同名任务不得被误启动。
- 翻译配置无效、导入部分失败和启动失败不影响本地任务 `completed` 与已导出产物。
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
| 自动翻译意外产生费用或启动旧任务 | 默认仅导出；每批显式授权并展示配置/费用提示；按 import receipt 精确启动，禁止 `startAllTasks()` |
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
10. 不得默认自动启动字幕翻译；只有当前批次显式选择 `enqueue_and_start_translation` 才可产生 API 费用，且只能启动本次 import receipt 中确认新增的任务。
11. 不得把“模型文件存在”当作 ready；必须校验哈希和 runner 加载。
12. 不得把开发机 CUDA/FFmpeg 环境当作 packaged app 已支持。
13. 不得用 macOS CPU 可运行来宣称 macOS GPU 已支持；Apple Silicon Metal 必须真实验收。
14. 不得让一个文件失败清空整个批次已完成的字幕产物。
15. 不得在任务结束后遗留 runner、FFmpeg、临时文件或未撤销 capability。
16. 不得把 artifact/目录/checkpoint capability 解包成 renderer raw path 以适配旧 `originFileURL`、`targetFileURL` 或 `checkpointPath`；旧 `outputURL` 也不是新授权来源。
17. 不得让 `importArtifact` 调用方临时传入或修改 auto-start；是否调用外部 API 只能来自当前批次成功 prepare 后冻结的 `handoffMode`。
18. 不得把可重试的 session `artifactRef` 当成 one-shot import token；跨工具的 `translationImportToken` 必须短 TTL、消费即失效且内容快照在 main 清零。

## 22. 推荐下一步

先做 `PRE-001`，不要直接展开完整页面开发。PoC 最少回答五个问题：

1. 同一份 `large-v3` GGML 模型在目标 Windows NVIDIA 和 macOS Apple Silicon 上的准确度、RTF、RAM/VRAM 是否满足预期。
2. Metal/CUDA runner 如何进入签名后的 Electron 安装包，Windows CUDA runtime 最终采用哪种分发方式。
3. persistent runner 的 progress、segment、abort 和模型复用是否稳定。
4. FFmpeg 处理目标视频格式、中文/日文路径和长媒体是否稳定，许可证方案是否可发布。
5. 标准 SRT/LRC 是否能通过 session `artifactRef` + one-shot `translationImportToken` 按三种模式完成交接，正确冻结字幕翻译当前配置，并在自动模式下只启动本次成功导入的任务。

具体下一步以 Execution Plan 为准：先认领 `PRE-001` 建立基准语料、指标、工具链和 clean-room/许可证证据；`PRE-001`～`PRE-006` 全部通过并完成技术冻结后，才进入正式 CORE/NATIVE/runtime/UI 实现。
