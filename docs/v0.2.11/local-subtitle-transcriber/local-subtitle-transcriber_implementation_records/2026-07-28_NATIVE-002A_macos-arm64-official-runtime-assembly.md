# 工作包 NATIVE-002A：macOS arm64 official runtime assembly

## 基本信息

- 日期：2026-07-28
- 状态：已完成（component checkpoint；顶层 `NATIVE-002`、`FS-TXN-001` 与 `BE-002` 仍为进行中）
- 对应执行计划工作包：`NATIVE-002` 的 macOS arm64 canonical official runtime assembly 与 target launch/no-PATH 子合同
- 目标平台/硬件：macOS arm64，Apple M5，16 GB RAM
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 本次认领边界

本 checkpoint 将 macOS arm64 的 official server、FFmpeg/ffprobe 与 overwrite addon 组装到唯一 canonical ignored runtime root，并以真实 production 模型完成 CPU private health、媒体 decode、no-PATH 和 builder static consumption 门禁。

包含：

- 从 isolated、clean、exact `whisper.cpp v1.9.1 / f049fff95a089aa9969deb009cdd4892b3e74916` Git checkout 可重复构建 thin arm64 official `whisper-server`，生成 path-free build receipt。
- 固定 Release、macOS arm64、deployment target 11.0、static libraries、`GGML_NATIVE=OFF`、Metal enabled/embedded 与 CPU fallback；通过 file/debug prefix map 和 final-byte scan 拒绝 source/temp/private host path。
- 将 build receipt 绑定到 runtime staging 输入，先复制到 canonical layout，再对 server、FFmpeg 与 ffprobe 做 nested ad-hoc signing，最后冻结 size/SHA-256 和 runtime manifest。
- 将 001G 的 production protocol-v4 overwrite addon staging 到同一 canonical root，并由正式 `beforePack` 以 `launch:false` 同时静态验证 official runtime 与 addon。
- 使用 PRE-006 唯一 production `large-v3-q5_0` 模型，在受控 cwd、sanitized environment、随机私有 request path 和 loopback endpoint 上完成 CPU `/health`；用 bundled FFmpeg/ffprobe 完成 PCM16 mono 16 kHz decode/probe，并证明不依赖系统 PATH。

不包含：

- Windows x64 CPU/CUDA official runtime 或媒体 artifact assembly、launch/no-PATH；
- 真实 Windows protocol v4 compile/load/terminal/recovery/crash/acknowledgement 矩阵；
- macOS arm64 或 Windows x64 packaged app/installer consumption；
- Developer ID、notarization、Gatekeeper accepted 或 Windows Authenticode；
- CUDA accelerator pack 的下载/交付、VAD、`MODEL-002`、完整 product E2E 或 production overwrite 放行。

## 本次实现内容

### Exact source build 与 receipt

- 新增 `build-whisper-server-macos-arm64.mjs`，构建前要求 source root 自身就是 upstream Git 顶层、HEAD 和 exact tag 均匹配 PRE-006 pin，且 tracked、untracked、ignored 与 submodule 状态均 clean，避免 extracted source 继承 FusionKit ancestor Git metadata或本地产物污染 exact checkout。
- 构建固定 CMake 4.4.0、Apple clang 21.0.0、macOS SDK 26.5、Unix Makefiles 与八项 production definition，并把 source/work root 映射为稳定前缀；不使用 host-native tuning，不产生 shared third-party dylib。
- unsigned raw server 为 3,641,216 bytes，SHA-256 `aba72ffc41692deb43cc0ff7b32267134d6614877f10e5089a584c1c62b1be5d`。receipt 证明 thin arm64、minimum macOS 11.0.0、8/8 system-only dynamic dependencies、embedded Metal library 与 CPU fallback，且不记录 absolute path、username 或 source path。
- `stage-runtime.mjs` 现在必须同时验证 server build receipt 与 FFmpeg build receipt，不能再把任意外部 Mach-O 仅凭架构和文件名提升为 production server。

### Canonical final-byte assembly

- canonical root 为 ignored `build/local-subtitle-resources/local-subtitle`。final server 经 ad-hoc nested signing 后为 3,638,160 bytes，SHA-256 `b5227f8b3e36aff1c1f32249027901ec6b2beae39dad9dc8a95714fe6e23b65e`。
- bundled FFmpeg 8.1.2 SHA-256 为 `55f36865bfedfef597c1c6462ec92fcab1392bf418815e66b416195493bacc53`；ffprobe 为 `8dfe0a7aba414a65a284eca637b04713c0ad0cabaf290f9b5f2679664fb60d09`。
- runtime manifest SHA-256 为 `19271b1fdd4b8ec9a78731893a096f329154acbaea1504be9aaf01f175d22530`，同时绑定 6 份 exact license/source evidence。
- production overwrite addon final SHA-256 为 `f54671efeab266008a9324112f753416368e6a72fa9eda6b5fdca50ce773ecc2`，verified generation 为 `cce55b2e09ea353fad28e4c2808faa12a7d8186505da5e4d4f174a2cce0530d5`；content-addressed leaf、module exports 与 no-PATH verifier 均通过。
- 正式 `beforePack` 继续只执行 point-in-time static gate，不在 electron-builder 中联网或启动 server/media；缺失 optional signature verifier 时不向 strict overwrite verifier 注入 `undefined` 字段。

### Target launch/no-PATH

- 新增 `run-native002-macos-smoke.mjs`，先重新验证 canonical runtime manifest 与三类 executable identity，再对真实 artifact 执行独立 target smoke。
- CPU 路径使用 production `large-v3-q5_0` 模型、显式 `--no-gpu`、`127.0.0.1` 临时端口、192-bit 随机私有 path、空 public/tmp 目录和 sanitized environment，private `/health` 返回 exact `{\"status\":\"ok\"}`。报告不保存 model raw path、端口或私有 route。
- bundled FFmpeg 将本地生成的短 PCM fixture 解码为 mono 16 kHz PCM16，bundled ffprobe 精确回读 codec/sample rate/channels；子进程使用受控 cwd 和 sanitized PATH，系统 FFmpeg/ffprobe 不提供 fallback authority。
- 同一个 production `large-v3-q5_0` 模型的 Metal health 首次实跑在restricted sandbox中只能完成7.33 MiB allocation并触发SIGSEGV，未达到 ready；本 checkpoint 当时据此诚实记录为未通过，未以 embedded Metal capability、PRE-004 历史 PoC 或 CPU health 代替。后续 `NATIVE-002A1` 使用同一canonical manifest和production模型在unrestricted环境约8秒通过private health/no-PATH与backend verification，证明首次失败是执行环境限制；原assembly/CPU证据和首次失败记录均保留。

## 修改文件

- `scripts/local-subtitle/runtime/build-whisper-server-macos-arm64.mjs` 及测试
- `scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs` 及测试
- `scripts/local-subtitle/runtime/stage-runtime.mjs`、`staging-contract.mjs` 及相关测试
- `scripts/local-subtitle/runtime/electron-builder-local-subtitle-before-pack.cjs` 及测试
- `scripts/local-subtitle/runtime/validate-runtime-staging.mjs` 及测试
- `resources/local-subtitle/licenses/whisper.cpp-v1.9.1-source.json`
- `resources/local-subtitle/manifests/local-subtitle-staging.v1.json`
- 本实施记录、Final Design、Execution Plan、v0.2.11 README 与总迭代台账

## 接口、状态或数据结构变化

- macOS server staging 新增强制 `serverBuildReceiptPath`，receipt 冻结 exact source checkout、CMake definitions、deployment target、reproducible path mapping、Metal/CPU capability与 unsigned final input identity。
- runtime source evidence 新增 production build recipe、receipt/private-path-scan requirement；对应 byte size/SHA pin 同步更新。
- 新增只供 release/target validation 使用的 macOS smoke report schema；不进入 renderer、IPC、Store 或 session persistence。
- runtime manifest schema、production IPC 和用户状态 schema 均未改变；PRE-006 engine/platform/model/media pins 未改变。

## 安全、隐私与许可证检查

- 路径/capability：构建、staging 与 smoke 均只在 main/release script 内消费 absolute path；report 与 committed JSON 不记录真实 source、model、runtime 或 temp path，renderer 无新增 executable/path authority。
- 日志/持久化：不记录模型内容、字幕正文、私有 request path、端口、PID、username、API Key、environment 或 signing identity。
- 子进程：build 与 runtime 均 `shell:false`；build timeout/output overflow 对独立进程组执行 TERM→KILL 并要求 close confirmation，target smoke 使用 allowlisted environment、controlled cwd、loopback/private route 与 finally cleanup。
- 第三方来源与许可：继续使用 PRE-006 冻结的 whisper.cpp MIT、FFmpeg 8.1.2 LGPL source/signature、license/source-offer 证据；没有更换 engine、artifact source 或 distribution profile。
- 签名：本 checkpoint 仅使用 nested ad-hoc final-byte integrity。Developer ID、公证和 Gatekeeper accepted 仍归 `QA-004`，不能由 ad-hoc result 替代。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/runtime/build-whisper-server-macos-arm64.test.mjs scripts/local-subtitle/runtime/run-native002-macos-smoke.test.mjs scripts/local-subtitle/runtime/stage-runtime.test.mjs scripts/local-subtitle/runtime/electron-builder-pre005-before-pack.test.mjs scripts/local-subtitle/runtime/validate-runtime-staging.test.mjs
node scripts/local-subtitle/runtime/build-whisper-server-macos-arm64.mjs <ignored exact-source/build arguments>
node scripts/local-subtitle/runtime/stage-runtime.mjs <ignored canonical staging arguments>
node scripts/local-subtitle/overwrite-native/overwrite-staging.mjs <ignored canonical staging arguments>
node scripts/local-subtitle/runtime/validate-runtime-staging.mjs --platform darwin --arch arm64
node scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs <ignored production-model arguments> --backend cpu
node scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs <ignored production-model arguments> --backend metal
```

结果：

- focused Node tests：24/24 passed；新增 exact receipt schema、ignored source污染与构建 timeout close-confirmation 回归覆盖。
- overwrite-native Node tests：29 passed / 1 Windows-only skipped；local-subtitle Vitest：951 passed / 2 real-server skipped；全量 Vitest：1921 passed / 2 real-server skipped。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、四语言各1522 keys与source usage、`git diff --check`通过。
- exact source build、receipt validation、canonical runtime + addon staging、official runtime/addon static verifier 和 `beforePack` 双门禁通过。
- CPU production-model private health 与 bundled media PCM16 decode/probe/no-PATH 通过；所有 temporary work roots 与 child processes 已清理。
- Metal production-model private health 在本 checkpoint 的restricted sandbox运行中未通过：7.33 MiB allocation后在private health前触发SIGSEGV，未返回 ready。后续 `NATIVE-002A1` 在unrestricted环境对同一manifest与production模型`d75795ec...ad1`执行hardened复验，约8秒通过Metal private health/media decode/no-PATH；独立backend probe记录model load 531～547 ms、peak RSS 1,516,158,976～1,535,049,728 bytes、initialization/device=true、failure=false且`backendVerified=true`，CPU hardened smoke也通过。该后续target证据仍不是packaged验收。
- Windows、两平台 packaged app、Developer ID/notarization/Gatekeeper 未运行；这些不是本 component checkpoint 的完成条件，仍是顶层 `NATIVE-002` / QA 的剩余门禁。

## 产生的证据

- committed contract/test：上述 runtime scripts、source evidence、staging manifest 与测试。
- ignored raw build：`docs/v0.2.11/local-subtitle-transcriber/poc/native002a-macos-arm64.local/whisper-build/`，包含 raw server 与 path-free receipt。
- ignored canonical runtime：`build/local-subtitle-resources/local-subtitle/`，包含 final signed server/media、runtime manifest、license/source evidence 与 versioned overwrite subtree。
- ignored overwrite build：`docs/v0.2.11/local-subtitle-transcriber/poc/native002a-macos-arm64.local/overwrite-build/`。
- ignored machine-readable smoke：`docs/v0.2.11/local-subtitle-transcriber/poc/native002a-macos-arm64.local/smoke.json`，只含脱敏结论，不含绝对路径、端口或private route。
- 上述 binary、model、local smoke output 和 machine path 均未提交；Git 只提交合同、测试和脱敏文档。
- 本轮未启动 Vite、Electron 或其他前端服务；server、FFmpeg/ffprobe、CMake 和测试均为有界进程，收口复核无 FusionKit runner/media/frontend 残留。

## 状态与未完成事项

- `NATIVE-002A` component checkpoint 已完成，不增加顶层工作包数量。
- 39 个顶层工作包仍为 16 个已完成、23 个剩余：`NATIVE-002`、`FS-TXN-001`、`BE-002` 三个进行中，`FE-001` 等 20 个未开始。
- Job Manager / Production Executor 双重 `index-only` gate 不变，production overwrite 仍不可用；M2 仍未完成。
- `NATIVE-002` 仍需 Windows x64 CPU/CUDA + media canonical assembly/launch/no-PATH，以及 macOS arm64 / Windows x64 packaged consumption。
- `FS-TXN-001` 仍需真实 Windows protocol v4 compile/load/terminal/recovery/crash/acknowledgement 矩阵和两平台 packaged validation。
- Metal production-model health 的restricted sandbox失败作为历史执行环境证据保留；`NATIVE-002A1`已通过unrestricted目标机复验撤销该blocker，没有静默CPU fallback，也未改写PRE-004历史结论。

## 下一步建议

1. 认领 `NATIVE-002B`，在 Windows x64 目标机完成 official CPU/CUDA + media artifact assembly、final unsigned size/SHA、launch/no-PATH 与真实 protocol v4 矩阵。
2. 再以独立 packaged checkpoint 对 macOS arm64 与 Windows x64 执行真实 `extraResources` consumption、launch/no-PATH 和更新/签名边界验证。
3. 只有Windows/runtime/packaged全部闭环后，才评估完成 `NATIVE-002`、`FS-TXN-001`、`BE-002` 或解除双重 `index-only` gate。
