<div align="center">
  <img src="./public/banner.png" alt="FusionKit Banner" width="100%" />
</div>

<div align="center">
  <h1>FusionKit</h1>
  <p>AI 驱动的跨平台桌面工具集合</p>
  <p>
    <a href="https://github.com/QiuYeDx/FusionKit/releases/latest">
      <img src="https://img.shields.io/github/v/release/QiuYeDx/FusionKit?style=flat-square&color=blue" alt="Latest Release" />
    </a>
    <a href="https://github.com/QiuYeDx/FusionKit/blob/main/LICENSE">
      <img src="https://img.shields.io/github/license/QiuYeDx/FusionKit?style=flat-square" alt="License" />
    </a>
    <a href="https://github.com/QiuYeDx/FusionKit/releases">
      <img src="https://img.shields.io/github/downloads/QiuYeDx/FusionKit/total?style=flat-square&color=green" alt="Downloads" />
    </a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square" alt="Platform" />
  </p>
</div>

---

## 简介

**FusionKit** 是一款基于 Electron 的跨平台桌面工具集合应用，旨在将多种实用工具整合在一个优雅的界面中。内置 **FusionKit Agent**，可通过自然语言对话驱动字幕翻译、格式转换、语言提取、历史任务恢复，以及文件名 / 文件夹名翻译等操作；也提供完整的手动工具界面，适合逐项配置、预览和执行。

PS: 在 FusionKit 本地字幕转写完成正式发布验收前，现有稳定流程仍可配合 `Faster-Whisper-GUI` 先生成字幕，再用本工具进行 AI 翻译。相关教程：[「音频转字幕&人声分离」猴子也能懂的 Faster-Whisper-GUI 使用教程](https://qiuvision.com/notes/1)

## 0.3.0 版本亮点

- **本地字幕转写完整工作流**：支持批量添加音频/视频、媒体探测、音轨选择、managed Whisper/VAD、CPU/CUDA 后端以及 SRT/LRC 导出。
- **字幕翻译自动交接**：转写完成后可仅导出、加入字幕翻译队列或立即启动新增任务，并通过一次性 artifact 与冻结配置完成安全交接。
- **Windows 文件拖拽与输出修复**：恢复资源管理器拖拽文件的原始身份，修复授权过期、错误自动编号、字幕未落盘及安全覆盖不可用等问题。
- **任务队列与进度优化**：本地转写按 FIFO 稳定展示，只在转写阶段显示统一进度；字幕翻译任务按进行中、未开始、已完成排序。
- **运行时与统计更新**：Electron 固定为 41.10.6；字幕翻译新增实际 Token/费用累计与 DeepSeek Thinking 配置。

## 0.2.11 版本亮点

- **本地字幕转写预发布实现**：新增独立的本地字幕工具，可批量处理音频/视频，使用 managed Whisper 模型生成 SRT/LRC，并按用户选择只导出、加入字幕翻译队列或确认后开始翻译。最终安装包、目标 GPU、稳定性和许可发布验收仍在进行中。
- **音频工具箱首版**：新增音频转文本、文本转音频、实时字幕和 Realtime/WebRTC 双向语音工具页。
- **全局音频模型配置**：设置页集中管理音频 Profile、协议、模型和任务分配；工具页只读取全局生效配置，不再各自保存 API 配置。
- **OpenAI / MiMo 音频 API 兼容**：文件 ASR/TTS 使用 OpenAI 官方音频 API 风格作为内部契约，MiMo ASR/TTS 通过 adapter 接入。
- **MiMo TTS 三模式**：支持 `mimo-v2.5-tts` 预置音色、`mimo-v2.5-tts-voicedesign` 音色设计和 `mimo-v2.5-tts-voiceclone` 音色复刻，并接入低延迟流式播放链路。
- **实时音频体验**：实时字幕支持 OpenAI Realtime/WebRTC；MiMo 或非 Realtime 配置下以分块近实时字幕呈现。双向语音首版面向 OpenAI Realtime/WebRTC。
- **音频隐私边界**：本地音频文件、录音片段和麦克风内容会发送到用户选择的第三方音频 API；API Key、Base64 音频和 PCM chunk 不写入任务恢复、Zustand 持久化或错误详情。

## 0.2.10 版本亮点

- **长文本翻译 Beta**：新增面向小说、长文档和多 TXT 项目的翻译工具，Renderer 只传递文件路径，正文由主进程读取、分片和落盘。
- **连贯串行翻译模式**：支持跨分片、跨文件的语义记忆，适合人物关系、术语和文风需要连续保持的长文本。
- **可靠恢复与重翻**：长文本任务会写入独立工作区、事件日志和分片结果，支持暂停、取消、恢复、部分完成和从指定分片后重翻。
- **TXT 输出模式**：支持仅译文、双语简洁模式和 `[Original]` / `[Translation]` 标签模式，并支持多个独立文件队列或有序项目。
- **Markdown 结构保护能力**：已完成 Markdown parser、保护占位符、仅译文组装和 blockquote 双语组装；端到端 Markdown 执行仍处于后续开放范围。

## 0.2.9 版本亮点

- **文件名翻译性能全面优化**：引入翻译去重、快路径跳过、内存缓存、受控并发与自适应批次拆分，大幅缩短大批量文件名翻译的等待时间；新增规划进度可视化与取消入口。
- **文件名翻译双语输出模式**：支持在翻译后的文件名中同时保留原语言和目标语言（如 `Episode 1 - 第01話.srt`），可自定义分隔符和语言顺序。
- **全新启动加载页**：重新设计应用启动画面，新增 Reveal 过渡动画效果。
- **繁体中文支持**：新增繁体中文（zh-Hant）界面语言。
- **安全性增强**：修复 symlink 检测、路径权限错误处理、不完整计划误执行等多项安全与健壮性问题。

## 功能特性

### FusionKit Agent（AI 助手）

内置 AI 对话助手，通过自然语言即可完成字幕处理、历史恢复和名称翻译等任务。

- 基于 **Vercel AI SDK** 的流式对话与工具调用循环
- 自动扫描目录、发现字幕文件并分发到翻译 / 转换 / 提取队列
- 支持扫描 `*.fusionkit.resume.json` 恢复清单，并将可恢复字幕任务加入翻译队列
- 支持检查文件 / 文件夹路径，生成名称翻译 dry-run 预览，并在明确确认后应用重命名
- 三种执行模式：**仅入队** / **确认后执行** / **自动执行**
- 支持拖拽文件或文件夹到输入框，自动识别路径并追加到当前消息
- 输入框草稿缓存，跨页面导航后仍可保留未发送内容
- 会话导出与导入（JSON 格式）
- 实时 Token 用量统计、上下文占用与费用追踪

### 字幕翻译

利用 AI 大模型实现高质量字幕翻译，支持多种模型和灵活配置。

- 支持 **LRC / SRT** 格式字幕文件
- 支持 **9 种语言**：中文、日文、英文、韩文、法文、德文、西班牙文、俄文、葡萄牙文
- 支持 **DeepSeek / OpenAI** 及任意 OpenAI 兼容 API
- 双语对照或仅译文两种输出模式
- 分片并发翻译（最高 5 路并发）
- 可配置分片策略（普通 / 敏感 / 自定义）
- 实时进度显示、分片完成数（n/N）与 Token 用量预估
- 支持编辑任务配置、输出路径选择与重名处理（覆盖 / 自动编号）
- 支持失败恢复与历史任务续跑，自动生成并读取 `*.fusionkit.resume.json` 恢复清单
- 支持源文件不可用时基于恢复清单内的原始分片继续翻译

### 长文本翻译（Beta）

面向整章小说、长文档和多 TXT 文件项目的 AI 翻译工具，重点优化大文本分片、恢复、输出与费用可见性。

- 支持选择单个或多个 **TXT** 文件；多个文件可作为独立任务队列，也可作为有序项目串行翻译
- Renderer 不读取整本正文，创建任务时只向主进程传递文件路径和配置
- 主进程执行编码探测、资源限制检查、分片规划、模型请求、分片结果落盘和最终输出组装
- 支持快速并发与连贯串行两种执行模式；串行模式会携带语义记忆以保持术语、人物关系和文风
- 支持文档背景、翻译要求、风格要求、术语表和指定文件前重置语义记忆
- 支持仅译文、TXT 双语简洁模式和 TXT 双语标签模式
- 支持输出到源文件目录或自定义目录，并提供覆盖 / 自动编号冲突策略
- 支持暂停、取消、恢复、部分完成、打开工作区和打开输出文件
- 页面会显示分片数、输入 token 估算、费用估算和上下文预算校验
- Markdown parser 与输出组装能力已完成，但端到端 Markdown 翻译入口仍处于 Beta 后续开放范围

隐私与费用提示：

- 文件正文会发送到用户配置的 OpenAI Compatible 模型服务；请确认模型服务的隐私和数据保留政策
- API Key 只用于运行时请求，不写入长文本翻译工作区
- 串行语义记忆会增加每个分片的输入 token，费用通常高于并发模式

### 本地字幕转写（预发布）

面向本地音频/视频批量生成字幕的独立工具，不复用“音频转文本”的远端 API 配置或运行时。

- 使用随应用提供并校验的 `whisper.cpp` runtime、FFmpeg 和 ffprobe；用户无需安装系统 FFmpeg，也不能配置任意 executable 或 backend 参数
- managed 清单提供默认推荐的 `large-v3-q5_0` 与质量优先的 `large-v3` F16 GGML 模型，可选 Silero v6.2.0 VAD；模型和 VAD 按需下载，不进入默认安装包
- 支持 1～100 个文件、媒体探测、多音轨选择、原文转写或翻译为英语、SRT/LRC、多格式部分成功、取消与逐文件失败隔离
- 支持源目录或自定义目录、自动编号和受控覆盖；已提交字幕不会因取消、失败、更新或卸载而主动删除
- 默认只导出；自动翻译必须由用户显式选择并确认当前翻译配置和外部 API 费用，只启动本次交接新增的任务
- 本地转写默认离线，普通推理不上传媒体或字幕；只有资源下载会访问固定 allowlist，自动翻译才会调用用户配置的第三方文本模型 API
- Windows x64 CPU/CUDA 与 macOS arm64 Metal/CPU 目前仍是发布候选矩阵；最终 installer、签名/公证、目标 GPU、稳定性和许可验收完成前，不承诺 stable 支持或最低性能

资源体积、磁盘需求、隐私、恢复、卸载保留、平台证据和第三方许可边界见[本地字幕转写预发布说明](docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_release_notes.md)。

### 音频工具箱

面向音频内容处理和实时语音交互的工具集合，统一使用设置页中的全局音频模型配置。

- 支持在设置页创建 OpenAI Audio、OpenAI Realtime 和 MiMo Chat Audio Profile，并分别分配给音频转文本、文本转音频、实时字幕和双向语音任务
- 音频转文本支持本地音频文件 ASR；OpenAI 模式兼容官方 transcriptions 字段，MiMo 模式支持 `mimo-v2.5-asr` 并按能力禁用字幕格式、prompt 和时间戳等非支持选项
- 文本转音频支持 OpenAI Audio TTS，也支持 MiMo `mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone` 三种模式
- MiMo TTS 支持非流式保存和低延迟流式播放；流式链路使用 PCM16 chunk 播放，完成后保存为本地音频文件
- 实时字幕支持 OpenAI Realtime/WebRTC 麦克风字幕；MiMo 或非 Realtime 配置下以短录音片段转写的“分块近实时”方式呈现
- 双向语音首版支持 OpenAI Realtime/WebRTC 的连接、断开、静音、打断回复、远端音频播放和字幕 timeline
- 工具页只展示当前全局音频 Profile、协议、模型和能力，不提供独立 provider、API Key、base URL 或模型 ID 配置入口

隐私与能力提示：

- 本地音频文件、录音片段和麦克风内容会发送到用户在设置页选择的 OpenAI、MiMo 或其他兼容音频 API 服务；请确认所选服务的隐私和数据保留政策
- OpenAI Realtime 长期 API Key 仅在 Electron 主进程用于创建临时凭证，Renderer 只接收 ephemeral credentials
- API Key、Authorization / `api-key` header、Base64 音频、PCM chunk 和完整请求体不会写入任务恢复文件、Zustand 持久化或错误详情
- MiMo 的音色设计、音色复刻、音频标签和 `optimize_text_preview` 为 MiMo 专属能力；非 MiMo 音频配置下相关控件会禁用
- MiMo Chat Audio 首版不提供原生 WebRTC 双向语音；双向语音页会要求使用具备 Realtime/WebRTC 能力的 OpenAI Realtime Profile
- 真实供应商的音频格式、模型和低延迟流式能力可能变化，发布前仍建议用实际 API Key 做一次端到端验收

### 字幕格式转换

在主流字幕格式之间自由转换。

- 支持 **SRT / VTT / LRC** 三种格式互转（6 条转换路径）
- 自定义输出路径与重名处理策略（覆盖 / 自动编号）
- 可选去除媒体类型后缀（如 `song.wav.srt` → `song.srt`）

### 字幕语言提取

从多语言 / 双语字幕中提取指定语言的内容。

- 支持从 **LRC / SRT** 字幕中提取指定语言文本
- 支持 **9 种语言**：中文、日文、英文、韩文、法文、德文、西班牙文、俄文、葡萄牙文
- 基于假名、标点、虚词等多维度启发式语言识别
- 自定义输出路径与重名处理策略

### 文件名 / 文件夹名翻译

面向批量整理文件和目录的安全重命名工具，先预览再执行。

- 支持选择文件、文件夹或混合路径
- 支持翻译所选名称、直接子项或递归子项
- 支持仅处理文件、仅处理文件夹或同时处理两者
- 支持自动识别源语言，并翻译到中文、英文、日文等 9 种语言
- 支持命名风格选择：保留原风格、空格分词、短横线、下划线、Title Case、lowercase
- 支持双语输出模式，翻译后文件名同时保留原语言和目标语言，可自定义分隔符和顺序
- 默认保留文件扩展名，并可保留编号、季集、清晰度等技术标签
- dry-run 预览可编辑、跳过、恢复 AI 建议，并支持冲突检测与重新校验
- 规划过程可视化进度条、阶段提示和取消入口
- 翻译去重、快路径跳过、内存缓存与受控并发，大幅提升大批量翻译速度
- 应用前执行高风险确认，真实重命名会写入 journal，支持尽力回滚

### 更多工具（开发中）

- 付费音乐解密转换

## 其他特性

- 🌓 深色 / 浅色 / 跟随系统主题
- 🌐 多语言界面（简体中文 / 繁體中文 / English / 日本語）
- 🔄 应用内检查更新与自动更新
- 🌍 网络代理配置（无代理 / 系统代理 / 自定义代理）
- 🔔 系统通知提醒（任务完成 / 失败）
- 💤 防休眠管理（翻译等长时任务运行期间自动阻止系统休眠）
- 🧭 工具页分步 Tour 引导
- 🖥 跨平台支持（macOS / Windows）

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 框架 | Electron 41.10.6 + React 19.1.1 |
| 语言 | TypeScript |
| 构建工具 | Vite 5 |
| 样式 | Tailwind CSS 4 |
| UI 组件 | shadcn/ui (Radix UI) |
| 状态管理 | Zustand |
| AI 集成 | Vercel AI SDK + OpenAI Compatible Provider |
| 国际化 | i18next |
| 动画 | Motion |
| 测试 | Vitest + Playwright |
| 包管理器 | pnpm |

## 快速开始

### 环境要求

- **Node.js** >= 18.0.0
- **pnpm**（推荐使用 [corepack](https://nodejs.org/api/corepack.html) 启用）

### 安装与开发

```bash
# 克隆仓库
git clone https://github.com/QiuYeDx/FusionKit.git
cd FusionKit

# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

### 构建发布

```bash
pnpm build
```

构建产物将输出到 `release` 目录。

## 项目结构

```
FusionKit/
├── electron/                  # Electron 主进程
│   ├── main/                  # 主进程核心逻辑
│   │   ├── index.ts           # 窗口管理与 IPC 注册
│   │   ├── translation/       # AI 翻译引擎
│   │   ├── text-translation/  # 长文本翻译执行、分片、记忆、恢复与输出
│   │   ├── audio/             # 音频 ASR/TTS、流式音频与 Realtime IPC
│   │   ├── conversion/        # 字幕格式转换
│   │   ├── extraction/        # 字幕语言提取
│   │   ├── rename/            # 文件 / 文件夹重命名扫描、校验、应用与 journal
│   │   ├── fs/                # 文件系统操作（扫描、读取、元数据）
│   │   ├── proxy.ts           # 代理配置
│   │   ├── power.ts           # 防休眠管理
│   │   └── update.ts          # 自动更新
│   └── preload/               # 预加载脚本（Context Bridge）
├── src/                       # 渲染进程（前端）
│   ├── agent/                 # AI 助手核心（orchestrator、工具定义、会话管理）
│   ├── pages/                 # 页面组件
│   │   ├── HomeAgent/         # AI 助手主页
│   │   ├── Tools/             # 工具页（字幕 / 重命名 / 长文本 / 音频工具箱）
│   │   ├── Setting/           # 设置页（通用 / 代理 / 模型）
│   │   └── About/             # 关于页
│   ├── components/            # UI 组件库
│   │   ├── ui/                # shadcn/ui 基础组件
│   │   └── qiuye-ui/          # 自定义组件
│   ├── services/              # 业务服务（字幕队列、名称翻译计划、冲突处理等）
│   ├── store/                 # Zustand 状态管理
│   ├── locales/               # i18n 多语言资源
│   ├── constants/             # 常量定义
│   ├── type/                  # TypeScript 类型
│   └── utils/                 # 工具函数
├── docs/                      # 开发文档
├── build/                     # 应用图标资源
├── public/                    # 静态资源
└── test/                      # E2E 测试
```

## 配置说明

### AI 模型配置

在设置页面可分别配置**字幕翻译**、**长文本翻译**、**文件名翻译**和 **AI 助手**所用的文本模型参数：

- **API Endpoint** — OpenAI 兼容的 Chat Completions 端点
- **API Key** — 访问密钥
- **Model** — 模型名称
- **Token 价格** — 输入/输出单价（每百万 token），用于费用预估

可创建多个模型配置，并在“模型分配”中分别指定 **Agent 模型** 与 **任务执行模型**。内置 DeepSeek 和 OpenAI 预设，也支持任意 OpenAI 兼容 API；配置 API Key 后可从接口拉取可用模型列表，或手动填写自定义 Model Key。

### 音频模型配置

音频工具箱使用独立的全局音频 Profile，但复用现有模型连接 Profile 中的 API Key、Base URL 和代理设置。

- 音频协议支持 `openai_audio`、`openai_realtime` 和 `mimo_chat_audio`
- 可分别配置 ASR、TTS、Realtime 模型 ID、默认 voice、默认语言、默认输出格式和默认流式行为
- 可为音频转文本、文本转音频、实时字幕和双向语音分别选择全局生效的音频 Profile
- 工具页会按当前 Profile 的 capability 自动启用或禁用 OpenAI-only、MiMo-only 和 Realtime-only 控件
- 使用音频工具时，本地音频文件或麦克风内容会发送到当前分配的第三方音频 API 服务

### 翻译分片策略

翻译时会将字幕按 Token 上限拆分为多个分片，每个分片独立调用一次 LLM。

| 模式 | 分片上限 | 适用场景 |
| --- | --- | --- |
| 普通模式 | ~3000 tokens | 大多数字幕文件 |
| 敏感模式 | ~100 tokens | 特殊内容，需更精细控制 |
| 自定义模式 | 用户指定 | 按需调整 |

### 字幕恢复清单

字幕翻译过程中会保存恢复清单与分片进度，任务失败、中断或应用退出后，可通过“恢复历史任务”重新加入队列。

- 扫描当前输出目录：适合恢复当前工具页配置的输出位置
- 选择目录扫描：适合批量查找某个目录下的历史恢复清单
- 导入恢复清单：适合直接选择单个 `*.fusionkit.resume.json`
- 源文件一致时优先基于源文件续跑；源文件缺失或变化时，可基于恢复清单内的分片继续处理

### 名称翻译安全机制

文件名 / 文件夹名翻译遵循“先生成计划，再确认执行”的流程：

1. 选择路径并配置范围、目标类型、语言和命名风格
2. 生成 dry-run 预览，检查新旧路径、冲突、警告和跳过项
3. 必要时手动编辑预览项或重新校验
4. 通过高风险确认后应用重命名
5. 需要时可基于 journal 尝试回滚已执行的重命名

## 贡献指南

欢迎任何形式的贡献！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/your-feature`)
3. 提交更改 (`git commit -m 'feat: add your feature'`)
4. 推送到分支 (`git push origin feature/your-feature`)
5. 发起 Pull Request

## 许可证

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布，仅允许非商业使用，禁止用于任何商业目的。

## 相关链接

- **项目主页**：[github.com/QiuYeDx/FusionKit](https://github.com/QiuYeDx/FusionKit)
- **问题反馈**：[Issues](https://github.com/QiuYeDx/FusionKit/issues)
- **版本发布**：[Releases](https://github.com/QiuYeDx/FusionKit/releases)
- **更新日志**：[CHANGELOG.md](CHANGELOG.md)
- **作者主页**：[qiuvision.com](https://qiuvision.com)
