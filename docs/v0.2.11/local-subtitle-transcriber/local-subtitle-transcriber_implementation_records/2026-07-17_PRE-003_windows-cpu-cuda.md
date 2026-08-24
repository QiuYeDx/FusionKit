# 工作包 PRE-003：Windows x64 CPU/CUDA PoC

## 基本信息

- 日期：2026-07-17
- 状态：已完成
- 对应执行计划工作包：`local-subtitle-transcriber_execution_plan.md` / `PRE-003`
- 目标环境：Windows 11 x64 / i5-13600KF / RTX 4070 Ti SUPER 16 GB

## 本次认领边界

- 包含：使用官方 `whisper.cpp v1.9.1` Windows CPU/CUDA 预编译包和公开
  `large-v3-q5_0` 模型，跑通现有 3 个中/日样本；采集 RTF、RAM/VRAM、语言
  检测、模型复用、取消和 SRT/LRC 回读；验证 CUDA backend 证据和一个缺 DLL
  失败面；形成 Windows 分发建议。
- 不包含：复刻 FasterWhisperGUI、独立校对真值、额外语料、人工制造 OOM、macOS
  Metal、发行版 FFmpeg、安装包签名/许可证最终审计、production Electron IPC/UI。
- 最终字幕质量不在 PRE 阶段假装完成：本次只做开发可读性抽查；产品可用后由用户
  用这 3 个样本实际验收，不阻塞后续设计与开发。

## 固定资产

| 资产 | 大小 | SHA-256 | 结论 |
| --- | ---: | --- | --- |
| `whisper-bin-x64.zip` | 7,982,101 B | `7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539` | 官方 CPU server 可用 |
| `whisper-cublas-12.4.0-bin-x64.zip` | 677,887,125 B | `106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b` | 官方 CUDA server 可用；解压 1,209,487,872 B |
| `ggml-large-v3-q5_0.bin` | 1,081,140,203 B | `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1` | CPU/CUDA 共用目标量化模型 |

模型固定到公开仓库 revision
`c521a4b02f422512d734391fdf08bb08c0862f68`。这些二进制和模型只保留在
`*.local` 忽略目录，没有提交到 Git。

## 本次实现

- `run-poc.mjs` 增加显式 `cpu|cuda` backend、样本筛选、模型/runtime hash、加载
  时间、语言匹配、RTF、进程资源、SRT/LRC smoke 和 parse-back 汇总。
- `process-metrics.mjs` 按 exact server PID 采集工作集；Windows WDDM 下优先使用
  `GPU Process Memory(pid_...)` dedicated usage，并保留 `nvidia-smi` fallback。
- `subtitle-smoke.mjs` 生成 PoC SRT/标准 LRC，再由独立 parser 回读；它只是 PoC
  门禁，正式字幕整形仍属于 `SUB-001`。
- `run-backend-probe.mjs` 只启动并观察目标 backend；CUDA 未观察到显存时稳定以
  `backend_unverified` 失败，不能凭文件名或 `/health` 宣称 GPU。
- supervisor 的 inference 从全局 `fetch` 改为 `node:http` 流式 multipart，使用
  独立 12 小时上限、64 MiB response 上限、AbortSignal 和 header value 清洗。
- 正常任务继续复用同一模型进程；任何已取消的推理在下一任务前重启 server。
  `/health = ok` 只证明 HTTP 进程存活，不证明底层取消工作已经收敛。

## 真实运行结果

### CUDA

完整 3 样本运行使用同一 server PID、一次模型加载；首次加载约 1,019 ms，峰值
工作集 1,124,974,592 B，exact-PID 峰值显存 2,117,439,488 B。

| 样本 | 语言 | 媒体时长 | 耗时 | RTF | cue |
| --- | --- | ---: | ---: | ---: | ---: |
| `ja-character-pv-bgm-medium` | ja | 230.229 s | 12.871 s | 0.0559 | 73 |
| `ja-audio-drama-frequent-silence-medium` | ja | 753.390 s | 55.374 s | 0.0735 | 213 |
| `zh-character-pv-bgm-medium` | zh | 235.221 s | 11.966 s | 0.0509 | 105 |

最终流式 HTTP 代码又单独跑了一次中文 CUDA smoke：RTF 0.0488、显存
2,115,342,336 B，确认 transport 修正没有破坏 GPU 路径。250 ms 取消探针在约
5 ms 后得到稳定 `aborted`。

### CPU fallback

三个样本都使用 official server 的显式 `--no-gpu`；长日文与中文正常任务复用
同一 PID、一次模型加载，峰值工作集 2,502,635,520 B，GPU 占用为 0。

| 样本 | 语言 | 媒体时长 | 耗时 | RTF | cue |
| --- | --- | ---: | ---: | ---: | ---: |
| `ja-character-pv-bgm-medium` | ja | 230.229 s | 116.573 s | 0.5063 | 80 |
| `ja-audio-drama-frequent-silence-medium` | ja | 753.390 s | 446.026 s | 0.5920 | 196 |
| `zh-character-pv-bgm-medium` | zh | 235.221 s | 119.861 s | 0.5096 | 107 |

长日文请求在 446 秒后正常返回，跨过此前约 300 秒的全局 `fetch` 隐式 response
header timeout。5,000 ms 取消探针在约 3 ms 后结算为 `aborted`；下一任务合同固定
重启 server。

所有 CPU/CUDA 请求的语言检测都匹配 ja/zh，生成的 SRT 和标准 LRC 都能由独立
parser 回读。内容只做了不落库的快速抽查，确认是可读且语言对应的中/日文；没有
把现有 FasterWhisperGUI 字幕当作必须一致的科研基线。

## 故障与分发结论

- 在 CUDA runtime hard-link staging 中只移除 `cublas64_12.dll`。官方 server
  仍能启动且 `/health = ok`，但 exact-PID 显存为 0；backend probe 以 exit 2 和
  `backendVerified=false` 拒绝该运行。这证明产品必须有真实 backend 门禁。
- 量化模型在 16 GB 目标卡上的峰值显存约 2.12 GB，刻意制造 OOM 对本轮开发没有
  价值，留到 QA 的资源故障测试，不作为 PRE-003 收口条件。
- CPU ZIP 解压约 20.4 MB，CUDA ZIP 解压约 1.21 GB。默认安装包只带 CPU official
  runtime；CUDA 建议做签名、逐文件 hash 校验、按需安装的 accelerator pack。
- CUDA child 的 PATH 只含 runtime directory、开发 FFmpeg directory 和 System32，
  真实推理仍成功，因此 CUDA Toolkit、`nvcc`、CMake 和 MSVC 都不是运行前置。
  NVIDIA driver 仍是前置；DLL 再分发、notice、签名、更新与回滚交 PRE-005/PRE-006。

## 隐私与清理

- 脱敏汇总在 `poc/pre003-windows-x64-results.json`；不含 hostname、用户名、绝对
  路径、媒体/字幕正文、模型字节或 native binary。
- 媒体、用户字幕、模型、ZIP、解压 runtime、完整结果和生成字幕都留在 ignored
  local 目录。
- 缺 DLL hard-link staging 已删除；PoC 结束后没有本轮 whisper-server、FFmpeg、
  `.partial` 或 `fusionkit-whisper-server-*` 临时目录残留。

## 验证

```text
node --test scripts/local-subtitle/benchmark/*.test.mjs scripts/local-subtitle/whisper-server/*.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory <ignored inventory>
node scripts/local-subtitle/whisper-server/run-poc.mjs <ignored CPU/CUDA arguments>
node scripts/local-subtitle/whisper-server/run-backend-probe.mjs <ignored missing-DLL arguments>
git diff --check
```

本工作包实现的 whisper-server Node tests 为 8/8 通过；benchmark + supervisor
合计 27/27 tests 通过，结构与严格清单校验均为 0 error / 0 warning。

## 下一步

- 有 macOS arm64 环境时执行 `PRE-004` Metal/CPU PoC。
- 当前 Windows 环境可直接执行 `PRE-005` bundled FFmpeg、sidecar staging、签名与
  许可证 PoC。
- `PRE-006` 汇总技术选型后再进入正式 runtime/UI。当前没有理由编写 C++ runner；
  Node 直接管理官方 `whisper-server` 已满足本需求的首版架构。
