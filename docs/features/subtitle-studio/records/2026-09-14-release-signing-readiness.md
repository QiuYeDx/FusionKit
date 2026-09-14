# 2026-09-14 发布签名与许可准备核查

对应：I9 / T-RELEASE-03。本文记录本机可复核的事实；实际安装包产物、跨平台安装生命周期与 I4 全体验收由各自任务记录承接。

## 打包入口与原生完整性

- 默认 `build` 在 TypeScript、三段 Vite 构建、preload bundle 检查后，显式选择 `electron-builder.subtitle-studio.json --publish never`。
- 当前组合审计对 `package.json` 仅接受精确审计的 `scripts.build` 变化，以及已拉取提交 `87d22d9` 中已存在的 `version: 0.3.0 → 0.3.1` 迁移。冻结来源 OID/SHA、当前 OID 和理由仍必填；任何依赖、其他字段、其他版本迁移及其他 build 配置变化均拒绝，历史基线和 replay 不改写。
- 双资源配置同时包含 `local-subtitle` 和 `subtitle-studio/transcription`；旧 `electron-builder.json` 保留供历史组件验收及来源基线使用。
- `scripts/packaging/sign-subtitle-studio.mjs` 对两根资源分别运行正式 runtime 验证器与 native-addon 验证器，比较外层签名前后的 manifest、全部 runtime artifact、addon 及构建回执摘要。资源根的前缀相似目录不在签名忽略范围内。
- 只有 `@electron/osx-sign` 1.0.5 使用 `strictVerify: false` 兼容方式；随后必须独立通过系统 `codesign --verify --deep --strict`。任何真实校验失败都不返回成功报告。
- 只读回验只接受 ad-hoc 或 Developer ID Application；显式传入 `--identity` 时还必须匹配指定模式。Developer ID 模式在签名和只读回验时均要求两根原生资源使用最终 Developer ID 签名，并要求外层应用存在 hardened runtime 标志和安全时间戳。
- 实际 ad-hoc 启动曾暴露 `dyld: different Team IDs`：当时系统 strict 验证通过，但主应用为 `adhoc,runtime` 且没有 Team ID。`osx-sign` 1.0.5 的 hardened runtime 选项必须在 `optionsForFile` 设置；现仅对本地 ad-hoc 模式设为 `false`，Developer ID 保持 `true`，只读回验也拒绝 ad-hoc + runtime 的组合。最终 app 仍必须完成真实启动与业务回验，不能以签名/hash 检查代替。重建后的启动结论由统一构建任务补充。
- 验证报告只包含摘要、相对资源身份和状态，不保存应用绝对路径、签名身份、密钥或完整命令输出。
- CLI 失败保留有限的阶段错误码（资源预检、外层签名、资源后检、系统严格验证或签名读取），不输出可能含私有路径/证书名的底层错误。

## 本机签名能力

只读检查结果：

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| `security find-identity -v -p codesigning` | 0 个有效身份 | 本机当前可见钥匙串没有可用于本次签名的 Developer ID 身份；不推断其他机器、离线证书或锁定钥匙串的情况 |
| `xcrun --find notarytool` | 可用 | 仅证明工具已安装 |
| 常见 CSC / Apple 公证环境配置 | 全部未设置 | 仅检查是否设置，不读取或输出值；未枚举、读取钥匙串内的密码条目 |
| `@electron/osx-sign` | 1.0.5 | 使用上述有界兼容处理和系统独立验证 |

检查的环境变量名称为 `CSC_LINK`、`CSC_NAME`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`、`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`NOTARY_KEYCHAIN_PROFILE`。

因此本机当前能继续 ad-hoc 签名与资源完整性验证，不能据此完成 Developer ID 签名、公证或 Gatekeeper 正式发行验收。没有尝试上传公证、发布外网或修改钥匙串。

ad-hoc 只证明本地签名完整性。签名工具分别报告 `appSignatureKind`、`nestedDeveloperIdSigned` 和 Gatekeeper 结果，同时明确 `notarizationPerformed: false`、`releaseReadinessAssessed: false`。

如以后使用 Developer ID，必须先以最终身份重做两套原生 staging、校验并冻结新 manifest，然后签外层应用；不能把既有 ad-hoc 原生资源在打包后原地重签，或仅把外层签成 Developer ID 就宣称完整发布通过。

## CUDA 12.4 许可证据

当前两份 CUDA manifest 均保留 `licenseClosure.status: pending` 与 `artifactSharingAllowed: false`，本次没有修改。

已核实的工程证据：

- 源 archive、精确体积和 SHA-256、20 个选中 PE artifact 及 24 个排除项已经固定；6 个 NVIDIA DLL 分别为 `cublas64_12.dll`、`cublasLt64_12.dll`、`cudart64_12.dll`、`nvblas64_12.dll`、`nvrtc-builtins64_124.dll`、`nvrtc64_120_0.dll`。
- [NVIDIA CUDA 12.4 官方 EULA](https://docs.nvidia.com/cuda/archive/12.4.0/eula/index.html) 的 2.6 Attachment A 包含上述 6 个 DLL 对应的无版本文件名，并明确允许包含版本号、架构信息的文件名变体。这支持它们属于可分发组件名单。
- 同一 EULA 的 1.1.2 Distribution Requirements 还要求应用提供实质新增功能、所分发 SDK 部分仅由该应用访问，以及应用分发条款与协议一致。文件名落在名单内不等于所有发行条件已完成。
- 两套冻结的 runtime licenses 目录包含 whisper.cpp 和 FFmpeg 许可/来源材料。本次另在维护侧新增 [NVIDIA 原始 EULA](../../../../scripts/packaging/licenses/NVIDIA-CUDA-12.4-EULA.html) 和 [6 个 DLL 的精确映射](../../../../scripts/packaging/licenses/NVIDIA-CUDA-12.4-component-mapping.json)，不改变冻结来源清单。EULA 原始页面为 82,548 bytes，SHA-256 `182734e0cee7c6217b911ef88fc92c4a1f487d1003c24dd9dab1597a399fb7c5`。

后续 CUDA closure 应补齐官方许可版本/原文证据、逐 DLL 映射、实际随包 notice/条款和按需资源分发方式的复核，然后同步两份 manifest 与各自精确合同/来源记录；不能只编辑 `pending` 状态。CUDA 不包含在默认安装包的 `extraResources` 中，因此 CPU/Metal 本地候选构建可以继续。

## FFmpeg 随发行材料

现有 `FFmpeg-8.1.2-source-offer.json` 固定了源码 archive、detached signature、签名指纹和构建配方；它的 `distributionSourcePolicy` 要求这些材料与分发该二进制的 FusionKit 发行一同提供。Windows BtbN 来源记录另保留完整 release、commit、archive hash 和 LGPLv3 条件。

本次已在忽略的 `release/0.3.1/third-party-materials/` 生成 36 份材料与 `manifest.json`、`SHA256SUMS`，包含确切 FFmpeg 源码/签名/公钥、两套构建配方及其本地依赖、冻结的许可与来源记录，以及新增 NVIDIA 条款与映射。末次审查发现 Studio 配方更新，已同步其私有输入快照、完整 flags 校验及复用的有界进程树 runner 依赖。两套配方均能从独立材料目录执行 `--help`，工作区材料与副本无摘要差异。复制后的 FFmpeg 源码重新通过固定指纹的 OpenPGP RSA-SHA512 验证，37 项 SHA-256 回读全部一致，材料 manifest SHA-256 为 `9d176e1a838c4a9708f29386229bb7cdac0e04f96d4c25cd40932c60b21e09de`。

材料目录只是一份本地候选附属产物，还没有归档/发布外网；Windows 广泛外部库 notice 和 CUDA 分发条件仍未闭环。最终构建任务应将这些材料与最终 DMG/ZIP 一起归档，并核对实际产物清单，不能把本地目录存在当作已经随公开发行交付。

Windows BtbN 二进制的 FFmpeg commit 为 `ce3c09c101c83add623774d414a9f9498caf5c25`（`n8.1.2-21-gce3c09c101`），与本材料中的上游 8.1.2 发布包不同。因此 Windows 后续还需提供该确切版本的对应源码/改动，以及外部库各自的源码和 notice；8.1.2 archive 不能替代这些材料。本次材料范围明确为 macOS 候选。

## 本地执行命令

使用项目约定的 pnpm 8.7.0；以下签名命令仅处理已有 app，不启动构建。实际产物路径由协调构建的任务填写。

```sh
pnpm build
node scripts/packaging/sign-subtitle-studio.mjs --app release/0.3.1/mac-arm64/FusionKit.app --identity -
node scripts/packaging/sign-subtitle-studio.mjs --app release/0.3.1/mac-arm64/FusionKit.app --verify-only
```

本机无签名身份时，electron-builder 24.13.3 会跳过外层签名，不会自动做 ad-hoc。为了让最终容器包含签好的 app，统一构建应在完成 TypeScript/Vite/preload 检查后执行下面的两阶段命令：

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false node node_modules/electron-builder/cli.js --config electron-builder.subtitle-studio.json --mac --arm64 --dir --publish never
node scripts/packaging/sign-subtitle-studio.mjs --app release/0.3.1/mac-arm64/FusionKit.app --identity -
CSC_IDENTITY_AUTO_DISCOVERY=false node node_modules/electron-builder/cli.js --config electron-builder.subtitle-studio.json --mac dmg zip --arm64 --prepackaged release/0.3.1/mac-arm64/FusionKit.app --publish never
node scripts/packaging/sign-subtitle-studio.mjs --app release/0.3.1/mac-arm64/FusionKit.app --verify-only
```

已核对当前 builder 的非 MAS `prepackaged` 分支会跳过 `doPack` 和签名，直接生成容器；因此该分支不执行 `beforePack`，首阶段双资源检查与最终 app/容器回读不能省略。

正式签名能力具备后的顺序是：最终 Developer ID 原生 staging → 双资源构建 → 外层签名 → 原始摘要与系统严格校验 → 公证 → staple 与 Gatekeeper → 最终 DMG/ZIP 重打包及回读。不得签完 `.app` 后仍分发签名前生成的旧 DMG/ZIP。

```sh
node scripts/packaging/sign-subtitle-studio.mjs --app release/0.3.1/mac-arm64/FusionKit.app --identity 'Developer ID Application: <configured identity>'
xcrun notarytool submit '<signed-distribution.zip>' --keychain-profile '<configured profile>' --wait
xcrun stapler staple release/0.3.1/mac-arm64/FusionKit.app
xcrun stapler validate release/0.3.1/mac-arm64/FusionKit.app
node scripts/packaging/sign-subtitle-studio.mjs --app release/0.3.1/mac-arm64/FusionKit.app --verify-only
```

这些带占位符的正式签名/公证命令是后续操作顺序说明，不表示本次已执行或已有可用身份。等待的签名身份、公证配置和 Windows 目标机状态不阻止当前 macOS ad-hoc 候选工作。

## 当前验证

- `node --test scripts/packaging/*.test.mjs`：23/23 通过，覆盖实际默认 builder 配置解析、双资源验证器、相似前缀排除、原生完整性变化拒绝、系统 strict 失败、Developer ID 前置条件、只读签名模式/运行时/时间戳回读、ad-hoc runtime 拒绝及脱敏阶段诊断。
- `copy.test.ts`：47/47 通过；真实 `node scripts/subtitle-studio-provenance/copy.mjs --check` 对固定提交的 120 个复制文件通过。新增反例包括依赖/其他字段改动、其他版本迁移、审计摘要失配和其他 build 文件越界，正例保留基线与 replay 原字节。
- 统一构建现已完成实际双资源 beforePack、ad-hoc 签名、严格校验、完整真实 app 工作流及 DMG/ZIP 全树回读。最终签名 app 可运行，两套冻结资源 hash 未变；见 [候选实施记录](2026-09-14-release-packaging.md) 与 [完整流程](2026-09-14-release-closeout.md)。正式签名/公证和 Windows 缺项仍保持上述边界。
- 没有执行 pnpm 安装、修改 lockfile、启动前端服务或模型推理服务。
