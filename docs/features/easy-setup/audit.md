# 现状盘点：从下载到第一次用起来（2026-10-17，v0.5.1 分支 76d60bd）

本文按真实用户的路径，逐项列出 FusionKit 安装与使用需要的环境、资源和配置，以及每一步会卡住新手的地方。结论来自阅读代码与打包产物，没有在全新系统上实测；需要实测确认的条目已标注。

## 1. 依赖清单

### 1.1 用户无需自己安装的（已经做好）

| 依赖 | 现状 | 位置 |
| --- | --- | --- |
| Node.js / Python | 不需要。外部 Agent 的 stdio 桥用 FusionKit 自身可执行文件加 `ELECTRON_RUN_AS_NODE=1` 运行 | `resources/external-agent/fusionkit-mcp-stdio.cjs:4-6`，`src/agent/external/client-configs.ts:40-49` |
| whisper.cpp 推理程序 | 随安装包。Windows x64 为官方 v1.9.1 CPU 版；macOS arm64 为源码构建的 Metal 版（部署目标 macOS 11） | `build/subtitle-studio-resources/transcription/manifests/subtitle-studio-runtime.v1.json` |
| FFmpeg / FFprobe | 随安装包（Windows 为 BtbN n8.1.2） | 同上，`win-x64/media/` |
| CUDA Toolkit | 不需要。CUDA 加速包自带 cudart / cublas 等 DLL | `resources/speech-resources/manifests/speech-windows-cuda-pack.v1.json` |
| 安装权限 | Windows 为当前用户安装，不需要管理员；可改安装目录 | `electron-builder.subtitle-studio.json` `nsis` |

模型下载已有断点续传（HTTP Range）、磁盘空间预检、大小 + SHA-256 + GGML 头校验和一次加载测试（`electron/main/speech-resources/engine/resource-download.ts`，`model-manager.ts:907-967`）。这些基础是好的。

### 1.2 用户必须准备或会遇到的

| 依赖 | 是否必需 | 现状 | 问题 |
| --- | --- | --- | --- |
| 操作系统 | 必需 | 只有 Windows x64 与 macOS Apple Silicon，打包合同拒绝其他平台（`scripts/packaging/subtitle-studio-contract.mjs:42-60`） | README 与官网没写最低系统版本。Electron 41 需要 Windows 10+、macOS 12+（来自 Electron 官方支持策略，未在仓库中记录） |
| **Microsoft VC++ 2015-2022 x64 运行库** | Windows 本地转写必需 | `whisper-server.exe`、`whisper.dll`、`ggml-base.dll` 导入 `MSVCP140.dll`、`VCRUNTIME140.dll`、`VCRUNTIME140_1.dll`，`ggml-base.dll` 另需 `VCOMP140.DLL`（已从二进制导入表核实）。安装包不带，也不检测 | 全新系统或精简系统上，下载完 1 GB 模型后加载测试失败，只显示“资源操作失败，请重试”，并删除已下载的模型 |
| 绕过系统安全拦截 | 必需（每台电脑一次） | 安装包未签名，macOS 未公证 | macOS 可能提示“已损坏”，要在终端运行 `xattr`；Windows 出现 SmartScreen。说明只写在 CHANGELOG 的“当前范围”里，README、官网、安装包内都没有 |
| AI 模型服务 + API Key | Agent、AI 翻译、修订、文件名翻译必需 | 用户自备 | 新手不知道 Key 去哪拿、哪家便宜、哪家国内能直连 |
| Whisper 模型（约 1.0 GB / 2.9 GB） | 本地转写必需 | 运行时从 `huggingface.co` 下载，域名白名单只有 `huggingface.co`、`*.hf.co`（`model-manifest.ts:150-151`） | 中国大陆常常无法直连 |
| VAD 文件（885 KB） | 本地转写默认开启，因此默认必需 | 从 `raw.githubusercontent.com` 下载（`speech-vad.v1.json:15`），与模型分开下载 | 同上；用户要点两次下载 |
| CUDA 加速包（下载 678 MB，解压约 1.2 GB） | 可选 | 从 GitHub Releases 下载（`accelerator-manifest.ts:166`） | 下载前不检查有没有 NVIDIA 显卡和驱动版本；没有 N 卡的电脑也能白下 |
| NVIDIA 显卡驱动 | 使用 CUDA 时必需 | 代码没有声明或检查最低版本 | 驱动太旧时只会报“未验证” |
| 网络代理 | 中国大陆用户访问海外服务时常常需要 | 有 无 / 系统 / 自定义 三档 | 见第 3 节：“系统代理”实际不读系统设置，资源下载完全不走代理 |

## 2. 新手路径逐步走查

| 步骤 | 新手看到的 | 卡点 | 严重度 |
| --- | --- | --- | --- |
| 下载 | 官网或 GitHub Releases | 大陆访问 GitHub 下载慢或失败；安装包约 297 MB，安装后约 1.1 GB：本地转写资源放了两份（`resources/local-subtitle` 与 `resources/subtitle-studio` 各约 225 MB，内容相同），`app.asar` 286 MB | 中 |
| 安装 / 首次打开 | macOS：“无法验证开发者”或“已损坏”；Windows：SmartScreen 蓝框 | “已损坏”只能靠终端命令解决，新手基本会放弃。没有任何应用内或官网指引 | **高** |
| 打开应用 | 首页是 Agent 对话，黄色提示“尚未配置 Agent 所用的模型”，发送按钮不可用 | 没有欢迎页或设置向导；“前往设置”跳到“常规”而不是“AI 模型”标签（`HomeAgent/index.tsx:404`、`AgentDock/index.tsx:468`、`TextTranslator/index.tsx:952` 都是 `navigate("/setting")`，`settingNavigation.ts:13-17` 回落到 general） | **高** |
| 添加模型 | 对话框里有 API Key、Base URL、API 格式（Responses / Chat Completions）、输出 Token 参数、模型、价格 | 术语多；Key 输入框明文（`ModelConfig.tsx:655`）；预设只有 DeepSeek、OpenAI；没有“测试连接”；没有“去哪里获取 Key”的链接 | **高** |
| 分配模型 | 另一张卡片“模型分配”里分别选 Agent 模型和任务执行模型 | 新建配置不会自动分配（`useModelStore.ts:189-201`），新手以为填完就能用；OpenAI 预设默认 Responses 格式，而 Agent 不支持 Responses（`ModelConfig.tsx:121-124`），选了会报错 | **高** |
| 第一次对话 | 发送 | Key 错、余额不足、模型名错时，只在运行时报通用错误；只有文件名翻译有“鉴权失败”专门提示 | 中 |
| 本地转写准备 | 工作台转写里“管理资源”，模型、VAD、CUDA 各一行，各自下载 | 没有“一键准备”；推荐模型没有标出；名称是 `large-v3-q5_0`、`Silero VAD v6.2.0`、`CUDA 12.4 accelerator`（`model-manager.ts:558`、`vad-manager.ts:863`、`accelerator-manager.ts:1141`） | 中 |
| 下载模型 | 进度条 | 大陆直连 HuggingFace 失败；代理设置对下载无效；失败只重试 2 次（`resource-download.ts:56`），提示只有“资源操作失败，请重试。”（`studio.json:497`） | **高** |
| 导入模型 | “导入模型”按钮 | 文案说“兼容的 GGML 模型”，实际只接受与清单大小和 SHA-256 完全一致的两个文件（`model-manager.ts:1362-1366`）；VAD 和 CUDA 包不能手动导入 | 中 |
| 开始转写 | 选模型、设备、VAD | 设备“自动”在 CUDA 不可用时静默回落 CPU；高级参数（温度、搜索宽度、上下文提示）直接展示 | 低 |
| 更新 | 启动后检查到新版本，弹窗显示更新日志和“打开发布页” | 应用内不能下载安装（`update.ts` 有 `start-download` 等通道，但渲染进程从未调用）；新手要自己再去 GitHub 下载、重新安装；更新检查和更新日志也依赖 github.com 与 raw.githubusercontent.com | 中 |

## 3. 网络与代理（中国大陆用户的主要障碍）

| 请求 | 走应用代理吗 | 位置 |
| --- | --- | --- |
| AI 模型调用（主进程） | 走 | `electron/main/ai/adapters/chat-completions-adapter.ts:64-66`，`responses-adapter.ts:66-68` |
| 联网查证 | 走 | `electron/main/web-lookup/service.ts:37` |
| Whisper 模型 / VAD / CUDA 下载 | **不走**，直接用 `node:https` | `electron/main/speech-resources/engine/resource-download.ts:15` |
| 下载安装包（`download-installer`） | 不走 | `electron/main/update.ts:235` |
| 模型列表刷新（OpenAI） | 走 Chromium 网络栈，不走应用代理设置 | `ModelConfig.tsx:507-536` |

“系统代理”模式只是让 axios 读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量（`electron/main/proxy.ts:48-49`），全仓库没有 `session.resolveProxy` 或 `setProxy`。Windows 上用 Clash 等工具开“系统代理”时，这些环境变量通常不存在，所以界面上的“使用操作系统配置的代理设置”实际不生效。代理测试只访问 `https://httpbin.org/ip`（`proxy.ts:63`），不测试用户真正要用的模型地址。

另外，渲染进程默认代理模式是“系统”（`src/store/useProxyStore.ts:23-27`），主进程启动时是“无”（`proxy.ts:21-25`），二者在渲染进程恢复设置后才同步。

## 4. 术语与文案

| 位置 | 新手看不懂的词 |
| --- | --- |
| 设置 → AI 模型 | API Key、Base URL、Model Key、Responses API / Chat Completions、max_tokens / max_completion_tokens、endpoint、$/1M Token、“Agent 模型”与“任务执行模型”的区别 |
| 字幕工作台 | 上下文窗口（tokens）、每批输出上限、温度、搜索宽度、上下文提示、GGML、VAD |
| 本地转写资源 | 服务合同、Whisper 运行器、后端探测、未验证、正在检查运行兼容性；恢复建议“源码运行请重新组装项目内的本地运行时”是写给开发者的 |
| 旧版本地转写页 | 错误直接显示英文原文和 `code: model_download_failed`、`stage:` 等字段（`LocalSubtitleErrorNotice.tsx:23-37`） |
| 旧首页 `/home-classic` | “本地处理数据，无需上传云端”，对 AI 翻译不准确 |

## 5. 结论

**目前没有达到“新手不用琢磨环境就能用”的目标。** 运行时依赖方面基础不错：Node、Python、FFmpeg、CUDA Toolkit 都不需要用户装，下载有续传和校验。但新手在以下五处很可能卡住或放弃：

1. **打不开**：未签名、未公证，macOS“已损坏”要用终端，且没有任何指引。
2. **配不好模型**：没有引导，术语多，跳转到错的标签页，建了配置还要另外分配，OpenAI 预设与 Agent 不兼容，没有测试连接。
3. **下不动资源**：模型、VAD、CUDA、更新都依赖 HuggingFace / GitHub，没有国内下载源，代理对下载无效，“系统代理”名不副实。
4. **Windows 缺 VC++ 运行库**：在全新系统上本地转写必然失败，而且表现为“模型损坏”，还会删掉 1 GB 的下载。
5. **出错看不懂**：错误不分原因，没有下一步建议，部分文案面向开发者。
