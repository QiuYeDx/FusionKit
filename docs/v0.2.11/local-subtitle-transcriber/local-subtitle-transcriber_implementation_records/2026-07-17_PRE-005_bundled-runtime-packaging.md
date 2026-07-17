# 工作包 PRE-005：Bundled runtime、打包门禁与许可证 PoC

## 基本信息

- 日期：2026-07-17
- 状态：进行中
- 对应执行计划工作包：`PRE-005`
- 当前目标平台/硬件：macOS 26.2 / Apple M5 / arm64

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
- 只提交脚本、许可证/来源记录和脱敏结果，不提交 native binary、源码、媒体、
  app 或 machine path。

不包含：

- Windows x64 可分发 FFmpeg 选择、packaged no-PATH、AuthentiCode 和 fault
  matrix；这些仍属于 PRE-005 的未完成目标平台证据。
- 在当前无 OpenPGP verifier 的机器上伪造 FFmpeg detached-signature 验证。
- Developer ID、notarization、Gatekeeper accepted、DMG/ZIP 或公开无警告分发；
  owner 仍为未来 `QA-004`。
- production resolver、Electron main media normalizer、UI/IPC、正式
  `extraResources` 接线或 PRE-006 技术冻结。

## 关键决策

### FFmpeg 来源与构建

- 固定 FFmpeg `8.1.2` / tag `n8.1.2`，source archive SHA-256 为
  `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`。
- detached signature、release key 与完整 fingerprint
  `FCF986EA15E6E293A5644F10B4322F04D67658D8` 均进入 source record；本机
  没有 `gpg`/`gpgv`/`sq`/`rnp`，因此只验证文件 hash，不把 cryptographic
  verification 标成成功。
- 构建关闭 GPL、nonfree、version3、network、autodetect、外部库和无关能力，
  只保留首版 9 种格式所需 demuxer/decoder/filter/WAV muxer。
- macOS deployment target 固定为 `11.0`；使用稳定逻辑 prefix
  `/opt/fusionkit/local-subtitle/ffmpeg/8.1.2` 与临时 `DESTDIR`，避免把
  `/Users/...` 或 temp build path 写入二进制。
- 最终 FFmpeg/ffprobe 必须是 thin arm64、只有系统动态依赖、版本输出无
  GPL/private path，并通过 executable launch。

### Manifest 与签名顺序

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
- `resources/local-subtitle/licenses/*`
  - 纳入 whisper.cpp MIT、FFmpeg LGPL 文本、upstream license notes、third-party
    notice、source offer 与精确 build/source record。
- `electron-builder.json`
  - Windows/macOS artifact name 加入 `${arch}`；production `extraResources` 尚未接线。

## 关键证据

### Staged runtime

| Artifact | Signed size | Signed SHA-256 |
| --- | ---: | --- |
| `whisper-server` | 3,611,392 B | `159a1f8c79e27c741be6f4f7240b472663e7d45465ae24a49d86f7d87b7f6681` |
| `ffmpeg` | 2,775,312 B | `55f36865bfedfef597c1c6462ec92fcab1392bf418815e66b416195493bacc53` |
| `ffprobe` | 2,583,632 B | `8dfe0a7aba414a65a284eca637b04713c0ad0cabaf290f9b5f2679664fb60d09` |

runtime manifest SHA-256：
`fa82588f3e272db2031af3ed263ba5104596295260dbe0b30c529fef283e8320`。

### Builder 正反向门禁

- 从有效 signed staging 重新生成含 `beforePack` 的 ignored config 后，arm64 `dir`
  target 成功产出 `FusionKit.app`。
- 外层 ad-hoc signing 后 deep/strict 通过，manifest 与三个 artifact hash 均未改变。
- 复制一份有效 staging，在 config 成功生成后删除 `ffmpeg`；electron-builder 在
  `beforePack` 返回 `media_runtime_missing`，exit 1，输出目录没有 `.app`。

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

- runtime Node tests：23/23 通过。
- benchmark、whisper-server、runtime 全量 Node tests：65/65 通过；其中 loopback
  HTTP test 在受限沙箱内预期被 `listen EPERM` 阻止，使用同一代码在本机允许的
  loopback 环境重跑后通过，不是产品回归。
- macOS arm64 FFmpeg build、signed staging、positive builder、negative missing-ffmpeg
  builder、outer signing 与 packaged smoke 全通过。
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
- 本机 ignored smoke report：
  `docs/v0.2.11/local-subtitle-transcriber/poc/pre005-macos-arm64.local/results/pre005-packaged-smoke.json`
- 本机 source/build/staging/app/media 均位于 ignored `.local` 或系统临时目录，不进入
  Git。

## 未完成事项与风险

- Windows x64 仍需选择可审计 FFmpeg/ffprobe artifact，生成同合同 manifest，完成
  packaged no-PATH、AuthentiCode、multiple format/path/fault matrix。
- FFmpeg detached signature 必须在有 OpenPGP verifier 的受控环境使用固定完整
  fingerprint 验证；不能只凭 `.asc`/key 文件 hash 宣称 cryptographic success。
- Windows 结果和 macOS source-build acquisition policy 由 PRE-006 一并冻结；当前
  ignored spike 不是 production builder config。
- Developer ID/notarization/Gatekeeper accepted 由 QA-004 处理，不得重新提升为 PRE
  blocker。

## 下一步建议

1. 将本提交带到 Windows x64 目标机，补 Windows PRE-005 artifact、AuthentiCode、
   no-PATH 与 fault evidence。
2. 在装有可信 OpenPGP verifier 的构建/发布环境用固定 full fingerprint 验证 FFmpeg
   detached signature，并让 `--require-signature` build path 通过。
3. 两项外部证据完成后把 PRE-005 标为已完成，再执行 PRE-006 production 技术冻结。

## 进程清理

本次没有启动 Vite、Electron UI 或其他常驻前端服务。FFmpeg、ffprobe、
whisper-server 和 electron-builder 均为有界命令。结束前已删除本次 negative/smoke
临时目录、旧 FFmpeg audit、重复 staging v2 和早期 fixture；进程表复核没有匹配的
Vite、Electron、whisper-server、FFmpeg、ffprobe 或 electron-builder 进程。
