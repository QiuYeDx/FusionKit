# 工作包 CORE-002：资源 Manifest、路径 Resolver 与构建 Staging 合同

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`CORE-002`
- 目标平台：production contract 覆盖 macOS arm64 与 Windows x64；本次自动化验证主机为 macOS arm64，不替代 `NATIVE-002` 的真实 artifact/builder matrix

## 本次认领边界

- 包含：versioned staging contract、strict runtime manifest、dev/packaged resource root、manifest/artifact/evidence 静态校验、canonical staging preflight、构建产物忽略规则及合同测试。
- 不包含：正式 `electron-builder.extraResources` / `beforePack` / macOS sign ignore 接线、真实 production runner 生成、CUDA accelerator pack、模型/VAD 下载 manifest、server launch/HTTP probe、preload/IPC/capability 或 UI。

## 本次实现内容

- 新增 production `resource-manifest.ts`，复用 CORE-001 的 runtime manifest/server contract version 和 error code，使用递归 strict Zod schema 校验 manifest，并深冻结解析结果。
- 新增 production `resource-path.ts`，开发态只解析 `<appRoot>/build/local-subtitle-resources/local-subtitle`，packaged 只解析 `<resourcesPath>/local-subtitle`；调用链不读取 `process.cwd()`、PATH、Homebrew、注册表或用户 executable。
- manifest v1 固定 macOS nested-signed final bytes 与 Windows unsigned personal final bytes 两个 integrity profile；Windows base profile 精确要求 1 个 server、12 个 CPU DLL、ffmpeg 和 ffprobe。
- production artifact ID 与 PRE-006 对齐为 `whisper-server-win-x64-cpu` / `whisper-server-mac-arm64-metal-cpu`；artifact 与 license/source metadata、backend capability、相对路径、size、SHA-256、平台/架构、执行位和签名声明逐项绑定，target contract 还精确固定 evidence path、size 与 SHA-256；所有 artifact/evidence path 全局大小写不敏感唯一。
- 文件校验拒绝 absolute/parent/backslash/drive/ADS/保留名/NUL/超长路径、root/ancestor/leaf symlink 或 junction、目录或特殊文件、错 hash、错 native format/arch、fat Mach-O、无执行位和签名失败；manifest/artifact 使用同一 no-follow FileHandle 完成 fstat、streaming SHA + 有界 header、fstat 和最终 path identity，外部签名检查后重跑完整静态门禁。
- macOS x64 和不支持的平台在任何 filesystem/manifest 读取前返回稳定错误；错误消息不携带绝对路径。
- 新增 `local-subtitle-staging.v1.json` 作为 TS 与 Node staging 的共同合同，并让 PRE staging script 默认输出到 Git 忽略的 canonical build root；仍允许显式 `--output` 做隔离测试。
- staging copy 后按 Windows frozen pin 或 macOS build receipt/copy snapshot 重验目标字节，避免 receipt 校验后的 source replacement 被 manifest 背书。
- 新增 `validate-runtime-staging.mjs`，先冻结两端 `${arch}` artifact naming，再逐段拒绝 canonical root 的链接目录并执行 `point_in_time_static` runtime gate；validator 固定 `launch:false`，本包不修改 `electron-builder.json` 的正式资源映射。

## 修改文件

- `electron/main/local-subtitle/resource-manifest.ts`
- `electron/main/local-subtitle/resource-path.ts`
- `test/local-subtitle/resourceManifest.test.ts`
- `test/local-subtitle/resourcePath.test.ts`
- `test/local-subtitle/runtimeFixture.ts`
- `resources/local-subtitle/manifests/local-subtitle-staging.v1.json`
- `scripts/local-subtitle/runtime/staging-contract.mjs`
- `scripts/local-subtitle/runtime/staging-contract.test.mjs`
- `scripts/local-subtitle/runtime/validate-runtime-staging.mjs`
- `scripts/local-subtitle/runtime/validate-runtime-staging.test.mjs`
- `scripts/local-subtitle/runtime/runtime-manifest.mjs` 及其 test
- `scripts/local-subtitle/runtime/stage-runtime.mjs`、`stage-runtime-windows-x64.mjs` 及其 tests
- `src/type/localSubtitle.ts`
- `.gitignore`
- Final Design、主题/版本执行计划与 v0.2.11 README

## 接口或数据结构变化

- runtime manifest 顶层新增 `integrityProfile`，并与 target 的 hash phase、outer signature coverage 和 artifact `signatureKind` 形成不可拆分的 profile。
- 新增 `LocalSubtitleResourceEnvironment`：调用方必须显式选择 `development + appRoot` 或 `packaged + resourcesPath`，两个 root 都必须为绝对路径。
- `verifyLocalSubtitleRuntimeBundle()` 返回 deeply immutable 的 `artifactId -> verified absolute path` main-only map 与 `runtimeGeneration = manifestSha256`。该结果只代表验证完成时的时点快照；后续业务层按 artifact ID 取路径，但每次 batch commit 必须重新执行完整验证并比对预期 generation。
- `LOCAL_SUBTITLE_LIMITS` 增加 2 MiB manifest、artifact/license/source/evidence 数量及 512-char relative path 上限。
- staging contract v1 固定两个 target、required artifacts/evidence、integrity profile、canonical roots 和 `${productName}_${version}_${arch}.${ext}`；不包含真实 final-byte hash，真实 artifact manifest 仍由目标平台 staging 生成。

## 安全、隐私与许可证检查

- 生产模块不导入 PRE `.mjs`，只通过提交的 versioned JSON contract 保持字段一致；packaged 运行时不访问源码目录或 build staging。
- renderer/API 没有新增 executable/path 参数；新增 resolver 只属于 Electron main。
- 签名检查使用绝对 `/usr/bin/codesign` 和最小环境，不继承应用 Key、代理或下载 header；Windows v1 明确 unsigned，不伪称 Authenticode。
- license/source evidence 是 runtime manifest 的必需、精确 metadata，并参与文件 size/SHA/regular-file/containment 校验。
- canonical `ready` 只表示时点静态门禁通过，不宣称 descriptor-bound launch，也不承诺抵御同权限并发 writer 的瞬时 swap；server/media 的 just-in-time verify→spawn/probe 分别由 `NATIVE-001` / `MEDIA-001` 实现，最终 signed bytes、builder 消费与 outer-sign 前后复核由 `NATIVE-002` 实现。
- 未新增依赖、二进制、模型、下载缓存、测试媒体、真实路径或签名身份；未执行 `pnpm`，`package.json` / `pnpm-lock.yaml` 未变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/resourceManifest.test.ts test/local-subtitle/resourcePath.test.ts
node_modules/.bin/vitest run src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts test/local-subtitle/resourceManifest.test.ts test/local-subtitle/resourcePath.test.ts src/type/audioIpc.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node --test scripts/local-subtitle/runtime/staging-contract.test.mjs scripts/local-subtitle/runtime/runtime-manifest.test.mjs scripts/local-subtitle/runtime/stage-runtime.test.mjs scripts/local-subtitle/runtime/stage-runtime-windows-x64.test.mjs scripts/local-subtitle/runtime/validate-runtime-staging.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node --test scripts/local-subtitle/benchmark/*.test.mjs scripts/local-subtitle/whisper-server/*.test.mjs scripts/local-subtitle/runtime/*.test.mjs
git diff --check
```

结果：

- CORE-002 production Vitest：2 files / 42 tests 全部通过。
- CORE-001 + CORE-002 + Audio IPC：5 files / 117 tests 全部通过。
- 全量 Vitest：97 files / 918 tests 全部通过；TypeScript 通过。
- staging/runtime Node 定向：35 tests / 34 pass / 1 Windows-only skip；manifest validation 0 error / 0 warning；PRE manifest validator 17/17。
- 完整本地字幕 Node 套件：104 tests / 102 pass / 1 fail / 1 skip。唯一失败仍为既有 `run-pre005-smoke.test.mjs` 在 macOS 用 host path 解释 fabricated Windows PATH，命中 `FK-PIT-0030`；本包没有修改该 fixture，也没有新增失败。
- 未运行真实 staging、codesign final bytes、production runner launch 或 packaged app；这些需要 `NATIVE-002` 的目标平台 artifact，不得用 fixture 替代。

## 产生的证据与清理

- committed contract：`resources/local-subtitle/manifests/local-subtitle-staging.v1.json`。
- production contract tests：`test/local-subtitle/resourceManifest.test.ts`、`resourcePath.test.ts`。
- build contract tests：`staging-contract.test.mjs`、`validate-runtime-staging.test.mjs` 与更新后的 PRE runtime tests。
- `/build/local-subtitle-resources/` 已被精确忽略；本次没有生成该目录、native binary、model、download、`.partial` 或 packaged app。
- 只运行瞬时 Node/Vitest/tsc 进程，未启动 Vite、Electron 或其他前端服务。

## 未完成事项与风险

- `NATIVE-002` 需生成/获取真实 macOS arm64 与 Windows x64 official server final bytes，复用本合同产出 runtime manifest，并正式接入 `extraResources` / `beforePack` / signing exclusion 后跑 packaged no-PATH matrix。
- Windows CUDA accelerator pack 仍属于 `MODEL-002/NATIVE-002`，不能加入 base bundled runtime manifest；QA-005 仍需分发前复核 NVIDIA DLL 与 notices/source-offer。
- 静态校验通过后的 server/FFmpeg identity launch 和 HTTP contract 分别属于 `NATIVE-001`、`MEDIA-001`；当前 resolver 不宣称 runtime 已可运行。

## 下一步建议

- 优先认领 `CORE-003`，把 CORE-001 schema 与 CORE-002 verified resource lookup 接入独立 preload/IPC/capability 信任边界。
- `NATIVE-001` 可随后并行冻结 official server HTTP runtime contract；正式 artifact/builder 接线仍等 `NATIVE-001 + CORE-002` 后由 `NATIVE-002` 完成。
