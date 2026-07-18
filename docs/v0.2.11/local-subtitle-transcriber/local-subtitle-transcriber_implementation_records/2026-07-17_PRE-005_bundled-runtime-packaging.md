# 工作包 PRE-005：Bundled runtime、打包门禁与许可证 PoC

## 基本信息

- 日期：2026-07-17～2026-07-18
- 状态：已完成
- 对应执行计划工作包：`PRE-005`
- 当前目标平台/硬件：macOS 26.2 / Apple M5 / arm64；Windows x64

## 本次认领边界

包含：

- 从固定 FFmpeg source archive 生成可审计的 macOS arm64 最小 LGPL
  `ffmpeg`/`ffprobe`。
- 建立 native runtime layout、versioned manifest、license/source evidence、
  Mach-O/PE architecture inspection、签名与 launch gate。
- 用 ignored electron-builder config 验证 `extraResources`、`${arch}`、
  `beforePack` 正反向行为与 macOS 外层签名顺序。
- 从 packaged app 的资源目录执行 no-PATH 格式、音轨、路径、无效输入与
  runtime fault matrix。
- 在 Windows x64 固定不可变 BtbN LGPL candidate，使用官方 FFmpeg release key
  完成 detached-signature fixed-fingerprint 验证，并实跑 unsigned personal
  distribution staging、builder 正反向门禁与 packaged no-PATH/fault matrix。
- 只提交脚本、许可证/来源记录和脱敏结果，不提交 native binary、源码、媒体、
  app 或 machine path。

不包含：

- 不创建 Windows 测试证书，不修改 `Cert:\CurrentUser\My` / `Root` 信任库；用户当前
  范围是本人和朋友安装使用，Windows profile 明确为
  `unsigned_personal_distribution`。代码签名不是功能运行前置。
- Developer ID、notarization、Gatekeeper accepted、DMG/ZIP 或公开无警告分发；
  owner 仍为未来 `QA-004`。
- Windows 公开发行证书、timestamp、SmartScreen reputation 与安装器无警告体验；
  这些只属于未来可选 `QA-003`，不阻塞当前使用范围。
- production resolver、Electron main media normalizer、UI/IPC、正式
  `extraResources` 接线或 PRE-006 技术冻结。

## 关键决策

### FFmpeg 来源与构建

- 固定 FFmpeg `8.1.2` / tag `n8.1.2`，source archive SHA-256 为
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`。
- detached signature、release key 与完整 fingerprint
  `FCF986EA15E6E293A5644F10B4322F04D67658D8` 均进入 source record。2026-07-18
  已在 Windows 使用 Git for Windows 的 `gpg`/`gpgv` 与显式 MSYS path adapter
  得到 `GOODSIG`/`VALIDSIG`，完整 fingerprint 精确匹配，cryptographic
  verification 状态为 `verified`。
- 构建关闭 GPL、nonfree、version3、network、autodetect、外部库和无关能力，
  只保留首版 9 种格式所需 demuxer/decoder/filter/WAV muxer。
- macOS deployment target 固定为 `11.0`；使用稳定逻辑 prefix
  `/opt/fusionkit/local-subtitle/ffmpeg/8.1.2` 与临时 `DESTDIR`，避免把
  `/Users/...` 或 temp build path 写入二进制。
- 最终 FFmpeg/ffprobe 必须是 thin arm64、只有系统动态依赖、版本输出无
  GPL/private path，并通过 executable launch。

### Windows FFmpeg candidate 与发行边界

- 选择不可变 BtbN release `autobuild-2026-06-30-13-34` 的
  `ffmpeg-n8.1.2-21-gce3c09c101-win64-lgpl-8.1.zip`，而不是漂移的 `latest`。
  release/asset ID 分别为 `346858151` / `462189264`，archive SHA-256 为
  `3b9eceb438016b647e0755a51ce3a388cd4ed5679e2427cb83a01e1ae2cd0eba`。
- `ffmpeg.exe` / `ffprobe.exe` 均为 x64 PE，报告精确版本
  `n8.1.2-21-gce3c09c101-20260630`；GPL/nonfree 关闭，version3 开启，适用
  `LGPL-3.0-or-later`。
- 该 candidate 两个程序合计约 225 MB，并启用 51 个外部库 flag；它只证明
  PRE-005 Windows packaging/media/integrity mechanics。体积裁剪、精确 source-build
  acquisition 与完整第三方许可证 closure 必须由 PRE-006 决定，不能把本候选直接
  升格为 production runtime。

### Manifest、签名与 Windows unsigned 顺序

签名与 hash 顺序固定为：

1. 把 server、ffmpeg、ffprobe 复制到最终 staging 相对路径。
2. 对三个 nested executable 施加最终 identity/identifier 并严格验证。
3. 从签名后的 bytes 计算 size/SHA-256，生成 runtime manifest。
4. 通过 `extraResources` 原样复制 frozen runtime，并从外层递归签名中排除。
5. 对外层 app 签名，随后比对 manifest/三个 artifact hash 并执行独立
   `/usr/bin/codesign --verify --deep --strict`。

原因是 `codesign` 会改变 Mach-O bytes；若先 hash 再签名，manifest 必然失效。
任何 nested identity/options 变化都必须重新 staging，不允许在已签 app 内改
manifest。

Windows 当前使用显式 unsigned 顺序：把 1 个 server、12 个必要 DLL、ffmpeg 和
ffprobe 复制到 final staging，不修改 PE bytes；以
`signatureKind = "unsigned"`、`binaryHashPhase =
"unsigned_final_bytes_before_outer_packaging"` 冻结全部 15 个文件的 size/hash 和
manifest。builder 只能复制 frozen runtime，并在打包后再次校验全部 artifact hash；
外层 `FusionKit.exe` 保持 `NotSigned`。脚本仍保留可选 Authenticode mode 供未来
`QA-003` 使用，但它不是当前 personal distribution 的 PRE-005 门禁。

当前依赖的 `@electron/osx-sign 1.0.5` 在 macOS 26 会生成无效的
`codesign --strict=true`。PoC 将 helper 的 `strictVerify` 局部关闭，但立即执行系统
`codesign --deep --strict` 并以其为 authority；这不是跳过签名验证。

### Packaged 与发行边界

- electron-builder 24.13.3 对 spike config 中 `identity: "-"` 仍报告 keychain
  identity 无效并跳过自动签名，因此 PoC 用独立脚本完成外层 ad-hoc signing。
- ad-hoc app 的 deep/strict 与 runtime integrity 可以证明 packaged-like 形态；
  它不能证明 Developer ID/notarization/Gatekeeper 公开发行能力。
- Gatekeeper 当前状态只记录，`pre005Gate=false`；缺 Developer ID 不影响
  FusionKit 本机使用，也不阻塞 PRE-005。
- Windows unsigned app 的 runtime、hash 门禁和媒体处理不依赖证书。分享给朋友时
  Windows 可能显示 Unknown Publisher / SmartScreen 提示，受管设备策略或安全软件也
  可能阻止未知程序；这是分发体验限制，不是应用功能依赖。

## 本次实现内容

- `build-ffmpeg-macos-arm64.mjs`
  - 校验 source/signature/key 的固定 size/hash 和 archive containment。
  - 隔离祖先 Git metadata，生成最小 LGPL 配置，验证 license switches、Mach-O、
    min OS、动态依赖、version output 和 private path。
  - 产出不含 absolute path/username 的 build receipt。
- `runtime-manifest.mjs`
  - 严格校验 manifest exact fields、relative containment、size/SHA、license/source
    reference、可执行位、Mach-O/PE architecture 与最小环境 launch。
  - 固定 `runtime_missing`、`media_runtime_missing`、`media_runtime_invalid`、
    `media_runtime_launch_failed` 的职责边界。
  - Windows signature gate 使用绝对
    `System32/WindowsPowerShell/v1.0/powershell.exe` 与 allowlisted
    `PSModulePath`，不依赖 PATH shim；已用 Windows 自带受信任 PE 实测 `Valid`。
- `stage-runtime.mjs`
  - 固定 mac-arm64/win-x64 layout；macOS staging 验证 build receipt、动态依赖、
    nested signature 后才生成 hash manifest，并复制 6 个 source/license files。
- `generate-electron-builder-spike.mjs` 与 `electron-builder-pre005-before-pack.cjs`
  - 生成 machine-local ignored config，接入 asar 外 `extraResources`、arm64 dir target、
    `${arch}` naming、nested sign ignore 和真实 `beforePack` runtime gate。
- `sign-packaged-spike.mjs`
  - 外层签名前后复核 runtime integrity，执行独立 deep/strict verification，并把
    Gatekeeper 与 PRE/release readiness 分开。
- `run-pre005-smoke.mjs`
  - 用 system FFmpeg 只生成短测试媒体；实际 probe/normalize 完全使用 packaged
    manifest 中的 ffmpeg/ffprobe。
  - 覆盖格式、真实视频轨、多音轨、长/非 ASCII 路径、corrupt/zero-duration、
    progress 与故障分类。
- `ffmpeg-source-release.mjs` 与 `audit-ffmpeg-windows-x64.mjs`
  - 共用 FFmpeg 8.1.2 source/signature/key pins；Windows 通过 `cygpath -u`、dearmor
    keyring 和 `gpgv --status-fd` 解决 native/MSYS path 语义差异。
  - 固定 BtbN immutable release、两个 PE 与 LGPLv3 license hash，审计 exact version、
    x64 architecture、GPL/nonfree/version3 switches 和 external-library inventory。
- `stage-runtime-windows-x64.mjs` 与 `authenticode-sign-file.ps1`
  - 固定 whisper.cpp CPU archive、server 和 12 个必要 DLL 的输入 hash；默认使用
    explicit unsigned profile，从 final bytes 生成 manifest，并以真实 launch gate
    验证。PowerShell signing helper 仅为未来可选模式，不在本次执行。
- `sign-packaged-spike-windows.mjs`
  - 支持未来对 outer `FusionKit.exe` 做可选签名；当前 unsigned profile 只校验
    `NotSigned` 与 packaged runtime 完整性，不创建或信任测试证书。
- builder/smoke 脚本
  - 已泛化为 native darwin/arm64 与 win32/x64；Windows 使用 `dir/x64`、绝对
    manifest path/no-PATH probe、PE machine fault 和 unsigned-policy fault；不生成
    `where.exe` 子进程。
- `resources/local-subtitle/licenses/*`
  - 纳入 whisper.cpp MIT、FFmpeg LGPL 文本、upstream license notes、third-party
    notice、source offer 与精确 build/source record。
- `electron-builder.json`
  - Windows/macOS artifact name 加入 `${arch}`；production `extraResources` 尚未接线。

## 关键证据

### Windows source 与 candidate audit（2026-07-18）

- 官方 source archive/signature/key 的 size/SHA 全部命中 pins；`gpgv` 返回
  `VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8`。
- BtbN archive、`ffmpeg.exe`、`ffprobe.exe`、`LICENSE.txt` 的固定 size/SHA 全部命中；
  两个程序以 sanitized PATH 启动并报告相同配置 hash
  `942a04ca7fafc83bb5ffaa5e40a4c74682b77e353b5d3e597d77219c54d04dc6`。
- Windows 自带 Microsoft catalog-signed x64 PE 复制到 workspace-local fixture 后，
  `runtime-manifest.mjs` 的 production Authenticode verifier 返回
  `verified_on_target_host`，证明未来可选签名 verifier 本身可用。当前实际 Windows
  runtime 使用 `unsigned_personal_distribution`，不要求这 15 个 PE 具有签名。

### macOS staged runtime

| Artifact | Signed size | Signed SHA-256 |
| --- | ---: | --- |
| `whisper-server` | 3,611,392 B | `159a1f8c79e27c741be6f4f7240b472663e7d45465ae24a49d86f7d87b7f6681` |
| `ffmpeg` | 2,775,312 B | `55f36865bfedfef597c1c6462ec92fcab1392bf418815e66b416195493bacc53` |
| `ffprobe` | 2,583,632 B | `8dfe0a7aba414a65a284eca637b04713c0ad0cabaf290f9b5f2679664fb60d09` |

runtime manifest SHA-256：
`fa82588f3e272db2031af3ed263ba5104596295260dbe0b30c529fef283e8320`。

### Windows unsigned staged runtime

- 15 个 x64 PE（server、12 个 DLL、ffmpeg、ffprobe）全部完成 size/SHA/architecture
  校验，3 个 program 均从 manifest 绝对路径成功启动。
- artifact 总大小：`234871296` B；signature kind 全部为 `unsigned`。
- runtime manifest SHA-256：
  `c4a44b9cb3326639afe9cae5589c25959dc041c8210ed32235f297df3dfeae64`。
- 未创建证书、未写入 `CurrentUser` 证书库，最终 `FusionKit.exe` 的 Authenticode
  状态为 `NotSigned`，符合本次 personal distribution profile。

### Builder 正反向门禁

- 从有效 signed staging 重新生成含 `beforePack` 的 ignored config 后，arm64 `dir`
  target 成功产出 `FusionKit.app`。
- 外层 ad-hoc signing 后 deep/strict 通过，manifest 与三个 artifact hash 均未改变。
- 复制一份有效 staging，在 config 成功生成后删除 `ffmpeg`；electron-builder 在
  `beforePack` 返回 `media_runtime_missing`，exit 1，输出目录没有 `.app`。
- Windows x64 `dir` 正向构建成功，输出 94 个文件、`789147424` B；
  `FusionKit.exe` 为 `189032448` B，SHA-256 为
  `b98a5cc74879e9ad7f81ed9c39300084e0c8322b555252a0216b25ba8151a77e`，状态
  `NotSigned`。复制有效 staging 并在 config 生成后删除 `ffmpeg.exe` 的反向构建以
  `media_runtime_missing` / exit 1 失败，且没有留下可运行 `FusionKit.exe`。
- 该 Windows unpacked spike 约 789 MB，体积主要来自 Electron 与 broad FFmpeg
  candidate；它证明 packaging mechanics，不是可直接分享的 production 安装器。

### Media 与 fault matrix

- mp3、wav、flac、aac、m4a、mp4、mkv、mov、webm 全部探测并规范化到
  16 kHz mono PCM16，全部观察到 FFmpeg progress end。
- mp4/mkv/mov/webm fixture 含真实视频轨；双音轨识别与显式第二音轨规范化通过。
- 非 ASCII 路径与 225 字符相对路径通过；corrupt input 与 zero-duration WAV 在
  enqueue 前拒绝。
- manifest/tool/license/source 缺失 → `media_runtime_missing`。
- hash 变化、错误架构、无 executable bit → `media_runtime_invalid`。
- 静态身份通过但版本启动身份错误 → `media_runtime_launch_failed`。
- server 缺失 → `runtime_missing`。
- Windows packaged smoke 同样覆盖上述 9 种格式、真实视频轨、多音轨、非 ASCII /
  225 字符路径、corrupt/zero-duration 与 9 类 fault；全部只使用
  `win-unpacked/resources/local-subtitle`，没有 PATH fallback。

## 安全、隐私与许可证检查

- 路径/capability：manifest 只接受 contained relative path；packaged runtime 不回退
  PATH、Homebrew、用户设置或 executable picker。
- 进程环境：server/ffmpeg/ffprobe 使用 allowlisted environment，不继承 API key、
  proxy 或下载 header；不经 shell。
- 日志/持久化：脱敏结果无 hostname、username、absolute path、PID、媒体内容或
  signing identity。
- 第三方来源：所有实际 staged component 都有 licenseRef/sourceRef 和 hash-covered
  evidence；当前记录是工程证据，不替代 QA-005 法务/发布审计。
- Git 边界：source archive、native binary、build/staging/app、fixture 和本地 report
  留在 ignored `.local` 或临时目录；`pnpm-lock.yaml` 未改动。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/runtime/*.test.mjs
node scripts/local-subtitle/runtime/audit-ffmpeg-windows-x64.mjs <ignored pinned-input arguments>
node scripts/local-subtitle/runtime/build-ffmpeg-macos-arm64.mjs <ignored pinned-source arguments>
node scripts/local-subtitle/runtime/stage-runtime.mjs <ignored native-input arguments>
node scripts/local-subtitle/runtime/generate-electron-builder-spike.mjs <ignored staging/config arguments>
node_modules/.bin/electron-builder --config <ignored spike config> --publish never
node scripts/local-subtitle/runtime/sign-packaged-spike.mjs --app <ignored packaged app> --identity -
node scripts/local-subtitle/runtime/run-pre005-smoke.mjs <ignored packaged-runtime/fixture arguments>
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory <ignored inventory>
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build
git diff --check
```

当前已确认：

- runtime Node tests：38/38 通过（含 Windows PGP/config/PE mutation、builder target、
  unsigned staging/profile/report、outer path 与真实受信任 Authenticode verifier）。
- benchmark、whisper-server、runtime 全量 Node tests：80/80 通过；本次 Windows
  workspace 环境中的 loopback/multipart test 直接通过。
- macOS arm64 FFmpeg build、signed staging、positive builder、negative missing-ffmpeg
  builder、outer signing 与 packaged smoke 全通过。
- Windows x64 official FFmpeg source PGP、immutable candidate audit、unsigned staging、
  positive/negative builder 与 packaged media/fault smoke 全通过。
- 普通 manifest 与真实 inventory strict validation 均为 0 error / 0 warning。
- `node_modules/.bin/tsc --noEmit` 通过。
- `node_modules/.bin/vite build` 通过；仅保留项目已有 dynamic/static import 与 chunk
  size warning，没有新增 build error。
- runtime 脚本 `node --check`、全部 committed JSON parse、`git diff --check` 和新增
  文件 trailing-whitespace scan 通过。
- 没有运行 `pnpm install` 或任意版本 `pnpm`；仅使用仓库现有
  `node_modules/.bin/*`。

## 产生的证据

- 已提交脱敏汇总：
  `docs/v0.2.11/local-subtitle-transcriber/poc/pre005-macos-arm64-results.json`
- 已提交 Windows 脱敏汇总：
  `docs/v0.2.11/local-subtitle-transcriber/poc/pre005-windows-x64-results.json`
- 本机 ignored smoke report：
  `docs/v0.2.11/local-subtitle-transcriber/poc/pre005-macos-arm64.local/results/pre005-packaged-smoke.json`
- 本机 ignored Windows FFmpeg audit receipt：
  `docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local/pre005-windows/ffmpeg-audit-receipt.json`
- 本机 ignored Windows packaged smoke report：
  `docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local/pre005-windows/pre005-packaged-smoke.json`
- 本机 source/build/staging/app/media 均位于 ignored `.local` 或系统临时目录，不进入
  Git。

## 未完成事项与风险

- PRE-005 无未完成验收项；Windows personal-distribution 范围已由用户明确选择
  unsigned profile，证书不再是 blocker。
- Windows broad candidate、macOS source-build acquisition policy、production
  artifact 体积与完整第三方许可证 closure 由 PRE-006 一并冻结；当前 ignored spike
  不是 production builder config，也不是最终安装器。
- 未签名包分享给朋友时可能出现 Unknown Publisher / SmartScreen 提示，企业策略或
  安全软件也可能拦截。若未来要求公开、低提示分发，再由 QA-003 引入受信任证书、
  timestamp 与 installer 验收。
- Developer ID/notarization/Gatekeeper accepted 由 QA-004 处理，不得重新提升为 PRE
  blocker。

## 下一步建议

1. 进入 PRE-006，冻结跨平台 production artifact、Windows FFmpeg 裁剪/来源方案、
   acquisition policy、精确许可证 closure 与正式 builder 接线合同。
2. 继续保持 Windows unsigned personal distribution；除非用户以后明确要求公开
   低提示发布，否则不引入证书或信任库变更。

## 进程清理

本次没有启动 Vite、Electron UI 或其他常驻前端服务。FFmpeg、ffprobe、
whisper-server 和 electron-builder 均为有界命令。结束前已删除本次 negative/smoke
临时目录、旧 FFmpeg audit、重复 staging v2 和早期 fixture；进程表复核没有匹配的
Vite、Electron、whisper-server、FFmpeg、ffprobe 或 electron-builder 进程。

2026-07-18 Windows continuation 的 electron-builder、FFmpeg、ffprobe、
whisper-server、PGP 与 Node tests 均为有界进程。已清理 11 个失败/诊断/negative
fixture 目录与所有命令 capture 文件，保留成功的 ignored staging、正向 unpacked app、
receipt 与 smoke report。被拒绝的证书操作在执行前拦截；复核 `My`、`Root` 和导出
路径均无目标测试证书/文件。
