# 工作包 PRE-006：Production 技术冻结

## 基本信息

- 日期：2026-07-18
- 状态：已完成
- 对应执行计划工作包：`PRE-006`
- 目标平台/硬件：Windows x64 CPU/CUDA、macOS arm64 Metal/CPU；macOS x64 固定 unsupported

## 本次认领边界

- 包含：复核 PRE-003～PRE-005 证据；冻结 engine/runtime contract、平台/fallback、FFmpeg acquisition/staging、model/VAD manifest 与质量/体积五项 production 决策；增加机器校验和文档台账。
- 不包含：正式 Electron main/renderer 类型、IPC、resource resolver、production `extraResources` 接线、模型下载器、重新下载/编译 native 资产、Windows 证书或信任库变更。

## 本次实现内容

- 新增 `poc/pre006-production-decision.json`，五项 decision 均为 `go`，`openPreBlockers` 为空并解锁 `CORE-001` / `CORE-002`。
- 固定 `whisper.cpp v1.9.1 / f049fff`、Node-managed official server HTTP contract v1、阶段式进度与取消后重启；首版不建 native bridge。
- 固定 Windows x64 CPU base + CUDA 12.4 on-demand、macOS arm64 Metal default + 显式 CPU、macOS x64 `unsupported_architecture`。CUDA 不要求 Toolkit，Windows driver 保守要求 `>= 551.61`（真实验证 610.62）。Windows 采用 `unsigned_personal_distribution`，不要求 Authenticode、证书或信任库修改。
- 固定 macOS FFmpeg 8.1.2 minimal LGPL source build；Windows 接受 immutable BtbN LGPLv3 build 为 initial personal-distribution baseline，不增加 Windows source-build 工具链。acquire/audit/hash 必须在 staging 前完成，electron-builder 不联网且 packaged 模式不回退 PATH。
- 首发 model manifest 只包含 exact `large-v3-q5_0`；VAD 固定 Silero v6.2.0 GGML。未量化 large-v3 与 turbo 变体保持 deferred，不能提前显示为内置下载项。
- 冻结 30 秒 PCM window / 5 秒 overlap、VAD mapped-segment timeline、raw gate、最多 3 层重试和 RTF < 1 门禁；记录 base package、CUDA pack、model 与 macOS native runtime 的 observed/guard bytes。
- 扩展 manifest validator，使 decision record、third-party candidate status 与 Final Design 选择发生漂移时失败；新增 negative tests 覆盖模型 digest、Windows signing profile 和 FFmpeg candidate mismatch。
- 将 Windows FFmpeg source record 与 third-party notices 从 PRE-005 candidate 更新为 PRE-006 production baseline；QA-005 保留 exact external-library notices/source offers/NVIDIA DLL 复核。

## 修改文件

- `docs/v0.2.11/local-subtitle-transcriber/poc/pre006-production-decision.json`
- `docs/v0.2.11/local-subtitle-transcriber/poc/third-party-candidates.json`
- `docs/v0.2.11/local-subtitle-transcriber/poc/README.md`
- `scripts/local-subtitle/benchmark/validate-manifests.mjs`
- `scripts/local-subtitle/benchmark/validate-manifests.test.mjs`
- `resources/local-subtitle/licenses/FFmpeg-n8.1.2-windows-x64-btbn-source.json`
- `resources/local-subtitle/licenses/THIRD_PARTY_NOTICES.local-subtitle.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- 本实施记录

## 接口、状态或数据结构变化

- 新增 PRE-006 decision record schema v1，包含 `engineRuntime`、`platformSupport`、`mediaRuntime`、`modelAndVadManifest`、`qualityPerformanceAndFootprint` 五个强制 `go` section。
- `validate-manifests.mjs` 现在默认加载该记录，并与 `third-party-candidates.json` 的五个 `production_selected_*` 状态交叉校验。
- 资源/业务生产接口尚未改变；后续 `CORE-001` / `CORE-002` 必须消费本记录，不能重复发明另一份 runtime/model 决策。

## 安全、隐私与许可证检查

- 路径/capability：未新增用户路径、capability 或 executable picker；decision record 只含公开 URL、版本、大小和 hash。
- 日志/持久化：未记录媒体/字幕正文、真实路径、PID、hostname、username、API Key 或签名身份；未新增运行中日志。
- 第三方来源与许可：固定官方 whisper.cpp v1.9.1、exact Hugging Face model revision、FFmpeg 8.1.2 source/fingerprint、immutable BtbN release 与 CUDA 12.4 EULA。本文与清单均明确不是法律意见；QA-005 在分享 artifact 前核对 exact notices/source offers/NVIDIA DLL。
- Windows 签名：personal/friend profile 使用 unsigned final bytes + size/SHA/manifest；不创建证书、不修改信任库。只有未来 public low-warning profile 才由可选 QA-003 验证 trusted installer signature/timestamp。

## 验证结果

执行命令：

```text
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node --test scripts/local-subtitle/runtime/*.test.mjs
git diff --check
```

结果：

- 通过：manifest validation 0 error / 0 warning；validator 17/17；完整 PRE benchmark 26/26；runtime 38/38；`git diff --check` 通过。
- 未运行及原因：未重复下载约 678 MB CUDA archive、约 1.08 GB model 或重新构建 native artifact；PRE-006 是对已提交真实证据的 decision freeze，这些昂贵操作不会提高本包的决策可信度。
- 真实硬件/packaged 范围：复用 PRE-003 Windows RTX 4070 Ti SUPER CPU/CUDA、PRE-004 Apple M5 Metal/CPU、PRE-005 双平台 builder/no-PATH/fault matrix 证据；本包没有把 mock 或新开发机 PATH 当成新硬件结论。

## 产生的证据

- benchmark/fixture/截图/日志摘要路径：`docs/v0.2.11/local-subtitle-transcriber/poc/pre006-production-decision.json`；`scripts/local-subtitle/benchmark/validate-manifests.test.mjs`。
- 不应提交的本地产物位置与清理结果：未生成 native binary、model、media、packaged app、download cache、temp WAV 或本地路径 inventory；无新增进程需要清理。

## 未完成事项与风险

- `QA-005` 必须在把 artifact 分享给他人前核对 Windows FFmpeg 51 个 external-library flags 的 exact notices/source offers，以及 CUDA pack 的精确 NVIDIA redistributable DLL 清单。
- Windows unsigned 包可能显示 Unknown Publisher / SmartScreen，受管设备策略或第三方安全软件仍可能拦截；这不影响本机 runtime 功能，也不构成引入代码签名的默认理由。
- macOS Developer ID、公证和 Gatekeeper acceptance 仍由 `QA-004` 对真实分发产物验收。
- `large-v3` / turbo 变体只有补齐 exact artifact 与跨平台证据后才能从 deferred 状态进入内置 manifest。

## 下一步建议

- 优先认领 `CORE-001`，把已冻结的 runtime contract/model manifest version、状态机、事件、error 与 schema 上限变成共享类型和纯函数测试；或独立认领 `CORE-002` 实现 resource manifest/resolver/staging 合同。
