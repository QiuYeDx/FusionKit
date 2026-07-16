# PRE-001 修正：拆分官方预编译 PoC 与源码构建就绪

> 后续收口：本文关于拆分 CMake/MSVC readiness 的结论仍有效；但文中所述
> 样本许可、独立参考和 FasterWhisperGUI/CTranslate2 严格门禁已于同日废弃，
> PRE-001 现已完成。最终结论见
> `2026-07-16_local-subtitle-transcriber_reduce-pre001-to-product-readiness.md`。

## 背景

原 PRE-001 Windows profile 把 CMake、MSVC、`nvcc`、FFmpeg 和 GPU 驱动放在同一个 `requiredTools` 集合中。因此当前主机虽然可以直接使用 `whisper.cpp` 官方 Windows x64 预编译资产，CPU/CUDA 报告仍会因为缺少 CMake/MSVC 被标记为 not ready。

这混淆了两个不同问题：

- PRE-001/PRE-003 的 stock CLI PoC 是否能使用固定的官方预编译资产；
- PRE-002/NATIVE 的 FusionKit persistent runner 是否能从源码构建。

编译器属于后者，不是最终用户前置，也不应阻塞前者。

## 修正后的合同

- Windows CPU/CUDA profile 的 `readinessScope` 固定为 `official_prebuilt_release_asset`。
- PRE-001 顶层 `ready` 只由目标平台/架构、Node/pnpm/lockfile、FFmpeg/ffprobe 以及 CUDA profile 的 NVIDIA driver probe 决定。
- CMake、MSVC 与 `nvcc` 继续被探测，但只进入 `sourceBuild`：当前 `sourceBuild.requiredForPoc=false`、`sourceBuild.ready=false`，不再生成 PRE-001 blocker。
- Windows CPU 固定 `whisper.cpp v1.9.1 / whisper-bin-x64.zip`；CUDA 固定 `whisper-cublas-12.4.0-bin-x64.zip`。文件名、字节数、SHA-256 与官方下载 URL 进入 report validator，篡改必须失败。
- macOS arm64 仍为 `source_build_poc`，其本机 PoC 需要 CMake、Clang、Xcode/Metal，因此 source-build 检查仍是顶层 required checks。
- stock `whisper-cli` 只用于 PoC；PRE-002 仍必须实现并验证 FusionKit 自有 persistent JSONL runner。

## 本机证据

- Windows CPU/CUDA 两份脱敏报告已按新合同重生成并为 `ready: true`。
- 两份报告都保留 `sourceBuild.ready: false`，明确记录 CMake/MSVC 缺失；CUDA profile 同时记录本机 `nvcc 12.4` 可用。
- 官方 CPU ZIP 的本机下载字节数和 SHA-256 与 GitHub release digest 一致，解压后的 `whisper-cli.exe --help` 退出码为 0。
- 677,887,125-byte CUDA ZIP 本次没有下载；当前只固定上游 release metadata，不能据此声称 CUDA inference 或 DLL 分发已经验证。

## 不变边界

- 后续产品范围收口确认三份目标报告加现有 3 样本 inventory 已足够完成 PRE-001；语料许可、独立参考和 FasterWhisperGUI/CTranslate2 baseline 不再是门禁。
- PRE-002 若选择本机源码构建，仍需 CMake/MSVC；也可由后续冻结的受控 CI/build machine 提供构建证据。
- PRE-003 必须在 RTX 4070 Ti SUPER 上运行真实 CPU/CUDA 推理、RTF、RAM/VRAM、取消和加载复用测试。
- PRE-005/PRE-006 仍负责 bundled FFmpeg、CUDA runtime/accelerator pack、签名、许可和 clean-machine 分发结论。

## 验收

```text
node --test scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cpu --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_windows-x64-cpu.json
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cuda --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_windows-x64-cuda.json
node scripts/local-subtitle/benchmark/validate-manifests.mjs
```

验收必须同时看到：Windows 两个顶层 profile ready、`sourceBuild.ready=false`、官方资产 pin 校验通过，以及改变资产 SHA-256 的回归测试失败。
