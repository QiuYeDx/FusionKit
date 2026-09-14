# 实施记录：T-RELEASE-01 macOS 原生资源

| 字段 | 值 |
| --- | --- |
| 任务 | T-RELEASE-01 |
| 日期 | 2026-09-14 |
| 验证版本 | dec9010 + 2026-09-14-release.snapshot.json（SHA-256 38bd3dfec11f3b2bdd5bb3827cc4ea6461b12c6c7a80a691bb1edb0776d01849）；原生实物/实际app另以各自回执及报告绑定 |
| 环境 | macOS 26.2 / 25C56、arm64；Node 20.19.5、Vitest 2.1.9、Electron 41.10.6；CMake 4.4.0、Apple clang 21.0.0 (clang-2100.1.1.101)、macOS SDK 26.5，部署目标 11.0；未安装依赖或执行 pnpm |
| 任务指纹 | 9ea0d48fadad26504f5e618f6b520a37c362b2bb402c789d0ff4aef494d01d03 |

## 实际结果

按 I9 已批准范围补齐独立 macOS arm64 转写 runtime，输出到
`build/subtitle-studio-resources/transcription`。新增 Studio 命名空间的 Whisper
构建、FFmpeg 构建、签名 staging、CPU/Metal smoke、固定 FFmpeg 签名验证及对应测试。
既有固定 fork、旧工具源码和旧 staging 保留；没有通过复制旧二进制并改路径来代替新版构建。

Whisper 来自独立干净的上游 checkout，固定 `v1.9.1` /
`f049fff95a089aa9969deb009cdd4892b3e74916`。构建校验精确 tag/commit、工作树与子模块，
固定 CMake 哈希、clang/SDK 版本、编译定义、arm64/macOS 11 目标和路径映射。
产物含内嵌 Metal 库、CPU fallback，八项动态依赖均为系统库，未发现私有构建路径。

FFmpeg/ffprobe 从固定 8.1.2 源码归档新建。归档、签名与公钥先核对固定字节数和
SHA-256，再通过 Node/OpenSSL 验证固定 OpenPGP v4 RSA2048/SHA512 detached signature，
签名指纹为 `FCF986EA15E6E293A5644F10B4322F04D67658D8`。本实现是固定发行来源验证器，
不作为通用 OpenPGP 解析器。逻辑安装前缀维持
`/opt/fusionkit/local-subtitle/ffmpeg/8.1.2`，通过 DESTDIR 安装，保留 LGPL、禁用 GPL/
nonfree/version3/network、禁用外部库自动发现的既有编译契约。

三个 runtime 可执行文件在最终 staging 位置完成嵌套 ad-hoc 签名与 strict 校验后，
生成正式大小和 SHA-256。独立 overwrite addon 从 Studio 源码重新构建，在签名后按内容
地址发布；Electron 实际加载并核对导出成功，N-API 8、native protocol 4、journal 3。
外层应用签名与打包属于 T-RELEASE-03，本记录不将嵌套签名视为完整应用签名。

真实 `large-v3-q5_0` 模型通过固定 hash 与文件身份检查，CPU 和 Metal 各启动独立
loopback/private-path whisper-server，健康端点确认模型加载。两次均完成 bundled
FFmpeg/ffprobe 的单声道 16 kHz PCM16 解码，运行环境仅使用正式可执行文件目录。
Metal 同时观察到初始化和设备证据，未出现失败诊断；没有只凭 health=ok 推断 GPU 可用。
结果在受控关闭、等待 child close 和诊断排空后生成，进程与临时工作目录均已清理。

### 新安装路径中的 owner 边界修复

root 的真实 clean-profile 导入首次失败，报告保留于
`test-results/studio-release-real/run-E6NCgr/result.json`。runtime 校验已通过，资源作业却
返回 `runtime_protocol_mismatch`，没有创建 whisper-server child。诊断确认共享资源服务
使用应用级 owner `0`，而原生 supervisor 的真实 `validateOwner` 要求正数 owner ID。
早期 ready-resource 迁移对照和全量 mock 的 smoke 测试未执行这一新安装入口。

修复位于 `electron/main/subtitle-studio/transcription/shared-resources.ts`：每个专用
smoke factory 分配私有正值 owner 与随机 session，模型和 VAD 共用该专用 owner，
不同 factory 保持隔离。共享服务 owner `0` 与冻结原生校验不改；验证 await 前后检查
关闭状态，保留 native 与 startup-cleanup 的 shutdown join。

新增 admission 回归使用真实 supervisor `acquire`、owner 校验、runtime proof 与
session 文件系统，只控制 OS child/socket/HTTP/signature probe。它确认直接原生调用仍
拒绝 owner `0`，适配后的模型与 VAD 可准入，工厂会话互异，关闭后 child/session 已清理，
后续请求被 fence。该受控回归不冒充实际 ASR/模型加载；root 的完整新安装与真实语音链路
由 T-RELEASE-04 单独记录。经验已登记为 FK-PIT-0153。

### 脚本收尾复核

原生实物构建后复核发现并修复三处工具边界，未改编译参数或已有产物：

1. FFmpeg 先把归档、签名和公钥复制到私有 `source-inputs` 快照，再校验和解包同一快照，
   避免签名通过后原始路径被替换而构建了另一份来源。
2. 复用 Whisper 脚本的有界进程树 runner，FFmpeg 的 make/clang 后代随超时、超量输出
   或失败退出一并关闭；允许失败的 Git 探针仅接受清理完成的自然非零退出，不吞超时。
3. staging/build 对 FFmpeg 自报 configuration 按全部固定参数逐项比较，并接受 FFmpeg
   自带的参数值引号；缺少解码器、启用共享库、缩减 demuxer、追加 network 均被拒绝。

收尾后运行 35 项工具回归；另用真实固定来源验证快照签名和 tar 清单，并以现有新建的
FFmpeg/ffprobe 重跑 receipt 与完整参数校验，全部通过。本次没有再次完整重编译 native。
历史 `macos-tooling-origin.json` 与 `native-summary.json` 记录的是收尾前脚本版本，
最终来源摘要已追加于 2026-09-14-release-native-source-audit.json，原历史报告保持不变；不能把旧 target hash 当作最终源码证明。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-RELEASE-01-1 | 通过 | inline: 本机 `test-results/subtitle-studio-native-20260914-i9/` 的 Whisper/FFmpeg/addon build receipts、overwrite-staging.json、cpu-smoke.json、metal-smoke.json 证明固定来源、签名后 hash、Electron addon 导出和 CPU/Metal native 健康/解码；收尾工具回归 35/35，shared integration 8 文件 16/16、adapter/admission TypeScript 0 diagnostics；真实来源快照 signature=verified、tar 清单通过、现有 FFmpeg/ffprobe 完整参数通过；本 agent 进程表筛查为空。证据 hash 见下表，任务指纹及集成快照见元数据表 |

### 产物与原始证据摘要

所有以下路径相对仓库根；`test-results` 和 `build` 为保留在本机的忽略目录。

| 对象 | SHA-256 |
| --- | --- |
| `build/subtitle-studio-resources/transcription/manifests/subtitle-studio-runtime.v1.json` | e3cc55da97696ce6d606eb1cf513ec28a156a750798e159177512fcd3794db4f |
| 已签名 Whisper，3638160 字节 | b8488ebd36fa59ca1d0f0030d1d6de59b736f6be42cd96ad038603d0b321e2a6 |
| 已签名 FFmpeg，2775312 字节 | 4ea76d8f287ddc58ab050496fc09f7c0861f9b0e915ce0f394d776c7e02acda8 |
| 已签名 ffprobe，2583632 字节 | e823026d62cae64c283f159fab804f3c45a9f9223767cb72c14fcd0661100f69 |
| 已签名 overwrite addon，150304 字节 | 0e86674a51ea1f78f8a9cc5295a21e948a94f707b999d195f3582ee703021d81 |
| `test-results/subtitle-studio-native-20260914-i9/whisper-build/build-receipt.json` | 8799fc809476c3222250e1bd0272ac697223ae45dbc37653f17c626688c49874 |
| `test-results/subtitle-studio-native-20260914-i9/ffmpeg-build/build-receipt.json` | 446332735310283cfc317ca12ffa94279674ff170e18fabf70a828311ce2acaa |
| `test-results/subtitle-studio-native-20260914-i9/overwrite-build/build-receipt.json` | 8e67cada750610c1e9031ef634b4686cd7d37bc002c634de37f57cda7d876935 |
| `test-results/subtitle-studio-native-20260914-i9/overwrite-staging.json` | 361d53bfe68ab47930d157e33841e33c586199272e10cd21078680fc4e9ec8b2 |
| `test-results/subtitle-studio-native-20260914-i9/cpu-smoke.json` | 75dd3e5762d69aca3ec254efd22c76dbdaf5f1dc713d790ace2810831fe79b54 |
| `test-results/subtitle-studio-native-20260914-i9/metal-smoke.json` | 2d3f68ce6734959093ce132e59b8f0188a4728760c80cb0b15f929ef25b82c9a |

### 针对性复核命令

```bash
node --test scripts/subtitle-studio/transcription/runtime/build-ffmpeg-macos-arm64.test.mjs scripts/subtitle-studio/transcription/runtime/build-whisper-server-macos-arm64.test.mjs scripts/subtitle-studio/transcription/runtime/stage-runtime.test.mjs scripts/subtitle-studio/transcription/runtime/verify-ffmpeg-source-signature.test.mjs scripts/subtitle-studio/transcription/runtime/run-macos-runtime-smoke.test.mjs
node node_modules/vitest/vitest.mjs run test/speech-resources/integration/smoke-owner-admission.test.ts test/speech-resources/integration/smoke-startup.test.ts test/speech-resources/integration/adapters.test.ts test/speech-resources/integration/admission.test.ts test/speech-resources/integration/app-shutdown.test.ts test/speech-resources/integration/consumer-shutdown.test.ts test/speech-resources/integration/private-sessions.test.ts test/speech-resources/integration/window-bridge.test.ts --maxWorkers=1 --minWorkers=1
git diff --check
```

TypeScript 使用仓库 tsconfig 的 compiler options，以新 admission 测试与 shared-resources.ts
为 program roots，`affectedDiagnostics=0`、`transitiveDiagnostics=0`。这不是最终全仓库
TS 验收；最终静态检查由 root 的 T-RELEASE-04 统一执行。上述工具测试原先为 32 项，
收尾增加三项并强化 timeout/descendant 用例后为 35 项；原 tooling-tests.tap 保留历史结果。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-RELEASE-01-1 | 通过 | V-RELEASE-01-1 |

## 风险与未执行项

本记录只证明 macOS arm64 的独立 native/staging、实际 CPU/Metal 模型加载、解码与 owner
边界修复。完整真实转写、文档重开、翻译、单份/批量导出属于 T-RELEASE-04；它们的状态
以对应记录为准。历史 native-summary 中的旧任务分组字段仅为当时工作摘要，不覆盖当前
module-release/tasks.md 的权威分工。

当前嵌套签名为 ad-hoc，不能据此宣称 Developer ID、公证、Windows 或正式发行就绪。
外层签名、候选包和 FFmpeg 分发材料由发布负责人另行冻结；既有来源许可文件和固定
source/compile pins 未变。脚本收尾之后未再次完整编译 native，但已复核现有产物的完整
编译参数和来源快照验证路径，相关程序语义及产物 hash 不变。

本 agent 没有启动前端服务或执行 pnpm；原生构建/探针/受控进程测试均已退出。
最终进程表按本 agent 的 source/workroot 前缀筛查无匹配，保留忽略目录实物与报告用于
root 集成复核；未关闭其他 agent 的 Electron。最终任务指纹与工作树快照已由 root 统一补齐；最终工具来源追加审计见
2026-09-14-release-native-source-audit.json，原始构建报告保持不变。
