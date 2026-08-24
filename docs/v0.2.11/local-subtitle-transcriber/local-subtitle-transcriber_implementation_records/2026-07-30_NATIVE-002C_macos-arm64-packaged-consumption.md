# 工作包 NATIVE-002C：macOS arm64 packaged consumption

## 基本信息

- 日期：2026-07-30
- 状态：已完成（component checkpoint；顶层 `NATIVE-002`、`FS-TXN-001` 与 `BE-002` 仍为进行中）
- 对应执行计划工作包：`NATIVE-002` 的 macOS arm64 真实 packaged app、exact `extraResources` consumption、签名前后完整性与 production-model CPU/Metal 子合同
- 目标平台/硬件：macOS arm64，Apple Silicon 目标宿主
- 基线：本轮开始于 `b1f794ac9425619e5337ffc40517518f81069674`（`codex/local-subtitle-transcriber-design`）；后续接手应以包含本记录及本轮代码的最新提交为准
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## Windows 接手摘要

未来 Windows x64 Agent 不需要依赖聊天历史。macOS arm64 packaged component 已闭环；下一步只认领独立 `NATIVE-002D` Windows x64 packaged closure，不启动 `MODEL-002`、`FE-001`、VAD 或翻译开发，也不解除 production gate。

Windows 必须在真实 x64 目标机完成以下全部项目后，才能评估顶层状态：真实 x64 app 与 NSIS、exact `resources/local-subtitle`、official runtime + production addon、production-model CPU、production-model CUDA + exact-PID VRAM、bundled media/no-system-PATH、缺失/损坏/不可执行 fail closed、带空格和非 ASCII 安装路径、NSIS 安装/卸载/更新、`userData`/models/artifacts 保留、NTFS overwrite/recovery 回归、默认 `extraResources` 不含 CUDA。`QA-005` 前不得分享 CUDA candidate；矩阵通过前不得删除两处 `index-only`。完整命令和逐条判定标准见本文“Windows x64 目标机收尾手册”。

## 本次认领边界

本 checkpoint 使用正式 `electron-builder.json` 构建真实 arm64 `.app`，从 app 内 exact `Contents/Resources/local-subtitle` 重新验证 official runtime、overwrite addon、fail-closed、外层 ad-hoc 签名和 production-model CPU/Metal。它关闭的是 macOS packaged component，不是整个产品或发布流程。

包含：

- 使用仓库正式 builder 配置和正式 `beforePack` 门禁执行 `--mac --arm64 --dir`，不是手工拼装伪 app。
- 只从 `.app/Contents/Resources/local-subtitle` 消费 server、FFmpeg、ffprobe 与 content-addressed overwrite addon；验证器不接受 development canonical root 或 PATH fallback。
- 外层签名前后同时冻结 runtime manifest、3 个 official artifact、addon generation、addon artifact 与 build receipt；签后再次 fresh-load addon module exports。
- 对 app 执行外层 ad-hoc signing，并以系统 `/usr/bin/codesign --verify --deep --strict` 验证整个 bundle。
- 在 packaged path 上以 production `large-v3-q5_0` 完成 CPU 与 Metal private health、bundled media PCM16 decode 和 no-PATH smoke；Metal 证据来自 unrestricted 宿主执行。
- 新增平台中立 packaged validator，统一支持 macOS arm64 与后续 Windows x64 exact layout，并执行 9 项 fail-closed matrix。
- 修复 3 处跨平台纯测试夹具，使 Windows 语义测试能在 macOS 上稳定运行，而不放宽 production verifier。

不包含：

- Windows x64 app、NSIS 或安装/卸载/更新矩阵；
- Developer ID、notarization、Gatekeeper accepted 或 `QA-004`；
- DMG、zip 分发产物、签名身份/timestamp 或公开发布；
- renderer 到 main 到 packaged runtime 的完整产品 E2E、production overwrite 放行或 release ready 声明；
- CUDA delivery/download/install/update/rollback、`MODEL-002`、`FE-001`、VAD 或 translate。

## 本次实现内容

### Packaged validator

- 新增 `scripts/local-subtitle/runtime/verify-packaged-local-subtitle.mjs`。macOS 只接受 canonical `.app`，固定解析 `Contents/Resources/app.asar` 与 `Contents/Resources/local-subtitle`；Windows 只解析 app 目录下 `resources/app.asar` 与 `resources/local-subtitle`。
- validator 对 official runtime 使用 `scope=all`、`launch=true`，要求全部 artifact ready；对 overwrite addon 要求 staged verifier ready、content-addressed artifact、fresh module exports 和 no-PATH。
- validator 从 packaged root 运行既有 9 项 fault matrix，任一项未在 enqueue 前阻断即整体失败。报告不记录机器绝对路径，明确 `productionGateChanged=false`、`packagedProductE2EClaimed=false`、`releaseReady=false`。
- 新增测试冻结两平台 exact layout、path-free component report、verifier/fault fail closed 与 symlink app root rejection。

### 外层签名完整性

- `sign-packaged-spike.mjs` 的完整性 snapshot 从“official runtime only”扩展为“official runtime + overwrite addon”。签名前后都执行 official launch verification、addon staged verification 和 fresh module probe。
- snapshot 固定 runtime manifest、artifact hashes、addon generation、addon artifact SHA-256、build receipt SHA-256 与 `moduleExportsVerified=true`；外层签名造成任何漂移均拒绝。
- macOS 本轮只使用 ad-hoc outer sign。系统 deep/strict codesign 已通过，但该事实不能外推为 Developer ID、公证或 Gatekeeper accepted。

### 跨平台测试夹具

- Windows smoke environment 测试改用宿主 `path.join()` 构造纯夹具路径，避免在 macOS 上用 `path.delimiter` 解析硬编码 Windows 路径造成假失败。
- PRE-005 `where.exe` 测试改为临时目录中的 host-native 文件夹具，仍验证 Windows sanitized-PATH 查找逻辑，不要求 macOS 存在真实 `C:\Windows\System32\where.exe`。
- CUDA stager 测试在 `mkdtemp()` 前先 `realpath(os.tmpdir())`，避免 macOS `/var` 到 `/private/var` 别名触发严格 ancestor identity 假失败。production 的 canonical ancestor/symlink 检查未放宽。

## 修改文件

- `scripts/local-subtitle/runtime/run-native002-windows-smoke.test.mjs`
- `scripts/local-subtitle/runtime/run-pre005-smoke.test.mjs`
- `scripts/local-subtitle/runtime/stage-runtime-windows-x64-cuda.test.mjs`
- `scripts/local-subtitle/runtime/sign-packaged-spike.mjs`
- `scripts/local-subtitle/runtime/sign-packaged-spike.test.mjs`
- `scripts/local-subtitle/runtime/verify-packaged-local-subtitle.mjs`
- `scripts/local-subtitle/runtime/verify-packaged-local-subtitle.test.mjs`
- 本实施记录与同日 cross-platform runtime fixture fix 记录

## 真实产物与固定证据

- 真实 app：ignored `docs/v0.2.11/local-subtitle-transcriber/poc/native002c-macos-arm64.local/release/mac-arm64/FusionKit.app`。
- exact packaged runtime：`FusionKit.app/Contents/Resources/local-subtitle`；`app.asar` 与 runtime 均在真实 bundle 内。
- app主可执行文件为单一arm64 Mach-O且具备执行位；packaged validator不接受缺失、symlink、错格式或错架构主程序。
- runtime manifest SHA-256：`19271b1fdd4b8ec9a78731893a096f329154acbaea1504be9aaf01f175d22530`。
- official runtime：3 个 artifact（whisper server、FFmpeg、ffprobe）均从 packaged root launch，version identity 匹配，`noPathFallback=true`。
- overwrite addon generation：`cce55b2e09ea353fad28e4c2808faa12a7d8186505da5e4d4f174a2cce0530d5`。
- overwrite addon artifact：150,304 bytes，SHA-256 `f54671efeab266008a9324112f753416368e6a72fa9eda6b5fdca50ce773ecc2`。
- overwrite build receipt SHA-256：`e623bc37bd3fc31459a69d4c84495cc94eb916116ac93fb1aaa7f086a6ad315d`。
- 上述 addon generation/artifact/receipt 在 outer sign 前后不变，签后 fresh module probe 通过。
- production model：1,081,140,203 bytes，SHA-256 `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1`；模型不进入 installer。
- fail-closed matrix：9/9 在 enqueue 前阻断，包括 manifest/FFmpeg/license/source-offer/server 缺失、FFmpeg hash/architecture/executable/launch identity 错误。

## 验证结果

关键执行命令框架：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build
env CSC_IDENTITY_AUTO_DISCOVERY=false node_modules/.bin/electron-builder --mac --arm64 --dir --publish never --config.directories.output=<ignored-native002c-release>
node scripts/local-subtitle/runtime/sign-packaged-spike.mjs --app <ignored-native002c-release>/mac-arm64/FusionKit.app --identity -
/usr/bin/codesign --verify --deep --strict --verbose=2 <ignored-native002c-release>/mac-arm64/FusionKit.app
node scripts/local-subtitle/runtime/verify-packaged-local-subtitle.mjs --app <ignored-native002c-release>/mac-arm64/FusionKit.app --platform darwin --arch arm64 --faults-temp-parent <canonical-temp-parent>
node scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs --runtime <ignored-native002c-release>/mac-arm64/FusionKit.app/Contents/Resources/local-subtitle --model <ignored-production-model> --backend cpu --timeout-ms 300000 --report <new-ignored-report>
node scripts/local-subtitle/runtime/run-native002-macos-smoke.mjs --runtime <ignored-native002c-release>/mac-arm64/FusionKit.app/Contents/Resources/local-subtitle --model <ignored-production-model> --backend metal --timeout-ms 300000 --report <new-ignored-report>
node --test scripts/local-subtitle/runtime/*.test.mjs
node scripts/local-subtitle/runtime/validate-runtime-staging.mjs --platform darwin --arch arm64
git diff --check
```

结果：

- 正式 `electron-builder.json --mac --arm64 --dir` 构建通过，真实 arm64 app 位于上述 ignored evidence root。
- packaged validator 通过：exact layout、单一arm64 Mach-O app主程序、3 个 official artifact launch/no-PATH、addon fresh module probe、9/9 fail-closed 全部成立。
- 外层 ad-hoc signing 通过；runtime/addon 固定证据在签名前后不变；系统 deep/strict codesign 通过，bundle 为 ad-hoc signature。
- packaged-path CPU production-model smoke 通过：private health、bundled FFmpeg/ffprobe PCM16、no-PATH、close-confirmed cleanup 全部通过。
- packaged-path Metal production-model smoke 在 unrestricted 宿主通过：`initializationObserved=true`、`deviceObserved=true`、`failureObserved=false`、`backendVerified=true`。
- runtime suite：124 tests total，123 passed、0 failed、1 expected Windows-only skip。
- TypeScript、根 `vite.config.ts` renderer/main/preload 三段 build、canonical macOS staging validator 与 `git diff --check` 均通过。
- 本轮未启动前端 dev server；official server/FFmpeg/ffprobe 仅由有界验证脚本启动并完成 close/cleanup。

## 状态与禁止外推的结论

- `NATIVE-002C` component 已完成；不新增顶层工作包，顶层 `NATIVE-002` 仍为进行中。
- `FS-TXN-001` 与 `BE-002` 仍为进行中；Job Manager 与 Production Executor 两处 `index-only` gate 原样保留。
- 本记录只证明 macOS arm64 directory-packaged consumption。没有 Developer ID、公证、Gatekeeper accepted、DMG、Windows、完整产品 E2E 或 release ready 证据。
- packaged validator 的 `packagedProductE2EClaimed=false` 是有意边界；它验证 runtime/addon/build layout，不模拟完整 renderer 用户流程。
- 顶层剩余工作以 Windows x64 packaged closure 为主。不要因为 macOS component 完成而提前推进多个后续工作包。

## Windows x64 目标机收尾手册

### 1. 环境与输入冻结

在原生 Windows x64、NTFS 工作区执行。保持项目约定 pnpm 版本（约 `8.7.0`）；本手册使用 checked-in `node_modules` 中的 CLI，避免新版 pnpm 改写 `pnpm-lock.yaml`。先阅读本记录、`2026-07-29_NATIVE-002B_windows-x64-official-runtime-assembly.md` 与 `2026-07-29_FS-TXN-001J_windows-x64-protocol-v4-real-matrix.md`。

```powershell
$Repo = (Resolve-Path .).Path
$Node = (Get-Command node).Source
$Version = & $Node -p "require('./package.json').version"
$Out = Join-Path $Repo "release\$Version"
$App = Join-Path $Out "win-unpacked"
$Runtime = Join-Path $App "resources\local-subtitle"
$Model = "<ABSOLUTE_IGNORED_PATH_TO_ggml-large-v3-q5_0.bin>"
$Cuda = "<ABSOLUTE_IGNORED_PATH_TO_cuda-12.4-v1>"
$Work = "<ABSOLUTE_SHORT_EMPTY_IGNORED_NTFS_WORK_ROOT>"

git status --short
& $Node -p "process.platform + '/' + process.arch"
& $Node -p "require('./package.json').version"
```

判定：平台必须为 `win32/x64`；production model 必须为 1,081,140,203 bytes / `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1`。先按 NATIVE-002B 记录恢复 canonical Windows base runtime 与独立 CUDA candidate；不得把 CUDA root 复制进 base runtime。

### 2. 构建真实 x64 app 与 NSIS

```powershell
& "$Repo\node_modules\.bin\tsc.cmd" --noEmit
& "$Repo\node_modules\.bin\vite.cmd" build
& "$Repo\node_modules\.bin\electron-builder.cmd" --config electron-builder.json --win --x64 --dir --publish never
& "$Repo\node_modules\.bin\electron-builder.cmd" --config electron-builder.json --win nsis --x64 --publish never
```

判定：正式 `beforePack` 必须通过；`$App` 和真实 `FusionKit_<version>_x64.exe` 必须生成。不得用 fabricated app、development root 或只运行 builder config 单测替代。保存 ignored builder effective config、app inventory 与命令报告，不提交机器绝对路径或二进制。

### 3. Exact packaged runtime、addon 与 fail-closed

```powershell
$FaultRoot = Join-Path $Work "packaged-faults"
New-Item -ItemType Directory -Path $FaultRoot | Out-Null
& $Node scripts/local-subtitle/runtime/verify-packaged-local-subtitle.mjs `
  --app $App --platform win32 --arch x64 --faults-temp-parent $FaultRoot
```

判定：只接受 `$App\resources\local-subtitle`；必须存在 `resources\app.asar`，`FusionKit.exe`必须为单一x64 PE。报告必须为 `NATIVE-002D` / `packaged_component_passed`，official runtime 与 production protocol-v4 addon 都 ready，fresh module exports、content-addressed generation 和 no-PATH 为 true；Windows 9项matrix中的missing/corrupt/wrong-architecture/signature-policy/launch-identity必须全部`blockedBeforeEnqueue=true`。不得改为platform skip，也不得放宽production verifier。

Windows没有POSIX执行位，另须在复制的packaged fixture上用NTFS ACL拒绝当前用户执行FFmpeg或server，并确认静态通过后的实际launch在enqueue前以稳定launch error fail closed；在`finally`恢复ACL并删除fixture。不得把macOS的`chmod 0644`用例原样照搬，也不得直接改真实安装目录中的唯一证据副本。

### 4. Production-model CPU 与 CUDA

```powershell
& $Node scripts/local-subtitle/runtime/run-native002-windows-smoke.mjs `
  --runtime $Runtime --model $Model --backend cpu `
  --work (Join-Path $Work "cpu") --report (Join-Path $Work "cpu-packaged.json")

& $Node scripts/local-subtitle/runtime/run-native002-windows-smoke.mjs `
  --runtime $Runtime --model $Model --backend cuda --accelerator-runtime $Cuda `
  --work (Join-Path $Work "cuda") --report (Join-Path $Work "cuda-packaged.json")
```

判定：两份报告都必须为 `target_smoke_passed`，使用同一 production model；CPU 必须证明唯一显式 `--no-gpu`，CUDA 必须 `backendVerified=true` 并记录正的 exact-PID peak VRAM。`nvidia-smi` 只能是脚本定义的 fallback，不能用整机 VRAM 代替 exact-PID。两条路径都必须证明 bundled FFmpeg/ffprobe、PCM16 decode、private loopback、`noPathFallback=true`、无 CUDA Toolkit PATH authority、server close 与临时目录清理。

为证明不继承系统 PATH，可用绝对 Node 路径在清空父 PATH 后再跑 packaged validator/CPU smoke，并在 `finally` 恢复：

```powershell
$SavedPath = $env:Path
try {
  $env:Path = ""
  & $Node scripts/local-subtitle/runtime/verify-packaged-local-subtitle.mjs `
    --app $App --platform win32 --arch x64 --faults-temp-parent $FaultRoot
} finally {
  $env:Path = $SavedPath
}
```

### 5. 安装路径、NSIS 生命周期与数据保留

至少准备两个真实安装根：一个含空格，一个同时含空格和非 ASCII，例如 `C:\FusionKit Test\App` 与 `C:\测试 用户\FusionKit App`。用 NSIS UI 选择目录，或确保 `/D=<path>` 是 silent 参数最后一项；每个根都必须启动 app 并重复 exact packaged validator、CPU smoke 和可承受的 CUDA smoke。

执行 fresh install -> same-version repair/update -> newer build update -> uninstall。每一步前后对以下用户资产生成 inventory（relative path、size、SHA-256）并比较：

- Electron 实际 `<userData>`；
- `<userData>/local-subtitle/models`；
- local-subtitle session/job metadata 与 crash/recovery artifacts；
- 用户选择的已导出字幕文件。

判定：`electron-builder.json` 的 `deleteAppDataOnUninstall=false` 必须在真实 NSIS 行为中成立；repair/update/uninstall 不得删除或改写 models、用户数据和导出 artifacts。旧版忽略新 schema 可以接受，删除或静默迁移失败不接受。记录 installer/uninstaller exit code、最终目录状态和用户资产前后 hashes；不要记录字幕正文、媒体内容、token 或机器私有路径到 committed 文档。

### 6. NTFS overwrite/recovery 回归

从 packaged manifest 解析 content-addressed production addon，另按 001J 记录构建 test-only addon，然后在目标 NTFS 文件系统复跑：

```powershell
& $Node scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs `
  --addon "<ABSOLUTE_PACKAGED_PRODUCTION_ADDON.node>"
& $Node scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs `
  --addon "<ABSOLUTE_IGNORED_TEST_ONLY_ADDON.node>"
& $Node node_modules/vitest/vitest.mjs run `
  test/local-subtitle/overwriteTransaction.test.ts `
  test/local-subtitle/overwriteNativeBackend.test.ts `
  test/local-subtitle/overwriteRecoveryOwner.test.ts `
  test/local-subtitle/subtitleExporter.test.ts
```

判定：production terminal/recovery/rejection 与 fresh-process crash/retry/conflict/acknowledgement 矩阵不得回退；same-receipt retry、delete-pending HANDLE close 和 durable journal 行为仍须通过。即使矩阵通过，也不声称 power-loss safety，且不能因此解除 production gate。

### 7. CUDA 默认排除与许可证门禁

检查正式 `electron-builder.json`、effective config、`$App\resources` 与 NSIS 安装后 inventory：默认 `extraResources` 只能包含 canonical base `local-subtitle`，不得包含独立 CUDA accelerator root 或 20 个 CUDA candidate artifacts。CUDA candidate 继续位于独立 ignored root，`MODEL-002` 后续才负责 download/install/update/rollback。

`QA-005` 完成 NVIDIA notices/EULA 分发复核前：不得提交、上传、附加到 installer、发送给第三方或以其他形式分享 CUDA candidate。Windows smoke 通过只证明本机候选可运行，不构成分发许可结论。

### 8. 最终 gate 与文档回写

```powershell
& $Node --test scripts/local-subtitle/runtime/*.test.mjs
& $Node scripts/local-subtitle/runtime/validate-runtime-staging.mjs --platform win32 --arch x64
& $Node scripts/local-subtitle/benchmark/validate-manifests.mjs
rg -n "index-only|index_only|overwrite" electron/main/local-subtitle/job-manager.ts electron/main/local-subtitle/production-executor.ts
git diff --check
```

在独立 `NATIVE-002D` 实施记录中逐项写入真实命令、app/installer identity、runtime/addon/model hashes、CPU/CUDA/no-PATH/fault/NSIS/data/NTFS 结果和未覆盖边界。只有上述完整 Windows packaged matrix 通过后，才可以提出“是否解除”两处 gate 的新评估；本工作包内仍不得直接删除 `electron/main/local-subtitle/job-manager.ts` 与 `electron/main/local-subtitle/production-executor.ts` 的 `index-only`。

## 后续开发边界

下一轮只完成上述 Windows x64 packaged/installer closure 并回写 `NATIVE-002D` 证据。不要并行跨入 `MODEL-002`、`FE-001`、VAD、translate 或大范围产品流程；先以小 checkpoint 关闭当前三个进行中包的目标机证据缺口，再决定下一步。
