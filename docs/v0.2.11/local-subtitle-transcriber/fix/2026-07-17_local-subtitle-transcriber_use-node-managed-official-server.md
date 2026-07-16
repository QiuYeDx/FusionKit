# PRE-002 修正：优先使用 Node 管理官方 whisper-server

## 背景

原 Final Design 把“批次内模型驻留、结构化结果和取消”直接等同为“必须编写
FusionKit C++ runner + JSONL 协议”，因此 PRE-002 被设计成需要 CMake/MSVC 的
原生开发包。这个推导跳过了对官方 Windows 预编译资产能力的检查。

`whisper.cpp v1.9.1` 官方 `whisper-bin-x64.zip` 实际已经包含
`whisper-server.exe`、`whisper-cli.exe`、`whisper.dll` 和 CPU backend DLL。
其中官方 server：

- 启动时加载模型并在多个请求间复用同一个 context；
- 提供 `/health`、`/inference`、`/load` 和 `verbose_json`；
- 对推理请求串行加锁，适合首版单任务执行模型；
- 在 HTTP 客户端断开时通过 `abort_callback` 中止推理；
- 返回 segment/word 时间戳，不要求解析 stdout/stderr 人类日志。

因此“官方 CLI 每文件重载”的缺点成立，但不能据此推出必须自写 C++ runner。

## 修正后的技术决策

PRE-002 及首版 production 候选改为 Node 管理官方预编译
`whisper-server`：

1. Electron main 直接 `spawn()` 固定版本、manifest 校验过的官方 server，
   `shell:false`，并持有完整生命周期。
2. server 只绑定 `127.0.0.1` 的临时端口，所有 endpoint 加 192-bit 随机私有
   request path，静态目录指向本次会话的空私有目录。
3. child 使用 allowlisted 最小 environment 和受控 cwd，不继承 API Key、代理
   凭据或 Agent/Electron secret。
4. readiness 只认 `/health` JSON；结果只认 `/inference` 的
   `verbose_json`。stdout/stderr 仅作有界脱敏诊断，不作为协议。
5. 同一 model/backend 的批次复用一个 server 进程；切换 model/backend 时重启
   受控进程，不依赖失败恢复语义较弱的 `/load`。
6. 取消使用 Node `AbortController` 断开推理请求，触发官方 server 的
   `abort_callback`；超时才终止并重启整个 child。
7. 正式媒体流程仍由 FusionKit 自己的 FFmpeg normalizer 先生成受控 WAV，生产
   server 不依赖其 `--convert` shell 调用。PRE-002 为尽快跑现有 MP4 只在 PoC
   中临时启用系统 FFmpeg。
8. SRT/LRC 继续由 TypeScript canonical transcript 和 formatter 生成，不采用
   上游直接字幕输出。

首版不解析官方 `--print-progress` 或 realtime stdout，因此进度先表达为
`loading_model / normalizing_media / transcribing / postprocessing` 阶段。只有后续
真实 UX 证明必须提供推理百分比或增量 segment，且官方 server API 仍无法满足时，
PRE-006 才重新评估小型 native bridge；不能预先把它当成必需品。

## CMake/MSVC 的新边界

- 当前 Windows x64 CPU PRE-002 不需要 CMake、MSVC 或本地编译 whisper.cpp。
- 如果官方 CUDA 预编译包通过 PRE-003，Windows 首版同样可以不在本机编译。
- macOS arm64 若没有满足发布要求的官方产物，或未来确实需要补充官方 API 缺失
  的能力，构建机/CI 仍可能需要 CMake 和平台编译器；这是 artifact 构建问题，
  不是用户运行前置，也不是当前 Windows 开发 blocker。
- Node 不能把 C/C++ DLL 当作普通 JavaScript module 直接 import；FFI/N-API 仍是
  native bridge，并带来 ABI、线程回调、Electron ABI 和打包维护成本。当前没有
  证据表明它优于受控官方 server 进程。

## PRE-002 实测结论

- `ggml-base.bin` multilingual 模型从公开官方模型来源下载到 Git 忽略目录。
- 同一官方 server PID 完成 3 个现有中/日样本，模型只加载一次。
- 长日文音频在 5 秒取消探针中于 5006 ms 返回 `aborted`；进程保持健康并继续
  完整转写。
- 三个样本 CPU RTF 为 0.0318～0.0512，均返回可解析的结构化 segment。
- 进程退出后没有残留 whisper/FFmpeg child、临时会话目录或 `.partial`。

这些结果证明 Node-managed official server 足以通过 PRE-002。base 模型仅用于
集成验证，快速抽查可见中/日识别存在小模型预期误差；PRE-003 使用目标
`large-v3`/候选量化模型做 Windows CPU/CUDA 和人工可用性验收。

## 影响范围

- 删除“PRE-002 必须自写 C++/JSONL runner”和“Windows 当前必须安装
  CMake/MSVC”的架构前提。
- 保留模型驻留、结构化结果、取消、受控 child、日志脱敏、无 orphan 和独立
  SRT/LRC formatter 等产品约束。
- NATIVE/BE 工作包改为官方 server artifact、Node supervisor 与 HTTP JSON
  contract 的生产化，不再预设 FusionKit C++ 工程。
