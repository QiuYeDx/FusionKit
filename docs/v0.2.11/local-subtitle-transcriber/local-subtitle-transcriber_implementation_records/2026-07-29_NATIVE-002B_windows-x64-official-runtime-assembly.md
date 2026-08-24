# 工作包 NATIVE-002B：Windows x64 official runtime assembly

## 基本信息

- 日期：2026-07-29
- 状态：已完成（component checkpoint；顶层 `NATIVE-002`、`FS-TXN-001` 与 `BE-002` 仍为进行中）
- 对应执行计划工作包：`NATIVE-002` 的 Windows x64 CPU base runtime、独立 CUDA accelerator candidate 与 target launch/no-PATH 子合同
- 目标平台/硬件：Windows x64，NVIDIA CUDA 目标机
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 本次认领边界

本 checkpoint 将 Windows x64 official CPU server、12 个 CPU dependency DLL、FFmpeg/ffprobe 与 protocol-v4 overwrite addon 组装到唯一 canonical ignored base runtime；同时把官方 CUDA 12.4 release 的 20 文件自包含候选组装到独立 accelerator root。CPU 与 CUDA 均使用 production `large-v3-q5_0` 模型完成 private health、bundled media PCM16 decode、no-PATH 和 backend attestation。

包含：

- 固定 `whisper.cpp v1.9.1 / f049fff95a089aa9969deb009cdd4892b3e74916` 官方 Windows x64 CPU release asset，验证 archive size/SHA-256、13 个 selected PE 的 size/SHA-256/x64 identity 与 MIT evidence。
- 复用 PRE-005 固定 Windows FFmpeg/ffprobe final bytes，并将 official runtime、媒体、6 份 license/source evidence 与 protocol-v4 addon 组装为 canonical base runtime。
- 固定官方 `whisper-cublas-12.4.0-bin-x64.zip`，只选择 server + 19 个 dependency DLL；排除其他 EXE、SDL2、parakeet 与同名 CPU DLL。
- CUDA pack 使用独立 ignored root、逐 artifact `licenseRef`、atomic directory rename/no-clobber publication；不加入默认 installer 或 `extraResources`。
- CPU 以显式 `--no-gpu` 完成 production-model private health；CUDA 以 exact-PID Windows GPU counter（`nvidia-smi` 仅作 fallback）取得正显存证据。
- 两条路径均使用 bundled FFmpeg/ffprobe、sanitized environment、controlled cwd、loopback 私有 route、bounded diagnostics、close-confirmed cleanup 与 path-free report。

不包含：

- macOS arm64 或 Windows x64 packaged app/installer consumption；
- CUDA pack 的下载、安装、更新、回滚或 UI，这些仍属于 `MODEL-002`；
- NVIDIA redistributable notice/EULA 的最终分发复核；`QA-005` 完成前不得分享 CUDA artifact；
- Windows Authenticode、公开发布签名、更新/卸载矩阵或 `QA-003`；
- production overwrite 放行、完整 product E2E 或 Job Manager/Executor gate 解除。

## 本次实现内容

### Canonical Windows CPU/media runtime

- `stage-runtime-windows-x64.mjs` 现在只接受官方 `whisper-bin-x64.zip`：7,982,101 bytes，SHA-256 `7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539`。正式 selection 为 `whisper-server.exe` + 12 个 CPU DLL，不要求 source build，也不从开发机随机发现 DLL。
- 新增 Windows release source evidence，明确 release tag/commit/source/release/download URL、archive pins、selection script 与 PRE-006 acquisition policy。
- Git 在 Windows checkout 可把 LF evidence 转成 CRLF；stager 只对可信 repository text evidence 规范化为 canonical LF 后再校验 exact size/SHA，二进制与下载内容保持 byte-for-byte。
- canonical base runtime manifest 为 `f8058656b66a5cd0193688a1c6f43121590c5076b4ac4a5d7eebb73908d8798a`，包含 15 个 executable/library artifact，selected artifact 总计 234,871,296 bytes。正式 static verifier 与 beforePack addon module probe 均通过。
- protocol-v4 overwrite addon 为 847,360 bytes / `40c666c02a44444ec9c8eed90f63792cd550ca5db09984fb2023fb85de08c5b2`，generation 为 `04f2f4b519cd04df5622dac3d2a8d19472c0fe127d2096ac2f7b4a46db79d8a7`。

### Independent CUDA 12.4 accelerator candidate

- 新增 strict CUDA contract、verifier 与 stager。官方 archive 为 677,887,125 bytes / `106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b`，expanded inventory 为 44 files / 1,209,487,872 bytes。
- 最终只选择 20 个 x64 PE，共 1,199,083,008 bytes；pack manifest SHA-256 为 `67215097ad69d30b05e123774d2cff23d188479bd06912d2f648d99a361dbabe`。server authority 通过 non-serializable verification proof 传递，不能由报告中的路径字符串重建。
- 静态 pack manifest 只证明 artifact integrity，`targetSmokeStatus` 有意保持 `pending`，不能自证同一进程外的硬件结果；独立 ignored smoke report 与本实施记录才承载 `target_smoke_passed`。输出父链在创建前、创建后与发布前均拒绝 symlink/junction，防止词法独立路径实际落入 canonical base root。
- 每个 artifact 固定 size、SHA-256、PE x64、backend 与 licenseRef。whisper.cpp 文件使用 MIT；6 个 NVIDIA CUDA runtime 文件使用 `LicenseRef-NVIDIA-CUDA-EULA`，其 artifact sharing 继续 fail closed 到 `QA-005`。
- accelerator root 为 `build/local-subtitle-accelerators/win32-x64/cuda-12.4/v1`，与 canonical base root 不重叠，也不进入默认 `extraResources`。`MODEL-002` 仍负责下载/install/update/rollback。
- Windows antivirus/indexer 可短暂占用刚完成 hash 的文件。共享 SHA helper 改为等待读取句柄 `close` 后才结算；publication 只对 `EBUSY`/`EPERM`/`EACCES` 做 30 秒有界重试，并在每次 retry 前重复 exact no-clobber 检查。失败清理独立尝试 partial root 与 lock release，保留 primary error，不让 secondary cleanup failure 覆盖根因。

### Production-model target smoke

- 新增 `run-native002-windows-smoke.mjs`。CPU/CUDA 参数互斥；CPU launch 必须含唯一 `--no-gpu`，CUDA server 只能来自已验证 accelerator proof。
- 两条路径均重新验证 canonical base manifest、server/media identity 与 production model identity。模型为 1,081,140,203 bytes / `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1`。
- CPU private `/health` 通过，最终复验首次 model load 1,239 ms；backend evidence 为 `official-server-no-gpu-flag`。
- CUDA private `/health` 通过，最终复验首次 model load 1,453 ms；exact-PID evidence 采样 1 次，peak RAM 319,234,048 bytes、peak VRAM 1,815,437,312 bytes，`backendVerified=true`。独立既有 backend probe 也记录正 exact-PID VRAM 1,815,437,312 bytes。
- Windows GPU counter 的 PowerShell 采样 cwd 固定到 PowerShell 自身目录，不能使用权限收紧的 private server work root；`nvidia-smi` fallback 同样使用工具目录。
- smoke work root 与 command capture 使用 Windows 有界 removal retry；operation 与 cleanup 同时失败时保留原始 model/runtime/health/command error，只附加稳定、无路径的 cleanup failure code。
- bundled media 生成并回读 mono 16 kHz PCM16；两条路径均证明 `noPathFallback=true`、`cudaToolkitPathUsed=false`、private loopback health、bounded diagnostics、server close 与 work/capture cleanup。

## 修改文件

- `scripts/local-subtitle/runtime/stage-runtime-windows-x64.mjs`、`staging-contract.mjs`、`runtime-manifest.mjs`、beforePack/validator 及相关测试
- `scripts/local-subtitle/runtime/windows-cuda-pack-contract.mjs`、`stage-runtime-windows-x64-cuda.mjs`、`run-native002-windows-smoke.mjs` 及相关测试
- `resources/local-subtitle/manifests/local-subtitle-staging.v1.json`
- `resources/local-subtitle/manifests/local-subtitle-windows-cuda-pack.v1.json`
- `resources/local-subtitle/licenses/whisper.cpp-v1.9.1-windows-x64-release.json`
- `.gitignore`、项目 pitfall guidance、本实施记录、Final Design、Execution Plan、v0.2.11 README 与总迭代台账

## 安全、隐私与许可证检查

- 所有 runtime/pack/model absolute path 只存在于 release/target-validation 进程内；committed manifest、实施记录与 smoke report schema 不记录 PID、端口、private route、raw diagnostics 或机器路径。
- 子进程均 `shell:false`，使用 allowlisted environment、受控 cwd、loopback endpoint、随机私有 route、bounded captures 和 close-confirmed cleanup；不继承 API key/proxy/CUDA Toolkit authority。
- static builder gate 明确 `officialRuntimeLaunchPerformed=false`，只声明 point-in-time static + addon module probe；target smoke 是独立真实运行证据。
- CUDA candidate 为 unsigned personal-distribution/on-demand 资源。`QA-005` 前 `artifactSharingAllowed=false`，本 checkpoint 不作法律结论，也不提交或分享 NVIDIA binary。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/runtime/stage-runtime-windows-x64.test.mjs scripts/local-subtitle/runtime/staging-contract.test.mjs scripts/local-subtitle/runtime/windows-cuda-pack-contract.test.mjs scripts/local-subtitle/runtime/stage-runtime-windows-x64-cuda.test.mjs scripts/local-subtitle/runtime/run-native002-windows-smoke.test.mjs scripts/local-subtitle/runtime/electron-builder-pre005-before-pack.test.mjs scripts/local-subtitle/runtime/validate-runtime-staging.test.mjs
node --test --test-name-pattern="does not finish a file hash until the readable handle closes" scripts/local-subtitle/runtime/runtime-manifest.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/runtime/validate-runtime-staging.mjs --platform win32 --arch x64
node scripts/local-subtitle/runtime/run-native002-windows-smoke.mjs <ignored canonical/model/report arguments> --backend cpu
node scripts/local-subtitle/runtime/run-native002-windows-smoke.mjs <ignored canonical/model/report arguments> --backend cuda
tsc --noEmit --pretty false
vite build --mode=test
git diff --check
```

结果：

- focused Node tests：56/56 passed；SHA stream close regression：1/1 passed。
- manifest validator：0 error / 0 warning；TypeScript 与 renderer/main/preload 三段 Vite test build 通过。
- strict canonical Windows runtime + addon validation 通过：15 个 base artifact、6 份 evidence、addon module exports 与 content-addressed generation 均 ready；该静态门禁明确未启动 official runtime。
- CPU 与 CUDA production-model target smoke 均为 `target_smoke_passed`；CPU/CUDA backend evidence、bundled media decode/no-PATH、privacy 与 cleanup 全部通过。
- `runtime-manifest.test.mjs` 全文件在当前 Windows 环境仍有 6 个既有 fabricated fixture 因 permission check 返回 `media_runtime_invalid`；本 checkpoint 未把该已知红灯伪记为通过。真实 canonical runtime、focused close regression 和 Windows target smoke 均通过。

## 产生的证据

- committed contract/test：上述 runtime scripts、manifest、Windows source evidence、测试、pitfall 与文档。
- ignored canonical base runtime：`build/local-subtitle-resources/local-subtitle/`。
- ignored CUDA candidate：`build/local-subtitle-accelerators/win32-x64/cuda-12.4/v1/`。
- ignored machine-readable smokes：`docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local/native002b-windows/cpu-smoke.json` 与 `cuda-smoke.json`。
- ignored release archives、expanded roots、production model、native addon build/receipt 与二进制均未提交。

## 状态与未完成事项

- `NATIVE-002B` component checkpoint 已完成，不增加顶层工作包数量。
- 39 个顶层工作包仍为 16 个已完成、23 个剩余：`NATIVE-002`、`FS-TXN-001`、`BE-002` 三个进行中，`FE-001` 等 20 个未开始。
- Job Manager / Production Executor 双重 `index-only` gate 不变，production overwrite 仍不可用；M2 仍未完成。
- Windows CPU/CUDA + media canonical assembly、production-model target launch/no-PATH 已闭环；顶层 `NATIVE-002` 仍需 macOS arm64 / Windows x64 packaged consumption。
- CUDA artifact 的下载/install/update/rollback 仍属于 `MODEL-002`；NVIDIA notices/EULA 分发闭环仍属于 `QA-005`，完成前不得分享 candidate。

## 下一步建议

1. 认领独立 packaged checkpoint，在 Windows x64 与 macOS arm64 构建真实 app/installer，验证 exact `extraResources` consumption、launch/no-PATH、缺件 fail-closed 与卸载/更新边界。
2. 保持 CUDA pack 独立于 base installer；由 `MODEL-002` 实现可恢复下载、安装、更新与回滚后再接 UI。
3. 只有两平台 packaged 矩阵及相关 BE/FS 证据全部闭环后，才评估完成顶层 `NATIVE-002`、`FS-TXN-001`、`BE-002` 或解除双重 `index-only` gate。
