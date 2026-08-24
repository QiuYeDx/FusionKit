# 工作包 PRE-002：Node 管理官方 whisper-server PoC

## 基本信息

- 日期：2026-07-17
- 状态：已完成
- 对应执行计划工作包：`local-subtitle-transcriber_execution_plan.md` / `PRE-002`
- 目标环境：Windows 11 x64 / CPU

## 本次认领边界

- 包含：验证官方预编译 `whisper-server.exe` 能否代替自写 C++ runner；实现可测试
  的 Node supervisor PoC；用同一模型进程完成 3 个现有中/日样本；验证取消、健康
  恢复、结构化结果、最小环境和退出清理；同步 Final Design、Execution Plan 和
  项目避坑记录。
- 不包含：production Electron IPC/UI、SRT/LRC formatter、bundled FFmpeg、CUDA
  推理、RAM/VRAM 采集、签名/安装包、最终模型质量或跨平台发布结论。

## 本次实现内容

- 新增 `scripts/local-subtitle/whisper-server/supervisor.mjs`：
  - 直接 spawn 官方 server，不经过 shell；
  - 绑定 loopback 临时端口和随机私有 request path；
  - 使用空静态目录、会话临时目录、最小 allowlisted environment；
  - 通过 `/health` 判断 ready，通过 `/inference` 获取 `verbose_json`；
  - 用 file-backed Blob 发送媒体，避免 Node 先把完整文件读入 Buffer；
  - 将秒级 segment/word 时间归一化为整数毫秒；
  - AbortController 取消推理，stop 时 kill fallback 并清理临时目录；
  - stdout/stderr 只保留有界脱敏诊断，不解析为运行合同。
- 新增 `run-poc.mjs`，从 ignored inventory 选择现有 3 个真实样本，在同一 server
  会话中运行取消探针和完整转写，并把正文结果写入 ignored local 输出目录。
- 新增 5 个 Node 合同测试，覆盖最小环境、loopback/private path、安全 spawn
  参数、verbose JSON parser 和真实样本选择。
- 更新设计决策：首版优先 Node-managed official server；没有证据时不建立
  FusionKit C++/JSONL runner。

## 真实运行结果

候选运行时：`whisper.cpp v1.9.1 / whisper-bin-x64.zip`；模型：multilingual
`ggml-base.bin`，147,951,465 bytes，只用于集成 PoC。

| 样本 | 语言 | 媒体时长 | 转写耗时 | CPU RTF | segment |
| --- | --- | ---: | ---: | ---: | ---: |
| `ja-character-pv-bgm-medium` | ja | 230.229 s | 11.798 s | 0.0512 | 33 |
| `ja-audio-drama-frequent-silence-medium` | ja | 753.390 s | 23.974 s | 0.0318 | 221 |
| `zh-character-pv-bgm-medium` | zh | 235.221 s | 8.866 s | 0.0377 | 81 |

- 三次完整请求使用同一 server PID，`modelLoadCount=1`，模型复用成立。
- 长日文样本取消探针：5,000 ms 发出 abort，5,006 ms 观察到稳定 `aborted`，
  即本次取消请求结算延迟约 6 ms；
  `/health` 仍为 ok，随后同一进程完整处理该样本和后续中文样本。
- 快速人工抽查确认输出确为对应中文/日文并包含合理时间段；base 模型有明显专名
  和听写误差，因此不把本结果当作 `large-v3` 的最终质量结论。

## 安全、隐私与清理

- 媒体、参考字幕、模型、生成正文、绝对路径和本机 summary 都在 `*.local` 忽略
  范围；版本化文件只记录 sample ID 和汇总数字。
- child environment 未继承 API Key、authorization header、代理凭据或用户 PATH。
- 运行结束确认 server PID 不存在、`fusionkit-whisper-server-*` 临时目录为 0、
  `.partial` 为 0；没有遗留 Node/FFmpeg/whisper 服务。
- PoC 使用系统 FFmpeg 只为让官方 server 快速读取现有 MP4；这不是 packaged
  runtime 或最终用户依赖证据。

## 验证结果

```text
node --test scripts/local-subtitle/whisper-server/supervisor.test.mjs
node scripts/local-subtitle/whisper-server/run-poc.mjs <ignored local arguments>
node --test scripts/local-subtitle/benchmark/*.test.mjs scripts/local-subtitle/whisper-server/supervisor.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory <ignored inventory>
git diff --check
```

首批 supervisor 合同测试 5/5 通过，真实 PoC 3/3 完成且取消/复用/清理通过。
完整 benchmark 与文档校验在本工作包收尾时再次执行。

## 下一步建议

- 进入 PRE-003，使用同一 Node-managed server contract 和现有 3 样本，验证官方
  Windows CPU/CUDA 资产与目标 `large-v3`/量化候选的 RTF、RAM/VRAM、人工可用
  输出和 CUDA 分发边界。
- PRE-003 不需要先写 C++。只有官方 server 在目标能力上出现经过复现的硬缺口，
  才把 native bridge 作为 PRE-006 的显式备选决策。
