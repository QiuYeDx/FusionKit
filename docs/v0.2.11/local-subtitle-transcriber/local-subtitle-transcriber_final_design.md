# 本地字幕转写工具调研与 Final Design

> 日期：2026-07-16
>
> Feature Slug：`local-subtitle-transcriber`
>
> 状态：调研、Final Design、`PRE-001`～`PRE-006`、`CORE-001`～`CORE-004`、`NATIVE-001`、`BE-001`、`MEDIA-001`、`SUB-001`、`SUB-002` 与 `MODEL-001` 已完成。production decision record 固定 `whisper.cpp v1.9.1`、Node-managed HTTP contract v1、`large-v3-q5_0` 首发默认、跨平台 FFmpeg 8.1.2、Windows unsigned personal profile 与目标平台矩阵；shared schema、resource staging、preload/IPC/capability、renderer session、official server contract、真实 Supervisor 生命周期、media normalization/PCM proof、canonical post-processing、SRT/LRC 原子导出、Artifact Registry 与 managed model 合同已冻结。`BE-002` 已接通最多 100 文件的 CPU/transcribe/no-VAD、custom 或 source、index-only、export-only 批次，可按请求顺序生成 SRT-only、LRC-only 或无重复双格式，并稳定结算 full、普通 partial 与 commit 后取消 partial；逐文件失败隔离、owner 分区续权、exact-identity batch runtime pin 与可信多父目录 source output 已实现。`FS-TXN-001A`～`FS-TXN-001F` component checkpoints 已完成：macOS arm64与Windows x64当前冻结protocol v4 / journal v3、schema-v2 path-free durable preclaim/decision、`.finalize`/`.rollback` terminal marker + acknowledgement、main/Registry composite recovery owner与重新授权后的exact lazy recovery；POSIX/Windows exact filesystem identity已贯通输出目录authorization、Artifact Registry、Exporter、recovery selection与Executor directory proof。001F验证为macOS native 11/11、Windows contract 6 passed + 真实Windows 1 skipped、local-subtitle 914 passed + 2 skipped、全量1867 passed + 2 skipped、TypeScript、三段Vite、manifest 0/0与validator 17/17通过。production main/IPC/UI、verified staging/builder、真实Windows protocol v4矩阵与两平台packaged validation仍未完成。Job Manager / Production Executor 继续保持双重 `index-only` gate，`FS-TXN-001` 与 `BE-002` 均保持进行中
>
> 产品定位：使用本地算力把批量音频/视频转成可直接翻译的 SRT/LRC 字幕
>
> 历史调研输入：`faster-whisper-GUI-main`；FusionKit 不复刻该应用，也不依赖其快照、配置、模型或输出一致性
>
> 2026-07-16 修订：补充“仅导出 / 自动加入字幕翻译队列 / 自动加入并开始翻译”三种后处理模式及配置快照边界
>
> 2026-07-16 计划：已创建 `local-subtitle-transcriber_execution_plan.md`；审查后拆分为 38 个实现/验收工作包，2026-07-22 为目录句柄相对 overwrite 单独新增 `FS-TXN-001`，当前共 39 个
>
> 2026-07-16 审查修订：补齐部分导出、会话重同步、资源任务、协议取消、无模型入队和 Agent/恢复消费者迁移合同；修正实际共享组件名与打包边界
>
> 2026-07-16 实施进展：PRE-001 已按产品开发目标收口并完成；macOS arm64 source-build 与 Windows x64 CPU/CUDA 官方预编译三份 scoped 报告均 ready，3 段中/日真实语料及对应 SRT/LRC 的本机 integrity/timeline inventory 和严格校验通过
>
> 2026-07-16 范围变更：macOS 仅支持 arm64；删除 macOS x64 产物与验收。发布版 FFmpeg/ffprobe 固定随应用打包，用户无需安装系统 FFmpeg
>
> 2026-07-16 PRE-001 收口：现有 3 个样本即为开发启动范围；不要求英文/额外声学场景、独立校对真值、样本权利审计、FasterWhisperGUI 快照/配置、CTranslate2 `large-v3` hash 或输出一致性
>
> 2026-07-17 PRE-002 架构修正：官方预编译 `whisper-server` 已实测覆盖模型驻留、结构化 JSON、取消与健康检查；首版改为 Node 管理官方 server，不再预设 FusionKit C++/JSONL runner 或 Windows 本地 CMake/MSVC
>
> 2026-07-17 PRE-003 收口：官方 Windows CPU/CUDA server 与 `large-v3-q5_0` 已跑通现有 3 段中/日媒体；CUDA RTF 0.0509～0.0735、峰值显存约 2.12 GB，CPU RTF 0.5063～0.592、峰值 RAM 约 2.50 GB；SRT/LRC 回读、模型复用、取消与静默 CPU 降级门禁均通过
>
> 2026-07-17 PRE-004 证据修正：精确 `whisper.cpp v1.9.1 / f049fff` 源码构建的 thin arm64、内嵌 Metal server 已在 Apple M5 通过 Metal/CPU backend、RTF/RSS、复用、取消和 packaged-like 检查；但原始 `verbose_json` 已出现最长 347 段连续重复、零时长和媒体越界，SRT/LRC parse-back 只证明序列化结构。故障区间用相同 greedy backend 独立推理约 30 秒窗口可恢复实际内容，因此 PRE-004 因整段字幕有效性失败而保持进行中；Developer ID、公证与 Gatekeeper accepted 属于未来 `QA-004`，不阻塞本工作包
>
> 2026-07-17 PRE-004 完成：最终采用一次性 PCM16 规范化、30 秒独立窗口/5 秒 overlap、owned-core 合并、raw quality gate、有界拆短和 VAD。v1.9.1 VAD 只消费映射回原媒体的 segment 时间，禁止压缩时间轴 token/word；3 样本 Metal/CPU 的最长连续重复最多 2 cue、raw 时间轴错误 0，RTF 均 < 1。Gatekeeper rejected 继续仅归未来 `QA-004`
>
> 2026-07-17 PRE-005 macOS 阶段记录：固定 FFmpeg 8.1.2 最小 LGPL arm64 构建与 macOS 11 target；nested 签名后冻结 manifest hash，`extraResources`、`beforePack` 缺件失败、外层 ad-hoc deep/strict 签名、9 格式/多音轨/长路径/no-PATH/fault matrix 均通过。当日尚待 Windows 子矩阵，已由下方 2026-07-18 完成记录闭环

> 2026-07-18 PRE-005 完成：固定 BtbN `autobuild-2026-06-30-13-34` LGPLv3 x64 candidate，archive/PE/config/license 审计和官方 FFmpeg 8.1.2 detached-signature 完整 fingerprint `VALIDSIG` 通过；15 个 x64 PE 以 `unsigned_personal_distribution` staging，x64 builder 正反向、9 格式/多音轨/长路径/no-PATH/9 类 fault matrix 全部实跑通过，runtime tests 38/38。未创建证书、未修改信任库；当时留给 PRE-006 的 production 体积/依赖/许可证策略已由下一条完成记录闭环

> 2026-07-18 PRE-006 完成：`poc/pre006-production-decision.json` 将五项 production 决策全部标记为 `go`。Windows 默认随 CPU runtime、CUDA 12.4 官方包按需安装；macOS arm64 默认 Metal 并保留显式 CPU，macOS x64 固定拒绝。Windows 采用已实跑的 immutable BtbN LGPLv3 baseline，不引入本地 source-build 工具链；个人/朋友分发继续不要求 Windows 代码签名、证书或信任库。阶段式进度已满足 v1，首版不建 native bridge；第三方 notices 与 NVIDIA 精确 DLL 清单仍由 `QA-005` 在分发前复核

> 2026-07-21 CORE-001 完成：新增独立 `localSubtitle.ts` / `localSubtitleIpc.ts`，冻结 domain、状态机、full/partial/none-success、task generation/session revision、post-action、错误 manifest、canonical transcript、strict request/event/snapshot schema 与 v1 上限；57 项定向 Vitest、TypeScript、PRE-006 manifest drift 校验与 Audio IPC 回归通过。preload channel、owner capability、native HTTP parser 和 resource resolver 仍分别属于 `CORE-003`、`NATIVE-001`、`CORE-002`

> 2026-07-21 CORE-002 完成：新增 production strict runtime manifest、dev/packaged resource resolver、完整 Windows CPU DLL/profile/evidence 绑定、symlink/containment/size/SHA/arch/execute/signature gate，以及共享的 versioned staging contract/canonical preflight。CORE-002 定向 42 项、CORE+Audio 117 项、全量 918 项 Vitest 与 TypeScript/manifest/Node gate 通过；正式 `extraResources`、真实 artifact 和 launch/HTTP probe 仍分别属于 `NATIVE-002`、`NATIVE-001` / `MEDIA-001`

> 2026-07-21 CORE-003 完成：冻结 15 个 public invoke、6 个 preload-private、2 个 event channel 和完整 fixed `window.localSubtitleApi`；main 为 top document/frame 签发私有 owner session，input/output draft capability、atomic task/batch lease、artifact ref/import token 骨架均独立于 Audio registry。legacy generic bridge 拒绝整个 namespace、丢弃 raw Electron event，并修复同源子窗口的 `nodeIntegration` 绕过。公开 artifact summary 收口为 ref/format/displayName/expiry，size/hash/path 保持 main-private；真实 media/model/task/artifact handler 仍分别属于后续 owner 包

> 2026-07-21 CORE-004 完成：新增仅持久化安全偏好的 `fusionkit-local-subtitle-transcriber` Store、共享 task/resource revision reducer、SPA 级 runtime singleton 与 draft capability cleanup retry。runtime 先订阅后取快照，保留缓冲事件的 identity/generation observation，处理 gap、overflow、stale generation、tombstone、epoch invalidation 和 observer failure；prompt、File、token、task、artifact、字幕正文、路径及诊断均不持久化。9 files / 132 tests 定向、全量 109 files / 1034 tests、TypeScript、Vite test build 与 manifest gate 通过

> 2026-07-21 NATIVE-001 完成：新增 pinned official server schema、显式 `node:http` multipart transport、opaque verified bundle 驱动的 launch/load identity、最小环境和有界脱敏诊断。startup readiness 与 runtime health 分离，health/inference 共用 single-active ticket；推理 deadline 覆盖文件 open/stat/upload/close，任何 mid-request/timeout/schema/cleanup failure 都要求新 process generation。定向 4 files / 75 tests、全量 113 passed + 1 skipped files / 1109 passed + 1 skipped tests、TypeScript 与 real CPU two-request/same-PID smoke 通过。child/session/port/restart/kill/owner cleanup 的独占 owner 为 `BE-001`，现已由下一条完成

> 2026-07-21 BE-001 完成：新增 identity-bound `0700` private session filesystem、opaque owner/load lease、独立 process epoch、同步 single-active request ticket、fresh startup retry、runtime health restart、CPU/GPU backend attestation、close-gated idempotent finalization，以及 owner/app/update lifecycle。聚焦 3 files / 37 tests、显式 exact v1.9.1 CPU real 1/1、全量 116 passed + 2 skipped files / 1146 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest/validator 与进程清理通过。PCM window 仍属 `MEDIA-001`，raw quality/retry 属 `SUB-001`，Job Manager 属 `BE-002`，startup orphan scan 属 `BE-003`

> 2026-07-21 SUB-001 完成：新增 versioned segment-only post-processing policy、root plan + attempt graph、stable lineage/generation、exact retry replacement、verified no-speech evidence、PRE-004 raw gate、owned-boundary merge、grapheme-safe canonical shaping 与 `estimatedTiming` schema。`timeline_boundary_clamped` / `estimated_timing_used` 只留在 main processing report，shared completion warning v1 仍只有 `cancelled_after_partial_commit`。正式 PCM/WAV branded identity 仍属 `MEDIA-001`，SRT/LRC/atomic artifact 仍属 `SUB-002`；非 VAD word timeline 等待未来 versioned server capability。

> 2026-07-21 MEDIA-001 完成：新增 shell-free bounded FFmpeg/ffprobe process contract、固定 bundle/version/no-PATH attestation、授权源 snapshot 与音轨 binding、decode-time `-t`/`-fs` guard、RIFF/RF64 16 kHz mono PCM16 校验、exact frame window/SHA-256/main-only proof，以及 owner fault/release/app shutdown 的 close-gated cleanup；`probeMedia` 已接入 app-scoped runtime。聚焦 4 files / 84 tests、全量 121 passed + 2 skipped files / 1312 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest/validator 与 diff gate 通过。目标平台 final bytes、`extraResources`、builder/signing 与 packaged no-PATH smoke 仍属 `NATIVE-002`；dispatch/response 原子 binding 与启动 orphan 扫描仍属 `BE-002` / `BE-003`。

> 2026-07-22 SUB-002 完成：新增 strict SRT/LRC formatter/parser/round-trip、同目录 `0600` exclusive partial、index hard-link no-clobber、standalone overwrite atomic rename、目录对象 mutex、full/partial/none-success 与 commit 前后取消，以及 owner/task/generation/TTL/operation-bound Artifact Registry。partial stable identity 与 mutable size 分离，required cleanup failure 显式上报，hard-link detach/Registry activation 失败回滚 final 且不签发 ref。read/reveal 已接入 app-scoped IPC，并在每次操作重验目录/文件 identity、size/hash、UTF-8 与格式；`handoffArtifact` 仍由 `LINK-006` 实现。后续审计确认 path-only overwrite 不能证明父目录替换后的 victim 可恢复，因此当前 production Job Manager/Executor 只接通 index；overwrite 保留为未接线组件能力并等待目录句柄事务。聚焦 5 files / 94 tests、local-subtitle 23 passed + 2 skipped files / 431 passed + 2 skipped tests、全量 124 passed + 2 skipped files / 1383 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest/validator 与 diff gate 通过。

> 2026-07-22 MODEL-001 完成：新增 strict model manifest、abortable GGML verifier、app-scoped Session Registry/ResourceJob、managed copy/move staging、CPU no-VAD load smoke 与 fixed model IPC/main lifecycle。private roots、staging、commit、list/resolve、owner release 和 shutdown 均绑定 filesystem identity；move 删除异常保留最后一份 verified copy，quarantine rediscovery 需要本事务 creation receipt。聚焦 4 files / 50 tests、local-subtitle 29 passed + 2 skipped files / 504 passed + 2 skipped tests、全量 130 passed + 2 skipped files / 1456 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest/validator 与 diff gate 通过。`BE-002` 依赖已解除，真实 packaged model/runtime 证据仍属 `NATIVE-002`。

> 2026-07-22 BE-002 production executor slice 完成：在 Job Manager/revision/capability foundation 上接通单文件 CPU/transcribe/no-VAD/custom/SRT/export-only production executor、main/IPC wiring 与三阶段 session lifecycle。入队 commit 前执行 owner-bound bundled media runtime admission；执行期绑定 normalization、完整 structural window、windowAttempt、processEpoch、单调 request/response generation 与前后 exact file identity，完成 raw gate、精确拆窗 retry、canonical processing、required cleanup 后 SRT export。普通 cleanup failure 使用新增的 `cleanup_failed`，只有存在取消证据才使用 `cancel_failed`；前序 shutdown failure 不得短路后续 native cleanup 或 Session Registry finalize。local-subtitle 33 passed + 2 skipped files / 602 passed + 2 skipped tests、全量 134 passed + 2 skipped files / 1554 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest 0/0、validator 17/17 与 diff gate 通过；2 个 skip 均为未启用的真实 native server 测试，Vite 仅有既有 warning。该证据不是 native E2E，`BE-002` 继续为进行中。

> 2026-07-22 BE-002 multi-file checkpoint：Job Manager 已支持最多 100 文件的 custom CPU/no-VAD/SRT/export-only 原子批次、批内有序/app-global FIFO、task scope 失败隔离与 batch/session scope sibling fence；ID reservation、exact input identity 去重、共享 output lease、同步重入和 owner release/pending admission 均已闭环。capability operation/timer 按 owner 分区，慢 owner 不阻塞其他 owner 的 TTL 续租；admission 时冻结 main-only runtime generation并在 executor 复核。Supervisor 允许最后 task lease 后保留 compatible `ready/leaseCount=0` warm epoch，resident owner、same-epoch timer token、identity switch、idle fault latch 和 shutdown retry 均有回归。local-subtitle 630 passed + 2 skipped，全量 1582 passed + 2 skipped，TypeScript、三段 Vite build、manifest/validator 与 diff gate 通过。warm policy 仍不能排除 sibling 间 smoke/incompatible acquire 或超长 export 的驱逐，严格“同批模型只加载一次”留给下一段 batch pin/shared admission。

> 2026-07-22 BE-002 batch runtime pin：同一 batch、同一 queue admission 的连续 execution wave 共享 main-only opaque runtime slice；首个实际任务通过 media normalization、model/runtime revalidation 后才 lazy acquire exact-load-identity Supervisor pin。active pin 阻止 smoke、不兼容 identity 和 idle retirement，每个 task 仍独立获取/释放 pinned task lease。task cancel 或 task-scope cleanup failure 后有 queued sibling 时保留 pin；failed terminal 的 retry capability authority 不持 pin，显式 retry 使用新 admission。owner release/shutdown fence work 后幂等关闭。取消或 crash 的安全 epoch restart 仍被允许，但只能恢复 pin 绑定的相同 identity。聚焦 3 passed + 1 skipped files / 125 passed + 1 skipped tests、local-subtitle 654 passed + 2 skipped、全量 1606 passed + 2 skipped、TypeScript、三段 Vite build、PRE manifest 0/0、validator 17/17 与 diff gate 通过。canonical native staging 缺失且 2 个真实 server tests 保持 skipped，因此当前证据不是 native/packaged E2E。

> 2026-07-22 BE-002 source output parent isolation：source batch admission 同时要求 task input 的 `transcribe` 与 `derive_source_output` authority，不创建伪 batch output lease。main 在授权时冻结 canonical parent object identity，后续按 file -> parent -> file/parent 顺序逐边界重验；Executor 在 media/pin 前 fail-fast，只跨阶段持有无路径 identity proof，导出时仍重新解析且必须匹配该 proof。输入文件 identity 变化保留 `media_changed/preparing_media`，父目录 availability/identity 失败为 task-scope `output_write_failed/exporting`，TTL 失效保留 `authorization_expired/preflight`；terminal capability renewal failure 不覆盖 executor 已返回的稳定执行错误。custom/source 当前均只接通 index，overwrite 在目录句柄事务完成前 fail-before-capability。不同父目录同名文件独立提交，一个父目录失效只失败当前 task；public state/IPC 不含 token 或 raw path。聚焦 5 files / 160 passed；local-subtitle 33 passed + 2 skipped files / 681 passed + 2 skipped tests；全量 134 passed + 2 skipped files / 1633 passed + 2 skipped tests；TypeScript、三段 Vite、manifest 0/0、validator 17/17 与 diff check 通过。canonical runtime staging 因 canonical path 缺失而按合同 fail closed。

> 2026-07-22 BE-002 LRC/multi-format/partial-output：Production Job Manager/Executor 现放行 `[SRT]`、`[LRC]`、`[SRT,LRC]` 与 `[LRC,SRT]`，严格保留请求顺序；custom/source 两种 index-only 路径均可独立提交各格式。至少一个 artifact commit 即以 `completed` 结算：普通格式写失败形成无 warning partial，首格式 commit 后取消以 `cancelled_after_partial_commit` marker 形成唯一 warning。跨格式 all-failed 时 `cleanup_failed` / `cancel_failed` 高于普通 write failure，取消下逐 artifact 规范化 cleanup code；late cancel、lease renewal abort 与 Session Registry 二次校验均依据 artifact cancellation evidence，不能覆盖或清空已稳定的 committed/failed 结果。聚焦 4 files / 176 passed；local-subtitle 33 passed + 2 skipped files / 700 passed + 2 skipped tests；全量 134 passed + 2 skipped files / 1653 passed + 2 skipped tests；TypeScript、三段 Vite、manifest 0/0、validator 17/17 与 diff check 通过。canonical runtime staging 仍因 canonical path 缺失按合同 fail closed。

> 2026-07-22 FS-TXN-001 overwrite transaction checkpoint：新增 exact/deep-frozen request、不可结构伪造的 branded Coordinator 与同步 `begin/finalize/rollback` receipt；pending/resolved/rejected thenable 立即拒绝并吸收晚 rejection，terminal 同/跨方法重入被 fencing。Exporter 在任何目录解析或 partial 写入前对缺失 backend fail closed；配置 transaction 后同步执行 `begin → Registry activate → finalize`，activation 失败 rollback。当时的 finalize failure revoke + rollback 语义已由 2026-07-23 `FS-TXN-001B` 收紧：backend 真正开始后抛错必须进入同方向 pending，不得反向 terminal。该历史 checkpoint 的聚焦 3 files / 138 passed、local-subtitle 768 passed + 2 skipped、全量 1721 passed + 2 skipped、TypeScript、三段 Vite、manifest/validator 与 diff check 均通过；当前状态和最终数字以下方 001B checkpoint 为准。

> 2026-07-23 FS-TXN-001A macOS arm64 component checkpoint：新增 plain Node-API addon、strict `.node` loader、direct `xcrun clang++` build 与真实 filesystem integration。一个 retained directory fd 绑定所有 child 操作，existing/absent victim 分别走 `RENAME_SWAP`/`RENAME_EXCL`；partial 必须 single-link，rollback 通过 pinned fd 验证 unlink 后 link count 为 0。修复 post-wrap begin failure 每次泄漏 directory/partial fd，64 次 permission-denied commit 的 fd delta 为 0。native 9/9、聚焦 188、local-subtitle 818 passed + 2 skipped、全量 1771 passed + 2 skipped、TypeScript、三段 Vite、manifest/validator 通过。001A 验收时仅证明 retained-parent replacement；当时未完成的 cooperative-writer child-leaf 边界、terminal matrix 与 durable rollback recovery 已由下一条 001B 闭环，Windows、verified staging/main 与 packaged E2E 仍未完成，production gate 不变。

> 2026-07-23 FS-TXN-001B macOS arm64 developer component checkpoint 已完成：Darwin 公共 API 只有 name-based `renameatx_np/unlinkat`，没有“仅当 child leaf 仍命名期望 vnode 时替换/删除”的 compare-and-swap。威胁模型只把 FusionKit cooperative writer 和 terminal 窗口内相关 leaf 的协议独占纳入保证；非协作同目录 writer完全不在保证范围。production protocol v2 exact journal、`rollback_pending` fresh-process recovery、`finalize_pending` 同 receipt retry 与 test-only terminal/crash matrix 已完成；合法且仍存在的 open journal返回 `decision_required`。finalize-crash recovery未支持或宣称，journal unlink后的 crash可能只得到 `not_found`；同样不宣称 power-loss safety。native 11/11、聚焦 190、local-subtitle 820 passed + 2 skipped、全量 1773 passed + 2 skipped、TypeScript、三段 Vite、manifest/validator 通过。仍需 main composite owner原子接管 receipt、Registry 状态与 owner/task/generation，N-API finalizer不得充当 owner，production gate 保持关闭。

> 2026-07-23 FS-TXN-001C composite recovery owner checkpoint 已完成：native 升级为 protocol v3 / journal v2，`transactionId` 与规范 partial leaf 一一绑定，recover 只接收 `transactionId`、重新授权目录及其 exact identity。新增 branded single-claim recovery authority、path/capability/token-free file repository、directory-object mutex/fence、main/Registry composite owner 与 Exporter prepared handoff；owner release、shutdown 和 shutdown 后 late adoption 均会重试未收敛 terminal/Registry authority。`decision_required` 与 `not_found` 都保留 pending record、durable direction 和已选目录 fence，shutdown 返回 `recovery_pending`；只有 native 与 Registry authority 真正收敛后才删除 record 并释放 fence。该 prepared handoff只存在于进程内 `WeakMap/Map`，不在 native begin 前建立 durable record，因此不能宣称 atomic/durable handoff、abandoned receipt discovery 或 finalize-crash recovery。native 11/11、001C focused 7 files / 257 passed、local-subtitle 37 passed + 2 skipped files / 883 passed + 2 skipped tests、全量 138 passed + 2 skipped files / 1836 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest 0/0、validator 17/17 与 diff check 通过。production main仍未注入。
>
> 2026-07-24 FS-TXN-001D Windows x64 component checkpoint 已完成：production addon与macOS保持protocol v3/journal v2 exact surface，目录只打开一次no-follow HANDLE，child lookup/rename/link/delete全部使用RootDirectory-relative NT operations；Windows identity固定为8位volume serial + 32位FileId小写hex，不压成JS safe-number、不绑定受NTFS tunneling影响的creation time。native Node tests 6/6；production 4 terminal + 5 recovery + 6 rejection；fresh-process 3 begin crashes + 14 rollback crashes + 14 rollback error/retries + 5 finalize error/retries + 2 finalize-crash boundary cases；identity/loader focused Vitest 3 files / 147 passed，TypeScript通过。production main/gate、durable decision、Registry/authorization composition、staging/builder和packaged范围均不变。
>
> 2026-07-26 FS-TXN-001E cross-platform identity composition checkpoint 已完成：统一采集器在Windows只从bigint stats生成固定宽度volume serial/FileId，在POSIX保留safe dev/ino/birthtime；输出目录authorization、Artifact Registry exact file/directory proof、Exporter partial/overwrite activation、recovery selection与Executor directory proof均使用strict联合类型。001D的Windows Registry边界回滚已移除；定向10 files / 330 passed、TypeScript、三段Vite、manifest与validator通过。production main/gate、durable decision、staging/builder和packaged范围仍不变。

> 2026-07-27 FS-TXN-001F durable recovery decisions checkpoint 已完成：native升级为protocol v4 / journal v3并新增module/receipt acknowledgement；main在native begin前持久化schema-v2 `rollback_unpublished + not_started` path-free preclaim，Registry activation后持久化`finalize_committed`。finalize decision写盘只允许首次加一次同payload retry；两次失败保留receipt/Registry/fence且不进入native finalize。native terminal marker保留到main持久化`settled`后才ack；持久化不确定、pending `not_found`与begin已开始后的adoption failure都继续保留record/fence。native finalizer对`.open`保持方向中立，abandoned-open existing/absent × finalize/rollback矩阵已覆盖。macOS native 11/11、Windows contract 6 passed + 真实Windows 1 skipped、local-subtitle 38 passed + 2 skipped files / 914 passed + 2 skipped tests、全量139 passed + 2 skipped files / 1867 passed + 2 skipped tests、TypeScript、三段Vite、manifest 0/0与validator 17/17通过。production main/IPC/UI、verified staging/builder、真实Windows与packaged范围仍不变。

---

## 0. 结论先行

FusionKit 应新增一个独立的“本地字幕转写”工具，而不是扩展、切换或复用现有远端 API `AudioTranscriber` 的任务合同。

最终建议如下：

1. 新工具归入“字幕”分类，建议路由为 `/tools/subtitle/local-transcriber`，名称为“本地字幕转写”。
2. 现有 `/tools/audio/transcriber` 保持原样，继续承担 OpenAI/MiMo 等外部 API 的通用音频转文本；不得向其中加入本地模型、设备、GPU、批处理字幕或模型下载逻辑。
3. 新工具拥有独立页面、Store、类型、preload bridge、IPC 命名空间、任务队列、模型管理器、本地运行时和导出器。两者只复用无业务语义的基础设施与实现经验，例如工具页布局、文件授权模式、输出目录授权模式、按钮组和错误展示组件。
4. 首版统一推理后端推荐 `whisper.cpp`，而不是把 Python `faster-whisper` 直接嵌入 FusionKit：
   - Windows x64 可使用 NVIDIA CUDA，并保留 CPU fallback。
   - macOS 仅发布 arm64 runner，优先使用 Metal；同一 arm64 产物保留可见、可确认的 CPU fallback。macOS x64 直接返回 `unsupported_architecture`。
   - 首发内置清单只包含跨平台真实验证过的 `large-v3-q5_0`；未量化 `large-v3` 与 turbo 变体在取得精确 hash、跨平台质量/性能证据后再加入。VAD 使用映射回原媒体的段级时间戳，首版不开放 VAD 逐词时间戳。
5. 不把上游 `whisper-cli` 的控制台文本当作正式协议。首版由 Electron main/Node 管理固定版本的官方 `whisper-server`，通过私有 loopback HTTP 和 `verbose_json` 获取结构化结果；只有该 API 经真实验收仍缺少必要能力时，才重新评估 native bridge。
6. 长媒体不以一个整段 decoder 请求直接产出字幕。规范化 PCM 按约 30 秒有界窗口和小幅 overlap 独立推理，server/model 进程继续驻留；raw segment 先通过时间轴、连续重复、窗口覆盖和媒体边界门禁，再按绝对整数毫秒合并。不得用删除重复行代替重试，因为锁死期间未识别的语音无法从结果中恢复。
7. 首版核心产物是标准 SRT 和标准行级 LRC；VTT、TXT、详细 JSON 可作为扩展导出。增强型逐词 LRC 单独标记，不直接送入现有字幕翻译器。
8. 转写完成后既可只导出 SRT/LRC，也可选择自动加入字幕翻译任务列表，并进一步选择是否自动开始翻译。交接必须通过会话级 `artifactRef`、一次性 `translationImportToken` 和字幕翻译模块自有的导入协调器完成；本地转写工具不得直接读写字幕翻译器 Store。自动执行默认关闭，只有用户显式选择“自动加入并开始翻译”时才允许产生外部 API 费用。
9. 模型不放进安装包。模型、VAD 模型和可选 Windows 加速包按需下载到 `app.getPath("userData")` 下，支持断点续传、校验、删除和导入本地模型；平台 runner 与 PRE-006 已冻结来源/构建方式的 FFmpeg/ffprobe 则作为安装包内、asar 外的受控资源发布。
10. `faster-whisper-GUI-main` 只保留为历史调研背景，不复制代码，也不作为运行时、模型格式、参数或验收基线。FusionKit 按自己的产品目标和 whisper.cpp 公开接口独立实现。

## 1. 背景、目标与边界

### 1.1 现有工作流

当前“烤肉”流程是：

```text
音频/视频
  → 在 faster-whisper-GUI-main 中使用本地 GPU 转写
  → 导出 SRT/LRC
  → 打开 FusionKit 字幕文件翻译
  → 添加字幕文件并生成双语字幕
```

能力已经能串起来，但模型管理、批处理、任务状态、文件选择和结果交接分散在两个桌面软件中，Windows 与 macOS 的体验也不一致。

### 1.2 目标

1. 在 FusionKit 内选择多个本地音频/视频文件，使用本地 Whisper 模型批量转写。
2. Windows x64 优先使用 NVIDIA GPU并保留 CPU fallback；macOS arm64 优先使用 Metal，并在同一架构内保留 CPU fallback。
3. 首发支持 Whisper `large-v3-q5_0`；未量化 `large-v3` 与 turbo 变体只有进入版本化内置清单并通过跨平台验收后才显示。
4. 生成带稳定时间轴的 SRT/LRC，可直接进入 FusionKit 字幕翻译。
5. 支持语言自动检测、初始提示词、VAD、稳定段级时间戳、字幕整形、取消和逐文件失败隔离；首版固定 `segment_only_v1`，VAD/非 VAD 均不请求或消费逐词时间戳。逐词时间戳只能由未来版本化 runtime capability 在取得原时间轴 provenance 后启用。
6. 模型只下载一次；同一批任务复用已加载模型，避免每个文件重复装载约 1.08 GB 的首发模型。
7. 本地媒体内容、模型路径、真实文件路径和转写中间数据不进入 renderer 持久化或普通日志。
8. 让未来增加 Windows `faster-whisper`、Apple MLX 或其他本地引擎成为可控扩展，而不是重写页面和任务合同。
9. 支持把转写、字幕导出、字幕翻译排成可选的连续流水线，同时保证任一翻译交接或执行失败不影响已经成功导出的字幕产物。

### 1.3 非目标

1. 不改造现有外部 API 音频转文本工具。
2. 首版不做实时麦克风字幕；现有实时字幕工具有独立产品定位。
3. 首版不做 WhisperX 强制对齐、说话人聚类、Demucs 人声分离或完整字幕时间轴编辑器。
4. 首版不支持任务在单个文件中间断点续跑；应用重启后可保留已完成产物，但未完成文件从头开始。
5. 首版不默认自动启动字幕翻译；只有用户在本地转写批次中显式启用“自动加入并开始翻译”后，才可按字幕翻译工具的配置调用外部模型 API。
6. 不承诺所有 Windows AMD/Intel GPU 在首版都获得稳定加速；首版保证 CPU fallback，Vulkan 可作为后续加速包。
7. 首版发布矩阵仅包含 Windows x64 与 macOS arm64；不支持 Linux、Windows arm64、macOS x64 或其他平台/架构。探测到矩阵外环境时返回稳定的 `unsupported_platform` / `unsupported_architecture`，不能尝试加载相近架构资源或通过 Rosetta 兜底。

## 2. 与现有远端 ASR 的强制隔离边界

现有 `src/pages/Tools/Audio/AudioTranscriber/index.tsx` 是外部 API 工具：它从独立音频 API 配置中解析 provider route，通过 `src/services/audio/audioTranscriptionService.ts` 和 `electron/main/audio/ipc.ts` 调用 OpenAI/MiMo adapter。它的输入大小、响应格式、stream、timestamp 字段均受远端 route 约束。

本地字幕转写的架构不同：需要原生可执行文件、GPU 后端探测、模型下载、媒体转码、长任务队列、模型驻留、字幕整形与本地产物管理。把两者合并会让 provider route、模型 route、字段显隐、Store 迁移、IPC 安全和取消逻辑互相污染。

### 2.1 必须独立的模块

| 层级 | 新工具建议 | 明确不得复用为同一合同的现有模块 |
| --- | --- | --- |
| Route | `/tools/subtitle/local-transcriber` | `/tools/audio/transcriber` |
| Tool key | `localSubtitleTranscriber` | `audioTranscriber` |
| Renderer page | `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/` | `src/pages/Tools/Audio/AudioTranscriber/` |
| Store key | `fusionkit-local-subtitle-transcriber` | `fusionkit-audio-transcriber` |
| Types | `src/type/localSubtitle.ts`、`localSubtitleIpc.ts` | `src/type/audio.ts`、`audioIpc.ts` |
| Preload API | `window.localSubtitleApi` | `window.audioApi` |
| IPC prefix | `local-subtitle:*` | `audio:*` |
| Main runtime | `electron/main/local-subtitle/*` | `electron/main/audio/*` |
| 配置 | 本地引擎/模型/设备/字幕偏好 | Audio API profile/assignment/provider route |
| 输出 | SRT/LRC 字幕产物 | API 原始 text/json/srt/vtt 响应 |

### 2.2 可以复用的内容

- `ToolDetailLayout`、`ToolConfigPanel`、`ToolField`、`ToolFileDropZone`、`ToolRadioButtonGroup` 等现有通用 UI；目录选择器只复用 `ToolOutputPathPicker` 的视觉壳，授权行为仍由新工具自己的 fixed preload API 提供。
- sender-bound 文件 token、输出目录 token、过期与撤销重试的设计经验。
- 不经 renderer 传递真实路径的安全原则。
- i18n、错误卡片、toast、Electron 视觉验收和前端服务清理规范。
- 字幕翻译器已有的 `OutputConflictPolicy`、源目录/自定义目录产品概念，但新工具保留自己的类型和 Store。

复用必须通过提取真正通用的小模块完成，不能让本地字幕任务调用 `AudioIpcService.transcribe()`，也不能让本地模型伪装成一个 audio provider preset。

## 3. FusionKit 当前可对接状态

### 3.1 字幕翻译器

当前 `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`：

- 支持同时添加多个文件。
- UI 当前接受 `.lrc,.srt`。
- 支持源目录或自定义输出目录。
- 支持双语/仅译文、语言选择、任务队列、失败恢复和冲突策略。

字幕翻译任务在加入队列时会固化任务执行模型、源/目标语言、双语/仅译文、切片策略、输出目录、冲突策略和分片并发等字段。当前这些“当前配置”分散在 `useSubtitleTranslatorStore`、`useModelStore`、页面局部 state 和若干 `subtitle-translator-*` localStorage key 中；要支持转写页在字幕翻译页未挂载时自动入队，`LINK-001` 必须先把安全的字幕翻译偏好收敛到字幕翻译模块自有的配置 Store/读取服务，再由导入协调器一次性取快照。本地转写模块不能直接读取这些 Store 或 localStorage key。

因此新工具的最小交付格式必须是 SRT 和标准 LRC。虽然 `SubtitleFileType` 还包含 VTT，但当前字幕翻译入口没有接收 VTT，不能把“能导出 VTT”描述成“已打通翻译”。

### 3.2 Electron 文件安全基础

音频工具已实现：

- preload 使用 `webUtils.getPathForFile()` 获取用户真实选择的路径。
- main 发放 sender-bound 输入文件 token 与输出目录 token。
- renderer 只持有受限 token，不把路径拼进任意 IPC 请求。
- generic invoke 使用精确 public allowlist，preload-only 内部 channel 留在私有闭包。

本地字幕工具应复制这套安全模式的原则和测试，不共享 audio token registry。新工具的 token TTL、批量文件数量、媒体格式和任务生命周期不同，应由 `LocalSubtitleFileAuthorizations` 独立管理。

### 3.3 打包现状

当前正式 `electron-builder.json` 仍只打包 `dist-electron` 和 `dist`，尚未接入 production native sidecar/FFmpeg；但产物名已加入 `${arch}`。PRE-005 的 ignored builder spike 已验证 `extraResources`、可执行权限、macOS 嵌套/外层签名顺序、Windows explicit unsigned integrity profile 和 build-time 缺件门禁，PRE-006 已冻结跨平台 acquisition/staging 合同。正式接线由 `CORE-002` / `NATIVE-002` 从版本化 staging 输入实现，不能把本机 spike 或开发目录中的二进制直接当作发布配置。

`electron/main/index.ts` 已调用 `app.requestSingleInstanceLock()`，因此不同 Electron 进程不应同时修改同一 `userData`；但同一 app 进程仍可存在多个 `BrowserWindow/webContents`。Model/ResourceJob/Runner managers 应为 app 级单例并对模型、下载和 GPU 队列加全局锁，task/capability/event 则继续绑定各自 owner session。不能用“应用单实例”替代跨 webContents owner 校验。

## 4. 参考项目审计

### 4.1 技术栈与状态

本地快照的主要依赖为：

- PySide6 GUI。
- `faster-whisper==0.10.0`。
- `CTranslate2>=3.21.0`。
- `torch==1.13.1+cu117`、`torchaudio==0.13.1+cu117`。
- PyAV、FFmpeg Python wrapper、PyAudio、webvtt。
- 内置一份 WhisperX 代码，并接入时间戳对齐和说话人分离。

这套版本明显偏旧，而且 CUDA 11.7、旧 Torch、旧 CTranslate2 与当前上游要求已经存在代际差异，不适合作为 FusionKit 新功能的依赖锁定基线。

### 4.2 核心数据流

```text
LoadModelWorker
  → WhisperModel(model path, device, compute type, workers)
  → TranscribeWorker
      → ThreadPoolExecutor 遍历文件
      → model.transcribe(...)
      → segment_Transcribe 保存段/词时间戳
      → 临时 SRT
  → 可选 WhisperX 对齐/说话人分离
  → OutputWorker
      → SRT/LRC/VTT/TXT/ASS/SMI/JSON
```

关键文件：

- `faster_whisper_GUI/modelLoad.py`：模型路径、device、device index、compute type、CPU threads、workers。
- `faster_whisper_GUI/transcribe.py`：批处理、转写参数、取消标志、格式导出。
- `faster_whisper_GUI/seg_ment.py`：段与词时间戳中间模型。
- `faster_whisper_GUI/whisper_x.py`：WhisperX 对齐与说话人分离。
- `whisperx/SubtitlesProcessor.py`：基于词时间戳和标点的字幕切分。
- `fasterWhisperGUIConfig.json`：模型、VAD、转写和输出偏好。

### 4.3 值得保留的产品能力

1. 批量添加媒体文件，模型只加载一次。
2. 默认单 worker，明确提示单 GPU 增加线程通常不会提高吞吐，反而增加显存占用。
3. 支持语言自动检测、transcribe/translate、beam、temperature fallback、初始提示词、VAD、词时间戳和幻觉静音阈值。
4. 输出 SRT/LRC/VTT/TXT/ASS/SMI/JSON。
5. LRC/VTT 可携带逐词时间戳，适合卡拉 OK/歌词场景。
6. 转写后保留统一 segment/word 中间数据，输出器不需要重复推理。
7. 可选的字幕切分、时间戳编辑、对齐和说话人信息为后续版本提供了产品方向。

### 4.4 不应照搬的实现

1. **取消不可靠**：`TranscribeWorker.stop()` 只设置布尔标志；已经提交到线程池和底层 CUDA 的工作不一定立即停止，也没有强制释放模型/子进程的边界。
2. **错误隔离弱**：线程池 map、控制台输出和 UI 状态混在一起，单文件失败、批次失败和取消没有稳定错误码。
3. **中间结果主要驻留内存**：大量长媒体会持续持有 segment/word 对象，没有明确的内存水位与按文件提交策略。
4. **输出非原子**：直接写最终文件，没有 `.partial`、冲突策略、写后校验和崩溃清理合同。
5. **时间格式实现存在边界风险**：`secondsToHMS()` 四位小数取整后没有统一截断到毫秒，可能生成不规范的 SRT 时间文本；新实现必须用整数毫秒作为唯一事实来源。
6. **参数墙过重**：几乎所有底层参数都直接暴露，普通用户很难知道哪些参数共同生效。FusionKit 应提供少量预设和折叠的高级设置。
7. **模型兼容补丁过时**：加载 large-v3 后手动修改 mel filter，属于旧版本兼容逻辑，不能迁移到新后端。
8. **凭据风险**：参考项目配置文件中存在明文保存外部访问 token 的行为。本文不记录其值；FusionKit 不得复制这种做法。
9. **许可证风险**：参考项目根许可证是 AGPL-3.0。应只参考可观察行为和公开参数，独立实现代码与测试。

## 5. 上游技术路线比较

调研日期为 2026-07-16。实现时仍需固定并复核具体 commit、二进制和模型哈希。

| 方案 | Windows NVIDIA | macOS Apple Silicon GPU | 依赖/打包 | 时间戳/VAD | 结论 |
| --- | --- | --- | --- | --- | --- |
| Python `faster-whisper` | 强，CUDA/CTranslate2 | CTranslate2 仅 CPU；无 MPS/Metal 推理 | Python、PyAV、CTranslate2、CUDA/cuBLAS/cuDNN | 支持词时间戳、Silero VAD、batch | 不适合作为跨平台唯一引擎；可做后续 Windows 插件 |
| `whisper.cpp` | CUDA；也有 Vulkan/CPU | Metal，Core ML 可选 | 原生 C/C++，可构建独立 sidecar | C API 有 progress/abort/segment callback，内置 Silero VAD | 推荐首版统一引擎 |
| `mlx-whisper` | 不支持 | 强，Apple MLX | Python、MLX、模型格式、FFmpeg | 支持词时间戳 | 可做未来 macOS 专用高性能引擎，不作为首版唯一实现 |
| 原版 PyTorch Whisper | CUDA | MPS 可用性和稳定性需逐版本验证 | Python/Torch 体积最大 | 功能完整 | 不符合轻量 sidecar 与跨平台维护目标 |

### 5.1 为什么不直接使用 faster-whisper

当前 `faster-whisper` 上游本身是 MIT，能力也成熟：官方示例支持 `large-v3`、batched pipeline、词时间戳和 Silero VAD。但其 GPU 路径要求 NVIDIA CUDA/cuBLAS/cuDNN；CTranslate2 官方硬件文档的 GPU 列表仍是 NVIDIA GPU。它可以在 ARM64 CPU 上运行，却不能满足“macOS 使用本地 GPU”的核心目标。

此外，当前上游要求与参考 GUI 的旧依赖不同：`faster-whisper` 当前 README 要求 Python 3.9+，GPU 路线围绕 CUDA 12、cuBLAS 和 cuDNN 9。把完整 Python 环境、CUDA 动态库和 PyAV 塞进 Electron，会显著增加包体、安装失败面和安全更新成本。

官方资料：

- [`faster-whisper` README](https://github.com/SYSTRAN/faster-whisper)
- [CTranslate2 hardware support](https://opennmt.net/CTranslate2/hardware_support.html)
- [`faster-whisper` releases](https://github.com/SYSTRAN/faster-whisper/releases)

### 5.2 为什么推荐 whisper.cpp

`whisper.cpp` 官方 README 明确列出 Windows、macOS、CPU、NVIDIA GPU、Vulkan，以及 Apple Silicon 的 Metal/Core ML 优化。FusionKit 的首发子集只取 Windows x64 与 macOS arm64。它的 C API 提供 progress callback、new segment callback 和 abort callback；官方 `whisper-server` 已封装模型驻留、结构化结果和基于连接断开的 abort，因此首版不需要 FusionKit 再写一层 C++。

当前上游还提供：

- Silero VAD 与可配置阈值、最短语音、最短静音、最大语音段和 padding。
- SRT、LRC、VTT、TXT、CSV、JSON 等输出参考实现。
- `large-v3`、`large-v3-q5_0`、`large-v3-turbo` 等 GGML 模型。
- MIT 许可证。

官方模型表给出的典型资源量：

| 模型 | 磁盘 | 官方 README 的典型内存说明 | 产品建议 |
| --- | ---: | ---: | --- |
| `large-v3` | 2.9 GiB | large 系列约 3.9 GB | 延后；缺精确 artifact hash 与跨平台产品证据 |
| `large-v3-q5_0` | 1.1 GiB | PRE 实测 Windows/macOS 均可用 | PRE-006 首发默认，明确标注量化取舍 |
| `large-v3-turbo` | 1.5 GiB | 需实测 | 延后；进入清单前补质量/性能证据 |
| `large-v3-turbo-q5_0` | 547 MiB | 需实测 | 延后；进入清单前补质量/性能证据 |

官方资料：

- [`whisper.cpp` README](https://github.com/ggml-org/whisper.cpp)
- [`whisper.cpp` model list](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [`whisper.cpp` CLI output implementation](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp)
- [`whisper.h` callbacks and VAD API](https://github.com/ggml-org/whisper.cpp/blob/master/include/whisper.h)
- [`whisper.cpp` MIT license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE)
- [OpenAI Whisper repository and model license](https://github.com/openai/whisper)

### 5.3 首版不用一次性 whisper-cli，改用官方 persistent server

PoC 可以用 `whisper-cli` 验证模型、GPU和输出，但正式产品不应以每文件一次 CLI 作为批处理运行时：

Windows PRE-001 的 stock CLI smoke 与 PRE-002 的 server PoC 固定使用 `whisper.cpp v1.9.1`
官方 x64 预编译资产并校验 filename/size/SHA-256。该路径不要求本机 CMake、
MSVC 或 `nvcc`。只有目标 artifact 确实需要源码构建/补丁时，构建机或 CI 才需要
对应工具链；它们不得成为最终用户或当前 Windows PoC 前置。

- 控制台文案和 stderr 格式不是稳定协议。
- CLI 每个进程通常重新加载模型，不适合批处理复用 `large-v3`。
- 取消、错误分类、增量 segment、日志脱敏和协议兼容难以稳定测试。
- 上游 CLI 的直接 LRC/SRT 输出不包含 FusionKit 自己的字幕整形与产物交接语义。

官方预编译包同时包含 `whisper-server`。PRE-002 已验证它会启动时加载模型、跨请求复用 context、通过 `/health` 和 `/inference` 返回机器可读 JSON，并在客户端断开时触发 abort callback。因此首版由 Node 监管该官方进程；字幕整形与文件导出仍由 TypeScript 独立完成。PRE-006 已接受 v1 阶段式进度，不解析控制台日志伪造百分比，也不为没有真实硬需求的增量流新增 native bridge。

## 6. 最终架构

```text
Renderer
  LocalSubtitleTranscriber page
  local store / queue view / model manager view
        |
        | fixed preload methods + sender-bound tokens
        v
Preload: window.localSubtitleApi
        |
        v
Electron main: electron/main/local-subtitle/
  LocalSubtitleIpcService
  LocalSubtitleJobManager
  LocalSubtitleProductionExecutor
  LocalSubtitleSessionLifecycle
  LocalSubtitleFileAuthorizations
  LocalSubtitleModelManager
  MediaNormalizer (FFmpeg)
  LocalSubtitleServerSupervisor
  SubtitlePostProcessor
  SrtExporter / LrcExporter / JsonExporter
  SubtitleArtifactRegistry
        |
        | private loopback HTTP + random request path
        v
official whisper-server
  pinned whisper.cpp release
  CPU / CUDA / Metal backend
  persistent model context
        |
        v
userData/local-subtitle/
  models/ accelerators/ jobs/ temp/ manifests/
```

### 6.1 模块职责

| 模块 | 职责 |
| --- | --- |
| Page | 配置、批量添加、队列、进度、结果预览和产物操作 |
| Renderer Store | 只持久化无敏感偏好；当前任务、token、路径和 segment 不持久化 |
| Renderer Runtime Service | 在页面组件之外维护事件订阅、revision reducer、会话快照重同步和 capability cleanup retry；SPA 路由切换不能丢失已提交任务状态 |
| IPC Service | 验证请求、owner、token、状态迁移与错误白名单 |
| Job Manager | 串行 GPU 队列、逐文件失败隔离、取消、重试和应用退出清理 |
| Production Executor | 在 main 内绑定 MEDIA PCM/window proof、Supervisor epoch/request、SUB raw gate/retry/canonical processing 与 exporter；只有 required cleanup 成功后才开始导出 |
| Session Lifecycle | owner release 时先 fence Job、最后释放 Session Registry；app shutdown 按 Job+Model、Media+Supervisor、Registry 三阶段执行且不因首错跳过后续清理 |
| Model Manager | 下载、续传、哈希校验、导入、删除、兼容性与占用状态 |
| Media Normalizer | 用 FFmpeg/ffprobe 把音频或视频规范为 16 kHz mono PCM16 WAV |
| Server Supervisor | 启停官方 server、health 探活、模型驻留、AbortController 取消、超时和崩溃恢复 |
| Post Processor | v1 把引擎 segment 转换为稳定 cue，处理标点、长度、最短时长和重叠；未来 word timeline 必须先升级版本化 server capability |
| Exporters | 从同一 canonical transcript 原子输出 SRT/LRC/JSON |
| Artifact Registry | 发放输出 token、打开目录、交给字幕翻译器 |
| Subtitle Translation Import Coordinator | 由字幕翻译模块拥有；获取当前翻译配置快照、消费一次性 import token、精确入队并按选项只启动本次导入任务 |

### 6.2 引擎适配边界

main 内部保留一个小而稳定的接口，但首版只实现 `whisper_cpp`：

```ts
interface LocalSubtitleEngineAdapter {
  probe(): Promise<LocalSubtitleEngineProbe>;
  loadModel(model: LocalSubtitleModelRef): Promise<void>;
  transcribe(
    input: NormalizedMediaInput,
    options: LocalSubtitleInferenceOptions,
    events: LocalSubtitleEngineEventSink,
    signal: AbortSignal,
  ): Promise<LocalSubtitleTranscript>;
  unloadModel(): Promise<void>;
  shutdown(): Promise<void>;
}
```

该接口不进入 renderer，不在首版 UI 提供“随意切引擎”。它的作用是防止以后增加 Windows faster-whisper/Apple MLX 时重写任务、字幕和页面合同。

## 7. 用户交互设计

### 7.1 首次进入

页面先完成本地环境探测：

1. runner 是否存在、签名/版本/协议是否匹配。
2. 当前平台和架构。
3. 可用 backend：CUDA、Metal、CPU；Vulkan 如未发布则不显示。
4. 已安装模型、模型校验状态和磁盘占用。
5. 随应用打包的 FFmpeg/ffprobe 是否完整、架构匹配、哈希正确且可启动。

状态必须是可执行探测的结果，不展示无法更新的“未验证”徽标。

无模型时显示明确 CTA：

- 下载推荐的 `large-v3-q5_0`（约 1.08 GB）。
- 只有当前发布 manifest 已收录其他型号时才显示对应下载项。
- 导入本地 GGML 模型。

参考 GUI 使用的 CTranslate2 模型目录不能直接作为 whisper.cpp GGML 模型使用，UI 必须说明格式不同，不能让用户选择后才得到模糊加载失败。

### 7.2 主工作区

建议双栏结构：

- 左侧配置：模型、设备、语言、质量预设、VAD、输出格式、输出目录。
- 右侧工作区：批量拖拽、任务队列、当前进度、识别片段预览和结果操作。

布局直接使用现有 `ToolDetailLayout`：`lg` 以上为 320px 配置栏 + `minmax(0,1fr)` 工作区，窄窗口为单列且配置在前、工作区在后。不得复制一套本地 grid/CSS；786×540 验收需分别覆盖首屏配置和滚动后的任务区，并检查主 ScrollArea 而不是假设 document 在滚动。

核心字段：

| 字段 | 默认/规则 |
| --- | --- |
| 模型 | 已安装的 `large-v3-q5_0` 优先；这是 PRE-006 首发默认，UI 明确说明它是量化模型 |
| 设备 | `auto`；展示实际解析为 CUDA/Metal/CPU |
| 语言 | `auto`，允许显式指定 |
| 任务 | `transcribe`；“翻译为英语”放高级区，避免与 FusionKit 字幕翻译混淆 |
| 质量预设 | `字幕质量优先`、`平衡`、`快速`；具体底层值由 PoC 固化 |
| VAD | 默认开启固定的 Silero v6.2.0 GGML 资源；阈值继续由质量预设控制 |
| 词时间戳 | v1.9.1 的 VAD/非 VAD 请求均固定关闭；标准 SRT/LRC 只使用 segment 时间。首版不显示逐词时间戳开关 |
| 输出格式 | SRT 默认；可多选 LRC |
| 输出目录 | 源文件目录或自定义目录 |
| 冲突策略 | 默认自动加序号，避免覆盖已有人工字幕 |
| 翻译衔接 | 默认“仅导出”；可选“自动加入翻译队列”或“自动加入并开始翻译” |
| 送翻译格式 | 只生成一种标准字幕时使用该格式；同时生成 SRT/LRC 时默认 SRT，可改为标准 LRC |

高级区只暴露有稳定产品意义的参数：初始提示词、beam size、temperature、VAD 最短静音、最大 cue 长度和每行最大字符。v1.9.1 的 VAD/非 VAD 模式均不暴露词时间戳开关；未来只有新的 runtime capability 取得独立原时间轴证据并进入版本化合同后才显示。其余参数保留在内部预设，不复制参考 GUI 的全量参数墙。

### 7.3 批量队列

- 一次可添加多个音频/视频。
- 去重键使用本次授权的文件 identity，不只比较文件名。
- 默认 GPU 并发为 1；模型仅加载一次，文件串行执行。
- 每个任务展示：文件名、时长、状态、阶段、百分比、已用时间、实际 backend、输出格式和错误摘要。
- 一个文件失败不阻断后续文件，除非是 runner、模型损坏、磁盘不足等批次级错误。
- 支持取消当前文件、移除等待任务、重试失败任务、清理已完成任务。

#### 7.3.1 本地批次配置快照

点击“开始批次”时必须同时冻结成员列表和独立的 `LocalSubtitleBatchConfigSnapshot`：managed `modelId` + manifest/hash、device preference、语言、质量预设展开值、VAD/segment-only timeline policy/整形参数、输出格式、输出模式、冲突策略、`handoffFormat` 和 post-action mode。等待任务全部引用该不可变 snapshot；页面中途改模型、语言或预设只影响下一个批次，不能让同批文件悄悄使用不同参数。首版运行中新增的文件进入新的 draft batch，不加入 active batch；移除等待任务只做取消/释放，不改变其余成员的 snapshot。

`custom` 本地输出目录在 main 派生 batch-scoped write lease，和翻译目录 lease 分 registry、分权限、分生命周期；仅在同 owner/document session、批次 active 时有界续期。`source` 输出模式不伪造一个全局 lease，而是在每个文件开始前从其 authorized file identity 私下派生父目录写入目标并做权限/containment 检查；某一父目录不可写只失败该文件并给“选择自定义目录”CTA，不影响其他目录的文件。模型删除/替换、custom lease 过期或 snapshot 对应 manifest 改变属于批次级阻塞，停止启动新的等待项并给出重选/重新校验 CTA，不能切到其他模型或目录继续。失败任务默认按原 snapshot 重试；用户若要采用当前新配置，必须显式“用当前配置新建任务”，产生新 task generation。

#### 7.3.2 路由、会话与授权所有权

- SPA 路由离开本工具页不取消已经 commit 的批次。Job Manager、事件订阅和 cleanup retry 属于会话级 service，不由页面组件的 mount/unmount 决定；返回页面时必须先订阅事件，再读取带单调 `revision` 的 main 会话快照，reducer 丢弃重复/旧 revision，补齐离页期间的状态变化。
- draft 阶段的 input/output capability 由 renderer draft 持有。批次 commit 时，main 在同一事务内重新校验 identity/TTL，并把所需权限原子转移为绑定 `batchId`/`taskId` 的 task lease；commit 成功后 renderer 只保留展示摘要，不能再撤销 active task lease。
- 页面卸载只把仍属于 draft 的 capability 放进 renderer 级 pending-revocation queue；已转移 task lease 由 main 在任务终态、删除、owner session 结束或 TTL 到期时释放。revoke 的 Promise rejection、`ok:false` 与幂等 `revoked:false` 必须分别处理。
- renderer reload、主框架导航、窗口销毁、render process crash、应用退出或更新会使 `ownerSessionId` 失效，并取消该 owner 尚未终态的本地任务；首版不跨 reload 继续推理。已原子提交的字幕仍保留，重启后只恢复脱敏诊断摘要。
- 会话快照与事件都必须包含 `batchId`、`taskId`、`generation` 和 `revision`。页面不得仅依赖“刚好没漏”的增量事件推导权威状态。

### 7.4 完成操作

每个完成任务提供：

1. 在文件夹中显示。
2. 预览字幕。
3. 复制纯文本。
4. 一键送入字幕翻译。

批次配置区提供两个有依赖关系的开关：

1. `转写完成后自动加入字幕翻译任务列表`：默认关闭。开启后，每个文件的目标字幕产物导出成功即自动交接，无需等待整批转写结束。
2. `加入后自动开始翻译`：默认关闭，且只有第一个开关开启时才可用。开启时必须显示当前字幕翻译配置摘要和“将调用外部模型 API、可能产生费用”的明确提示。

组合后的产品语义只有三种，不允许出现“未加入但自动开始”的无效状态：

| 模式 | 导出字幕文件 | 加入字幕翻译列表 | 自动执行翻译 |
| --- | --- | --- | --- |
| `export_only`（默认） | 是 | 否 | 否 |
| `enqueue_translation` | 是 | 是 | 否 |
| `enqueue_and_start_translation` | 是 | 是 | 是，仅启动本次成功导入的任务 |

完成卡片中的“一键送入字幕翻译”继续保留，供 `export_only` 后手动补交，或自动交接失败后重试。每个文件每次交接只允许选择一个 `handoffFormat`，且必须属于本批启用的标准输出格式；若同时生成 SRT 和 LRC，默认推荐 SRT，并允许用户改选标准 LRC，增强型逐词 LRC 不得自动交接。多格式部分成功时只看所选格式：所选格式原子提交成功即可交接，所选格式失败则不拿另一个格式静默替代，并在完成卡提示用户改选后手动重试。

## 8. 状态与数据合同

### 8.1 任务状态

```ts
type LocalSubtitleTaskStatus =
  | "queued"
  | "preparing_media"
  | "loading_model"
  | "transcribing"
  | "post_processing"
  | "exporting"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";
```

`completed` 只表示本地流水线已经终止且至少一个用户请求的标准产物完成原子提交；它不等于“所有格式都成功”。多格式结果必须另用结构化完成合同表达，不能靠错误文案或新增一个未进入状态机的“部分完成”字符串猜测：

```ts
type LocalSubtitleArtifactStatus = "committed" | "failed" | "skipped";

interface LocalSubtitleArtifactResult {
  format: "SRT" | "LRC";
  status: LocalSubtitleArtifactStatus;
  artifact?: GeneratedSubtitleArtifactSummary;
  errorCode?: LocalSubtitleErrorCode;
}

interface LocalSubtitleCompletionResult {
  outcome: "full" | "partial";
  artifacts: LocalSubtitleArtifactResult[];
  warnings: LocalSubtitleWarningCode[];
}

type LocalSubtitleWarningCode = "cancelled_after_partial_commit";
```

允许的核心迁移：

```text
queued
  → preparing_media
  → loading_model（模型已驻留时跳过）
  → transcribing
  → post_processing
  → exporting
  → completed

任意运行阶段 → cancelling → cancelled
exporting 且已有 commit → cancelling → completed（全部格式已提交为 full，否则 partial）
取消清理失败且尚无 commit → cancelling → failed（cancel_failed）
首个 artifact commit 前任意阶段 → failed
exporting 且已有 commit 后发生错误 → completed（partial）
```

终态判定固定为：全部请求格式提交成功则 `completed + full`；至少一个成功、至少一个失败或被取消跳过则 `completed + partial`；没有任何请求格式成功才是 `failed`。普通格式写失败形成的 partial 不添加 warning。取消在第一个 artifact commit 前生效时进入 `cancelled`；一旦已有 artifact 原子提交，后续取消不得删除它。若取消被观察时全部请求格式已经提交，结果保持 `completed + full` 且不添加取消 warning；否则当前原子写完成后跳过尚未开始的格式，并以 `completed + partial` 加 `cancelled_after_partial_commit` warning 结束。Job Manager、Session Registry 与 IPC schema 必须根据 artifact 中的 `cancelled_after_partial_commit` / `cancel_failed` 证据区分取消 partial，不能仅凭晚到的 `cancelling` 状态或 lease abort 改写已经稳定的普通 partial/full；翻译交接只能选择 `status = "committed"` 的标准 SRT/LRC。

warning 有两层且首版不得混用：shared/public `LocalSubtitleCompletionResult.warnings` v1 只有 `cancelled_after_partial_commit`；SUB-001 的 `timeline_boundary_clamped` 与 `estimated_timing_used` 只属于 main-only `LocalSubtitlePostProcessingWarning` / processing report，用于诊断、统计和后续导出决策，不进入 renderer completion result。若未来确需公开 processing warning，必须升级并评审 CORE shared contract、schema 和 UI 语义，不能由 `SUB-002` 临时把 main-only code 塞进 v1 completion payload。

任务阶段和百分比分开表示，不能把 FFmpeg 30% 与 Whisper 30% 当作同一进度。建议总进度权重仅用于 UI：媒体准备 0–10%、模型装载 10–20%、转写 20–90%、后处理与导出 90–100%。实际事件同时携带 `stage` 和 `stageProgress`，并使用可重同步的事件 envelope：

```ts
interface LocalSubtitleTaskEventEnvelope {
  batchId: string;
  taskId: string;
  generation: number;
  revision: number;
  event: LocalSubtitleTaskEvent;
}

interface LocalSubtitleSessionSnapshot {
  revision: number;
  batches: LocalSubtitleBatchSummary[];
  resourceJobs: ResourceJobSummary[];
}
```

同一 owner session 的 task/resource channel 共用一个单调 `revision`。renderer runtime service 先注册全部 listener，再读取 snapshot，并在页面组件之外保持 singleton；重复、倒序或旧 generation 事件不得覆盖新状态。订阅与快照之间的缓冲事件除 payload 外还必须保留 identity、generation、首次观测 revision 和 removal revision：只有 snapshot revision 已覆盖该观测且 snapshot 缺失实体时才能建立 tombstone，snapshot 之后首次出现的实体必须继续 replay。buffer overflow 要提高最低可接受 snapshot revision，但不能丢掉覆盖范围内的 identity observation。旧 task generation 的 late event 仍消费它对应的 session revision 水位，避免下一条合法事件被误判为 gap，但不得修改 task；真正的 revision gap、snapshot generation regression 或 resource resurrection 必须触发重同步。task `generation` 只在同一逻辑任务显式 retry/restart 时递增，窗口拆短重试使用 main-private `windowAttempt` / `retryDepth`，不得复用公开 task generation。

批次 `status` 不是独立可写事实，必须由当前 task summaries 通过共享 `deriveLocalSubtitleBatchStatus()` 计算；session snapshot schema 同样拒绝与 task 聚合不一致的 batch status。空批次或全 queued 为 `queued`，任一 cancelling 为 `cancelling`，存在非终态为 `running`，全终态时有任一 completed 为 `completed`、全 cancelled 为 `cancelled`，否则为 `failed`。

字幕翻译交接不是本地转写状态机的运行阶段。导出成功后本地任务即为 `completed`，交接另行记录，避免外部 API 配置或网络错误把已经成功的本地转写误标为失败：

```ts
type SubtitleTranslationHandoffMode =
  | "export_only"
  | "enqueue_translation"
  | "enqueue_and_start_translation";

type SubtitleTranslationImportStatus =
  | "not_requested"
  | "pending"
  | "importing"
  | "queued"
  | "skipped"
  | "failed";

type SubtitleTranslationStartStatus =
  | "not_requested"
  | "requesting"
  | "started"
  | "waiting"
  | "failed";

interface LocalSubtitlePostActionState {
  mode: SubtitleTranslationHandoffMode;
  preferredFormat?: "SRT" | "LRC";
  importStatus: SubtitleTranslationImportStatus;
  startStatus: SubtitleTranslationStartStatus;
  importReceiptId?: string;
  translationTaskId?: string;
  importErrorCode?: LocalSubtitleErrorCode;
  startFailureReason?:
    | "estimate_failed"
    | "configuration_required"
    | "profile_unavailable"
    | "authorization_expired"
    | "start_rejected";
}
```

import 与 start 必须分开记录：任务成功加入但启动失败时保持 `importStatus = "queued"`、`startStatus = "failed"`，完成卡应跳转/重试该 `translationTaskId`，不能重新导入制造重复任务；只有没有 `translationTaskId` 的 import 失败/过期才直接显示“重新交接”。“查看任务”时由字幕翻译模块按 ID 查询存在性；若用户已删除任务，保持原回执不可变，显示“任务已移除”，用户明确点击重新交接后创建新 snapshot/handoffKey。`started`/`waiting` 仅表示字幕翻译队列接受了启动请求，本地工具不镜像后续翻译成功/失败状态。

### 8.2 Canonical transcript

唯一时间事实来源使用整数毫秒：

```ts
interface LocalSubtitleWord {
  startMs: number;
  endMs: number;
  text: string;
  probability?: number;
}

interface LocalSubtitleSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words?: LocalSubtitleWord[];
  estimatedTiming?: true;
  confidence?: number;
  speaker?: string;
}

interface LocalSubtitleTranscript {
  schemaVersion: 1;
  source: {
    displayName: string;
    durationMs: number;
  };
  model: {
    engine: "whisper_cpp";
    modelId: string;
    modelHash: string;
    backend: "cuda" | "metal" | "cpu";
  };
  detectedLanguage?: string;
  languageProbability?: number;
  segments: LocalSubtitleSegment[];
}
```

`words` 与 `estimatedTiming: true` 互斥：前者保留给未来经过版本化 provenance 校验的真实 word timeline，后者明确表示 segment-only cue 因 duration/text limit 发生了 grapheme-safe 比例拆分。未拆分的 segment 保留原 segment 时间且不标记 estimated timing。canonical 文本必须是 LF-only；main 在整形时把 CRLF/CR/U+2028/U+2029 统一为 LF，strict schema 拒绝残留的 CR/U+2028/U+2029、不受支持或会破坏结构的 C0/C1 控制字符和 unpaired UTF-16 surrogate。

不得把真实输入路径、模型绝对路径或临时 WAV 路径放进公开结果或 renderer 持久化。v1 runtime schema 只接受 PRE-006 已验证的 CPU/CUDA/Metal 实际 backend；尚未发布的 Vulkan 不能提前进入 v1 task/transcript。resource manifest 中表示一个 artifact 同时具备 Metal/CPU 能力的标签也不是 task backend，必须使用独立类型。

### 8.3 错误合同

所有 runtime、resource、artifact 和 translation handoff 错误从一个版本化 manifest 导出稳定 code，禁止各层临时拼接只在本层存在的字符串。首版至少覆盖：

```ts
type LocalSubtitleErrorCode =
  | "invalid_ipc_request"
  | "owner_released"
  | "authorization_expired"
  | "unsupported_platform"
  | "unsupported_architecture"
  | "runtime_missing"
  | "runtime_protocol_mismatch"
  | "runtime_crashed"
  | "runtime_unresponsive"
  | "media_runtime_missing"
  | "media_runtime_invalid"
  | "media_runtime_launch_failed"
  | "accelerator_unavailable"
  | "backend_mismatch"
  | "backend_unverified"
  | "model_missing"
  | "model_incompatible"
  | "model_corrupt"
  | "model_download_failed"
  | "model_disk_full"
  | "resource_not_allowed"
  | "resource_busy"
  | "resource_signature_invalid"
  | "limit_exceeded"
  | "insufficient_disk"
  | "media_probe_failed"
  | "no_audio_stream"
  | "media_changed"
  | "media_decode_failed"
  | "unsupported_media"
  | "no_speech_detected"
  | "transcription_failed"
  | "transcript_quality_failed"
  | "out_of_memory"
  | "output_conflict"
  | "output_write_failed"
  | "cleanup_failed"
  | "cancel_failed"
  | "cancelled_after_partial_commit"
  | "artifact_expired"
  | "artifact_changed"
  | "content_too_large"
  | "invalid_content"
  | "configuration_not_ready"
  | "configuration_required"
  | "directory_authorization_required"
  | "profile_required"
  | "profile_unavailable"
  | "duplicate"
  | "unsupported_format"
  | "import_failed"
  | "estimate_failed"
  | "start_rejected";
```

`runtime_*` 指 runner；`media_runtime_*` 专指随应用发布的 FFmpeg/ffprobe。`media_runtime_missing` 表示必需文件或 manifest 项缺失，`media_runtime_invalid` 表示 manifest、平台/架构、大小、SHA-256 或签名校验失败，`media_runtime_launch_failed` 表示文件通过静态校验但进程无法启动或版本探测失败。这三类错误都必须在任务入队前阻断转写，不能到媒体处理阶段才让一批任务逐个失败。`transcript_quality_failed` 表示 raw segment 在有界重试后仍命中连续重复、非法时间轴、窗口/媒体越界或窗口执行覆盖缺口；它不得被 formatter、去重或 parse-back 转成成功。

`cleanup_failed` 表示没有取消证据时，required window/media/Supervisor/export cleanup 未能可靠完成；`cancel_failed` 只用于已经存在 cancel/abort 证据且取消相关清理未能收敛。两者都必须以失败终态优先于普通 cancelled/abort 结算，不能吞掉后伪装为成功取消；exporter 若在没有取消证据时返回旧的 `cancel_failed`，production executor 必须归一化为 `cleanup_failed`。已经完整原子提交的合法 completed 结果仍优先于晚到的取消或 lease failure。

错误 envelope 还必须包含 `stage`、`retryable`、受控 `details` 和可选 `causeCode`，并对未知 runner/FFmpeg 诊断映射为最近的稳定 code。主错误文案可操作；stderr、退出码、backend 和阶段进入折叠技术详情。不得把完整命令行、用户路径、媒体内容、API Key 或下载授权 header 直接显示或写日志；diagnostics 有固定字节/行数上限，截断必须显式标记。

### 8.4 CORE-001 v1 版本与上限

`src/type/localSubtitle.ts` 是共享语义与上限的 production source；`poc/pre006-production-decision.json` 继续是 engine/platform/model/media 技术冻结的唯一记录。v1 固定 domain schema、official server HTTP contract、runtime manifest、resource/model manifest version 均为 `1`，任何不兼容放宽都必须升级对应版本，不能静默接受未知字段。

| 边界 | v1 上限/规则 |
| --- | --- |
| 普通 IPC request/event JSON frame | 256 KiB UTF-8；先计序列化字节，再执行 strict schema |
| Session snapshot JSON frame | 4 MiB UTF-8；snapshot 不含 raw path、目录 capability、one-shot token、prompt 或字幕正文 |
| 单批输入 | 100 文件；重复 file token 拒绝 |
| 单输入媒体 / 规范化 PCM guard | 64 GiB / 12 GiB |
| 单标准字幕 artifact | 16 MiB、最多 200,000 cues；artifact read/handoff 另按此上限，不受普通 event frame 代替 |
| Canonical transcript | 最多 200,000 segments、1,000,000 words、每 segment 512 words；duration/cue end 不超过 `359,999,999 ms` |
| 字幕文本 | 单 cue 最多 4,096 个正文字符、4 行、每行 1,024 字符；保留 Unicode，拒绝结构破坏控制字符 |
| 标识与展示 | id / opaque token/ref 最多 128 字符；display leaf 最多 255 字符 |
| 诊断 | 总计 64 KiB UTF-8、256 行、每行 1,024 字符；metadata 只接受固定 key，截断显式标记 |
| Runtime manifest | 文件最多 2 MiB；最多 256 artifacts、64 licenses、64 sources、256 evidence files；relative path 最多 512 字符 |
| PRE-006 window strategy | 30,000 ms root window、5,000 ms overlap、最多 3 层 window retry |
| PRE-004 quality oracle | 100 ms boundary tolerance、15,000 ms raw segment、连续 8 cue 且首尾 wall-clock span 15,000 ms；bounded retry 与 boundary merge 阈值见 10.3 provenance table |
| SUB-001 policy v1 | 300 ms short-cue merge、分离的 raw/boundary fingerprint 与 grapheme-safe prefix trim；不是 PRE-006 decision 字段 |
| Native HTTP | 单响应 64 MiB、单活动请求、私有 path 至少 192-bit entropy |

所有跨边界 object 递归使用 strict runtime schema，拒绝 raw `path/filePath/outputPath/modelPath`、任意 executable/args/backend flags、未知 backend 与多余字段。renderer enqueue 只提交产品字段与 opaque capability；`modelHash`、`resolvedBackend`、runtime pin 和 batch immutable snapshot 均由 main 解析/生成。CORE-001 不冻结 channel 名或 owner handshake；CORE-002 已冻结 bundled runtime manifest/staging 文件合同，下载型 model/VAD/accelerator manifest 仍由对应后续 owner 包完成。

## 9. Preload、IPC 与权限边界

### 9.1 Renderer API

`window.localSubtitleApi` 只暴露固定方法，不暴露接收任意 channel 的 generic invoke：

```ts
interface LocalSubtitleApi {
  authorizeInputFiles(files: File[]): Promise<LocalSubtitleIpcResult<AuthorizedMedia[]>>;
  probeMedia(fileToken: string): Promise<LocalSubtitleIpcResult<MediaProbeSummary>>;
  revokeInputFile(fileToken: string): Promise<LocalSubtitleIpcResult<{ revoked: boolean }>>;
  selectOutputDirectory(): Promise<LocalSubtitleIpcResult<AuthorizedOutputDirectory>>;
  revokeOutputDirectory(outputDirToken: string): Promise<LocalSubtitleIpcResult<{ revoked: boolean }>>;
  probeRuntime(): Promise<LocalSubtitleIpcResult<LocalSubtitleRuntimeSummary>>;
  listManagedResources(): Promise<LocalSubtitleIpcResult<ManagedResourceSummary[]>>;
  startResourceInstall(request: { resourceId: string }): Promise<LocalSubtitleIpcResult<ResourceJob>>;
  cancelResourceJob(jobId: string): Promise<LocalSubtitleIpcResult<{ cancelled: boolean }>>;
  importModel(file: File, options: { mode: "copy" | "move" }): Promise<LocalSubtitleIpcResult<ResourceJob>>;
  deleteManagedResource(resourceId: string): Promise<LocalSubtitleIpcResult<{ deleted: boolean }>>;
  getSessionSnapshot(): Promise<LocalSubtitleIpcResult<LocalSubtitleSessionSnapshot>>;
  enqueue(request: EnqueueLocalSubtitleBatchRequest): Promise<LocalSubtitleIpcResult<BatchSummary>>;
  retryTask(taskId: string): Promise<LocalSubtitleIpcResult<TaskSummary>>;
  cancelBatch(batchId: string): Promise<LocalSubtitleIpcResult<{ cancelledTaskIds: string[] }>>;
  cancelTask(taskId: string): Promise<LocalSubtitleIpcResult<{ cancelled: boolean }>>;
  removeTask(taskId: string): Promise<LocalSubtitleIpcResult<{ removed: boolean }>>;
  readArtifactText(artifactRef: string): Promise<LocalSubtitleIpcResult<ArtifactTextResult>>;
  revealArtifact(artifactRef: string): Promise<LocalSubtitleIpcResult<{ revealed: true }>>;
  handoffArtifact(artifactRef: string): Promise<LocalSubtitleIpcResult<SubtitleHandoff>>;
  onTaskEvent(listener: (event: LocalSubtitleTaskEventEnvelope) => void): () => void;
  onResourceEvent(listener: (event: LocalSubtitleResourceEventEnvelope) => void): () => void;
}
```

该接口是首版 UI 行为所需的最小完整面，不是随实现临时补方法的示意列表：`probeMedia` 支撑启动前音轨选择，`readArtifactText` 支撑预览/复制，`retryTask`/`removeTask` 支撑结果操作，`cancelBatch` 支撑停止等待项与未来交接，resource job API 支撑模型/VAD/accelerator 下载的进度与取消，`getSessionSnapshot` 支撑 SPA 返回后的重同步。`removeTask` 对运行中任务必须拒绝并要求先取消；`readArtifactText` 只返回经过格式/UTF-8/大小上限复核的 `{ format, rawText, plainText, cueCount }`，不返回路径。`plainText` 必须由共享 SRT/LRC parser 从已验证 cue 生成，不能在组件里用正则临时剥时间标签。v1 公开结果对整个序列化 DTO 继续执行 16 MiB 上限，因此接近单 artifact 上限的合法文件可能因同时返回 `rawText + plainText` 而稳定返回 `content_too_large`；不能绕过 shared schema 或把正文拆进普通 256 KiB event。

文件路径只能由 preload 固定方法使用 `webUtils.getPathForFile()` 取得，再通过 preload-private channel 授权。`startResourceInstall` 只接收内置 manifest 中的 `resourceId`，不能接收 URL、保存路径或可执行参数。TypeScript union 不是运行时安全边界。

### 9.2 Main 校验

- 每个 token 绑定 `webContents.id`、main 为当前 document/frame 签发的 `ownerSessionId`、资源类型、过期时间和允许操作。`ownerSessionId` 只保存在 preload 私有闭包，由固定 API 隐式附加，renderer 不能自填；reload、主框架导航、frame/window 销毁时立即失效，不能仅靠 `webContents.id` 区分新旧文档。
- 输入 token 支持批处理，但每个 task 开始时再次校验文件 identity、存在性和大小。
- batch commit 必须把 renderer draft capability 原子转换为 task lease；成功后普通 renderer cleanup 不得撤销 active task 依赖，失败时全部权限仍归 draft 或按逆序释放，不能半转移。
- Job Manager 在 capability reservation/commit 前执行 owner-bound media runtime admission：对 bundled manifest 做静态校验，启动 FFmpeg/ffprobe 精确版本探针，再次静态校验并拒绝 runtime generation 漂移。admission 失败时 input/output 仍保持 draft，不能先消费 capability 再从 executor 返回错误。
- 输出目录 token 只允许写入目录内部；最终路径必须 `resolve` 后检查仍在根目录下。
- `modelId` 只从 main 的已验证 manifest 解析，renderer 不能提交任意模型路径。
- 事件只发给任务 owner，并带单调 revision；snapshot 与事件由同一权威状态生成。窗口销毁时释放该 owner 的 token/job/task；app-scoped runner 只有在没有其他 owner 的活动任务后才进入卸载/关闭，不能误杀其他窗口工作。
- 所有 request 使用运行时 schema 校验，拒绝未知字段，避免 renderer 偷渡 executable、path、backend flags 或任意 runner 参数。

## 10. 官方 whisper-server 运行合同

### 10.1 进程与传输模型

- main 只从 `verifyLocalSubtitleRuntimeBundle()` 返回、带 module-private opaque proof 的 verified bundle map 按固定 artifact ID 选择官方 `whisper-server`，再直接 `spawn()`；不得把 root/generation/artifact 字段重新拼成一个看似已验证的 selection，也不接受 renderer 提交 executable 或参数。
- child 使用 allowlisted 最小环境与受控 cwd，只保留动态库、系统运行和 bundled media runtime 所需变量；不得继承 API Key、authorization header、代理凭据或任意 Electron/Agent secret。
- server 只绑定 `127.0.0.1` 临时端口；main 为每次进程会话生成至少 192-bit 随机 request path，并把 `--public` 指向空的私有临时目录。端口和私有 path 不进入 renderer、Store 或日志。`BE-001` 已在受控 `<userData>/local-subtitle/temp/server-*` 下创建 mode `0700` 的 session/public/tmp，使用 no-follow `lstat`、`realpath` containment、empty-public 与 `dev/inode/birthtime/mode` identity 复核后才 spawn；NATIVE-001 的同步 descriptor 仍只做词法合同，不能把调用方传入的“empty”路径当作文件系统事实。
- startup readiness 只认带私有前缀的 `/health` JSON；启动阶段的 connect/timeout/503 可由 supervisor 有界重试。一旦进入 ready，runtime health 的 timeout、transport、HTTP 或 schema 失败都 taint 当前 generation 并要求重启，不能沿用 startup 的 reusable 语义。取消后的 `/health=ok` 也不能证明底层推理已收敛。
- health/readiness/inference 共用在首个 `await` 前同步领取的 single-active operation ticket；busy 调用不得发出第二个 HTTP request，成功返回前必须复核 ticket 与 session disposition，避免并发 health 已 taint 后 inference 仍返回 reusable。
- inference HTTP 客户端必须流式发送文件并使用独立、显式的长任务 absolute deadline 与 response size 上限；deadline 从文件 open 前起算，并覆盖 HTTP exchange 与有界 FileHandle close，open/stat 消耗会缩短可用 HTTP 时间。close 失败或超期同样 taint generation，不得吞错；不得依赖 Node 全局 `fetch`/Undici 的默认 response-header timeout。PRE-003 已复现短任务成功、长 CPU 任务约五分钟客户端断开的隐蔽边界。
- 一个 server 同时只接受一个 FusionKit operation，但在同一 model/backend 的连续成功任务间保留 context。model/backend 变化、load 失败、ready 后 health 失败、crash、取消或 cleanup 超时时由 supervisor 终止并重启进程。
- 普通推理不访问外网。loopback HTTP 只是 Electron main 与其 child 的本机进程边界，并禁用代理继承；模型/加速包下载仍走单独的 ResourceJob。

`BE-001` 的 Supervisor 已把进程层合同实现为以下 main-only 状态：

- 状态机为 `unloaded → starting → ready → stopping`，异常清理进入 `faulted`，终止 app lifecycle 后进入 `disposed`。应用启动或只打开页面不 acquire server。
- opaque owner/load lease 绑定 verified runtime、server artifact、model/VAD、backend 与 process flags；匹配 lease 复用同一 PID，不匹配的 identity 在任一 lease 活跃时返回 `resource_busy`。load/inference 可变输入在首个 `await` 前快照，process epoch 与公开 task `generation` / HTTP `requestGeneration` 分离。
- `beginInference()` 同步领取 Supervisor request ticket；NATIVE-001 client 仍在自身边界同步领取 transport ticket。取消、owner release、unexpected close 和 late result 先 fence process epoch，不能让旧结果穿过 restart boundary。
- starting 内只重试 reusable transport/timeout/503 readiness；schema failure 立即失败。pre-readiness child close 最多在同一 startup deadline 内以全新 session、port、private path 和 process epoch 重试一次；ready 后复用前的 `health()` 任一失败均退役该 epoch，再由同一 lease 启动新进程。
- CPU 的 backend 证明来自 descriptor 中 exact 单一 `--no-gpu`；Metal/CUDA 必须由 main-only verifier 在 startup deadline 内返回与 exact epoch、PID、backend、runtime generation 和 artifact 完全一致的 attestation。缺失/超时/未知字段为 `backend_unverified`，已证明但 backend/runtime/artifact 不一致为 `backend_mismatch`；Supervisor 不做 silent fallback。
- session cleanup 只接受原 opaque proof：先复核 identity，再把 owned root 原子改名到同一 private base 内的 quarantine path，复核后才递归删除；quarantine remove 失败可按 exact proof/identity 续清理。原 root 缺失时默认 fail-closed，只有同一 proof 已记录成功删除才幂等返回 `removed:false`。替换路径、权限变化、unconfirmed child close、pre-spawn cleanup failure 或 closed-session cleanup failure 都锁存 `faulted` 并阻止 respawn；显式 shutdown 可重试已知 identity 的 cleanup。启动时扫描历史 orphan `server-*` 不属于本包，仍由 `BE-003` 完成。

### 10.2 请求与结果归一化

正式媒体管线先由 FusionKit 的 Media Normalizer 生成受控 16 kHz mono PCM16 WAV，再从该 PCM 按精确 frame 边界切出约 30 秒、有小幅 overlap 的私有窗口 WAV，以独立 multipart `file` 请求发送给 `/inference`。`MEDIA-001` 必须产出 main-only branded window identity 并验证 RIFF/WAVE、PCM16、16 kHz、mono、frame/size/duration；production executor 把解析出的 `{ dev, ino, size, mtimeMs, ctimeMs }` 冻结为 request 的 `expectedFileIdentity`，HTTP transport 在任何网络请求前使用 `O_NOFOLLOW + FileHandle/fstat` 精确比对并持续持有同一非空文件，不能独自把任意 `.wav` 路径宣称为已规范化。原始音视频只规范化一次，不为每个窗口重新解码；产品 runtime 不启用官方 server 的 `--convert`，避免其内部 shell FFmpeg。PRE-002 为快速验证现有 MP4 临时启用系统 FFmpeg，不形成发行合同。

请求字段只由 main 从已校验 task snapshot 生成：

```text
file=<main-private-window-wav>
response_format=verbose_json
language=auto|zh|ja|...
translate=false
vad=true
token_timestamps=false
no_language_probabilities=true
```

`NATIVE-001` 与 `SUB-001` 已冻结 v1 为 `segment_only_v1`：VAD/非 VAD 请求均发送 `token_timestamps=false`，adapter 不把上游 optional words 交给 post processor，word-bearing post-processing input 也不属于 v1 合同；renderer 不能控制这些上游字段。任何未来 non-VAD word path 都必须先增加新的 versioned server capability、明确时间域 provenance 及其 validation/failure policy；本文不预先承诺 fallback 行为，不能只靠给 post processor 注入一个 `words` 属性提前开启。

窗口索引、绝对 `startMs/endMs`、overlap 和 main-private `windowAttempt` / `retryDepth` 只保存在 main 的任务上下文，不作为可由 renderer 或上游响应覆盖的字段。Node adapter 对 response schema 做运行时校验，把 segment 的相对秒值立即转换为整数毫秒；v1 只保留 segment。task mode 也必须绑定：`transcribe` 只能接受 upstream `task="transcribe"`，`translate_to_english` 只能接受 `task="translate"`，不匹配按 protocol failure 拒绝。raw quality gate 通过后再加窗口绝对偏移并交给 overlap merger/canonical post processor。不得直接采用上游 SRT/LRC 输出，也不得在 renderer 解析 server JSON。

官方 v1.9.1 server 不提供稳定的结构化增量 progress/segment 流。PRE-006 已冻结首版 UI 只显示 `preparing_media → loading_model → transcribing → post_processing → exporting` 阶段、窗口/文件完成数和真实媒体准备进度；不解析 `--print-progress` stderr 伪造百分比。未来若真实 UX 验收证明不足，应新增独立工作包评估上游 API，不能在 NATIVE-001 中暗建 native bridge。

### 10.3 有界窗口、合并与 raw quality gate

PRE-004 已证明同一模型/backend 对故障区间的独立约 30 秒请求能恢复实际内容，而整段单请求会在后续内部窗口进入重复 decoder 状态。首版因此采用以下合同：

1. Window planner 的权威覆盖域是 half-open PCM frame interval `[0, totalFrames)`，按 frame 生成单调、连续、有界的窗口计划；`source.durationMs` 必须且只能由 `Math.round(totalFrames * 1000 / 16_000)` 得到。不得用 `durationMs` 反向取整重建 `totalFrames`，也不得以毫秒覆盖替代 frame coverage 而静默丢掉一帧；最后一窗可缩短。每个计划项必须终结为 `succeeded`、经语音判定的 `no_speech` 或显式失败，不能因请求漏发而留下覆盖缺口。
2. 每个窗口是独立 inference 请求和 decoder context，但继续复用同一已加载 model/backend 的 server 进程。取消仍作用于当前请求并使下一任务重启 server；普通窗口成功不触发模型重载。
3. 在任何 trim/split/formatter 之前，逐窗检查 raw segment 的正时长、单调/重叠、窗口及媒体边界、15 秒单段上限、规范化同文连续 8 cue 且覆盖 15 秒的退化，以及 window plan 执行覆盖；`parseBack=true`、HTTP 200 或尾时间戳接近媒体末尾都不能替代该检查。
4. overlap 合并使用绝对时间、窗口核心区所有权和边界 token/text 相似度做确定性仲裁；只处理同一边界的重复观测，不做全文件字符串去重，也不因合法重复台词直接丢 cue。
5. 命中退化门禁时用 main-private `windowAttempt` / `retryDepth` 最多拆短 3 层，并完整记录 parent/children、窗口长度和 overlap；不得把窗口重试伪装成公开 task generation，也不得在重试中静默更换 backend、sampling strategy 或 VAD 合同。预算耗尽后返回 `transcript_quality_failed`，不进入 canonical formatter 或 artifact commit。

`SUB-001` 把这组规则冻结为 main-only attempt graph，而不是只接收一组几何上连续的最终叶窗。root plan、root/window/parent key、`windowAttempt`、Supervisor `processEpoch` 和 HTTP `requestGeneration` 必须保留。`windowAttempt` 是同一 root plan 内唯一的正整数 dispatch ID；child ID 必须大于 parent，但允许因取消、拒绝或其他调度动作出现间隔，不能把它误解为连续数组索引。每次 dispatch 保存的 `requestGeneration` 必须与 Supervisor 返回 response 上的 generation 完全相等，且同一 `processEpoch:requestGeneration` 不得被另一个 attempt 复用，借此拒绝 stale/copy response。

退化父窗只有在纯 planner 按相同 frame/window/overlap 规则复算出的全部 exact children 都出现后才算被替代。正常 split 是结构化内部 control，不产生公开错误；在逐窗 quality retry 分支中，只有 `retry_exhausted` / `unsplittable` 以 `transcript_quality_failed` 终止该质量重试链，`contract_invalid` 走 `runtime_protocol_mismatch`。merge、shaping 或 canonical 的全局质量不变量仍可独立返回 `transcript_quality_failed`，不能把“逐窗 split 不公开报错”扩大成全局质量失败也必须成功。空 segment 结果还必须有正数、与窗口时长在 100 ms 内一致的 server duration，且顶层 text 与 segment 正文同时为空，才能作为 verified no-speech terminal；`durationMs=0` 的空响应不能填补执行覆盖。

结构 planner 只验证整数 frame、毫秒映射、root/child 几何与 lineage，不拥有媒体文件真实性。16 kHz mono PCM16、RIFF/WAVE、frame/size/duration、main-only branded window identity 和实际窗口字节仍全部由 `MEDIA-001` 提供；SUB-001 不能把普通结构对象或任意路径升级为媒体 authority。`BE-002` 当前 production executor 已把不可变 branded window request 同时绑定到 normalization、exact structural window descriptor、`windowAttempt`、`processEpoch`、dispatch/response `requestGeneration`、response 和 inference 前后 exact file identity；window swap、复用旧 brand、brand 与 frame range 不一致或 restart 后的 stale brand/response 一律拒绝。后续多文件、GPU/VAD 或其他执行路径必须复用同一绑定，不得仅凭路径仍存在就继续处理。

SUB-001 policy v1 的来源分层如下，不能把后两层阈值静默写回 PRE-006 production decision：

| 来源层 | 冻结内容 | 合同归属 |
| --- | --- | --- |
| PRE-006 strategy | `30,000 ms` root window、`5,000 ms` overlap、最多 `3` 层 retry | production 技术策略；改变时必须重开 PRE-006 决策 |
| PRE-004 quality oracle | `100 ms` boundary tolerance、`15,000 ms` raw segment、连续 `8` cue 且首尾 wall-clock span `15,000 ms`；bounded retry 的 `4,000 / 2,000 ms / 1.25`；boundary merge 的 `500 ms`、CJK `2` / Latin `4` | 真实样本导出的质量 oracle；SUB-001 精确实现并保留来源 |
| SUB-001 clean-room policy v1 | `300 ms` short-cue merge、两个分离的 NFKC fingerprint、grapheme-safe prefix trim | post-processing 自有版本化 policy；不是 PRE-006 字段 |

raw-loop fingerprint 可忽略 punctuation/symbol/whitespace 以保持 PRE oracle；会删除文本的 boundary fingerprint 必须保留 symbol，并且 NFKC overlap 只能在完整 source grapheme 边界裁剪。

质量门禁证明的是输出没有已知 decoder loop/时间轴退化，不是 CER/WER 准确率声明。最终中日内容仍需真实样本人工 smoke，但不能再只抽查开头几段。

### 10.4 取消与崩溃

Node 对当前 inference request 使用 `AbortController`。请求连接关闭后，官方 v1.9.1 server 的 `abort_callback` 检测 client disconnect 并终止推理：

1. 任务取消先 abort 当前 HTTP request，并等待该 Promise 以稳定 `aborted` 结束。
2. 无论紧接着的 `/health` 是否返回 ok，supervisor 都在下一任务前终止并重启该 server、重新加载模型；PRE-003 证明 health 只代表 HTTP 进程存活，不能作为底层取消工作已经完全收敛的复用屏障。
3. 在有界超时内连客户端请求都未结束时，直接进入 kill fallback；旧 generation 的 late response 必须丢弃。

主进程始终维护 child handle，不使用参考 GUI 的“只改布尔标志”方案。BE-001 已实现同步 `releaseOwner()`：立即撤销该 owner 的 lease、fence/abort 其请求，再把异步 retire 纳入 Supervisor background cleanup；其他匹配 lease 可以在新 epoch 继续。应用退出的首个 `before-quit` 会阻止退出并等待有界 shutdown，结算后重试 `app.quit()`；瞬时 shutdown failure 可重试，wrapper timeout 不丢弃仍在运行的底层 cleanup，后续调用继续观察同一 operation。update `quitAndInstall` 也必须先等待成功 shutdown。lifecycle 与 updater listener 注册幂等。实际 task/window 所有权、批量取消和 revision event 仍由 `BE-002` 编排，不能把 Supervisor lease 当成 Job Manager。

取消或 retire 依次执行 AbortController、SIGTERM、SIGKILL；`kill()` 返回、`exit` 或健康检查成功都不构成 native work 已结束。只有 child `close` 这个 stdio-drain boundary 后才能 finish diagnostics 和删除 session；同一 epoch 的主动 retire 与被动 close observer 共享幂等 cleanup/finalize promise，具体规则沉淀为 `FK-PIT-0039`。force kill 后仍无 `close` 时保持 `faulted` 和 session proof，不允许新进程覆盖证据。

### 10.5 Backend 解析与 fallback

- `devicePreference = "auto"` 在批次 commit 前根据 selected-profile 完整性 manifest、真实 runner probe、accelerator pack 和模型兼容性解析为 CUDA/Metal/CPU，并把 `resolvedBackend` 明确展示并写入批次 snapshot；没有可用加速时可解析为 CPU，但用户在点击开始前必须看得到。
- 用户显式选择 CUDA/Metal 时不可回退 CPU。auto 已 commit 后若 GPU load/OOM/driver/crash，批次暂停且不启动后续文件；UI 提供“以 CPU 新 generation 重试”，需要用户确认预期性能变化，不能在后台把长任务静默改跑 CPU。
- 每个任务 metadata 携带所选 artifact/build ID 与 resolved backend。PRE-003 已用真实 GPU 占用、RTF 和故障注入确认官方 CUDA artifact 不会假成功；Windows WDDM 下 `nvidia-smi` 的逐进程显存可能为 `N/A`，可使用按 exact PID 过滤的 `GPU Process Memory` 性能计数器。PRE-006 冻结：无法取得实际 backend 证明时返回 `backend_unverified`，不得仅靠人类日志在 UI 宣称 GPU。

`BE-001` 只验证调用方已经解析出的 backend 与实际 child 一致，不负责 `auto` 选择、批次 snapshot、CPU fallback CTA 或重试 generation；这些产品级决策随 model/runtime probe 与 Job Manager 接线完成。当前 CPU 证明由 exact `--no-gpu` 固定；GPU 证明接口保持 main-only 且 deadline-bound，拒绝字段/epoch/PID/backend/runtime/artifact 不一致，但其可信根仍是注入的 main-only verifier，不能由 renderer 或 stderr 文本提供。

## 11. 模型与加速包管理

### 11.1 目录

```text
<userData>/local-subtitle/
  models/
    <model-id>/model.bin
    <model-id>/manifest.json
  vad/
  accelerators/
  downloads/*.part
  jobs/
  temp/
```

模型不进入 `localStorage`、asar 或 Git；renderer Store 只保存 `modelId`。`modelId` 由 main 通过受信 manifest 解析到 managed models 目录中的文件，不保存用户最初选择的外部 `.bin` 绝对路径，也不允许 renderer 在运行时传入任意模型路径。

### 11.2 内置清单下载与安装流程

模型管理页提供单次用户操作即可开始的下载 CTA；安装 FusionKit、首次启动应用或只是打开工具页都不得自动下载模型。用户发起下载后，应用在后台完成以下受控流程：

1. 从 FusionKit 内置的、版本化的模型 manifest 选择下载源、期望大小和 SHA-256。
2. 下载到 `.part`，支持 HTTP Range；服务端不支持 Range 时从头重新下载。
3. 校验文件大小和 SHA-256。
4. 通过 runner 做只读 metadata/load smoke。
5. 原子改名为最终文件并写 manifest。
6. 校验失败保留可重试状态，但不得把损坏文件标成 ready。

上游模型表提供的是其发布校验值；FusionKit 发布 manifest 仍应使用自己的 SHA-256 并锁定具体文件 URL，不以“同名模型”作为信任依据。

模型下载/导入、VAD 与 accelerator pack 共用受控 `ResourceJob` 生命周期：`queued → acquiring(download|copy) → verifying → load_smoke/signature_check → committing → completed`，任意阶段可进入 `failed`，acquiring/校验阶段可取消。resource event 与会话 snapshot 同样携带单调 revision；SPA 离页不丢失进度，renderer reload/window destroy 时由产品策略明确选择取消或让 main 完成安全 commit，不能留下无人持有的 `.part`。首版采用保守规则：owner session 结束即取消未进入原子 commit 的 job，commit 已开始则完成或回滚后再释放。

Resource manager 是 app-scoped，但 job/event 仍 owner-bound。同一 `resourceId` 已被另一个 owner 安装时，首版返回脱敏 `resource_busy`，不把对方 jobId、URL、路径或进度暴露给当前 owner；安装完成后所有 owner 通过 `listManagedResources()` 只能看到全局 ready 状态。GPU task queue 同样是 app-scoped FIFO，每个事件只发给所属 owner；owner 结束只移除自己的 queued/running task，不清空其他窗口队列。

### 11.3 自定义导入

- 支持用户导入已有 GGML Whisper `.bin`。
- main 检查文件头、模型架构、模型大小、语言能力和 runner 可加载性。
- 导入后复制或移动到 managed models 目录，默认复制，避免原文件移动造成惊讶；选择移动必须显式确认，且仍先完成受管临时复制、校验和原子提交，只有提交成功后才删除源文件，任一步失败都保留源文件。
- 原子提交后，运行时只依赖 managed file，不继续引用原始外部路径。默认复制会同时占用原文件和 managed copy 的磁盘空间，导入前必须展示空间预检与预计新增占用。
- 不支持把 faster-whisper/CTranslate2 模型目录误识别为 GGML。

### 11.4 平台加速包

推荐发布矩阵：

| 平台 | 基础 runner | 加速策略 |
| --- | --- | --- |
| Windows x64 | CPU runner 随应用 | 固定官方来源、archive size/SHA 与逐文件 manifest 校验的 CUDA accelerator pack 按需安装；personal profile 不要求 Authenticode |
| macOS arm64 | Metal-enabled runner 随应用 | 首版 Metal；同一 arm64 build 可显式回退 CPU，Core ML encoder 作为后续可选模型资源 |

Windows CUDA runtime/DLL 的来源、包体和运行依赖已由 PRE-003～PRE-006 固定；QA-005 仍需在实际分发前逐项核对 NVIDIA redistributable 与 notice。不能把“开发机安装了 CUDA 所以可用”当作发行方案。

PRE-006 的 Windows 结论是：默认安装包只随 CPU official server；CUDA 使用由用户
按需安装、按固定官方 archive size/SHA 和逐文件清单校验的 optional accelerator pack。固定官方 CUDA ZIP 为
677,887,125 bytes，解压后约 1,209,487,872 bytes；CPU ZIP 为 7,982,101 bytes，
解压约 20,355,072 bytes。把 CUDA 全量塞进默认安装包会让所有用户承担约 1.2 GB
额外安装占用；要求用户安装 CUDA Toolkit/PATH DLL 则扩大版本漂移和故障面。
official pack 已在只含 runtime directory、开发用 FFmpeg directory 与 System32、
且不含已安装 CUDA Toolkit 的 child PATH 中完成真实 CUDA 推理，因此 Toolkit 不是
运行前置，兼容 NVIDIA driver 仍是前置。PRE-006 按 CUDA 12.4 GA 官方表保守冻结 Windows driver `>= 551.61`，当前真实证据为 610.62；若未来要接受更低的 CUDA 12.x minor-compatibility driver，必须在目标机新增明确证据。具体 NVIDIA DLL
再分发条款与 notice 仍由 QA-005 审计，安装/更新/回滚由 QA-003 验收。`unsigned_personal_distribution` 不要求 Windows 代码签名、证书或信任库变更；本文不是法律意见。

macOS x64 不生成 runner、模型加速包或安装产物；平台探测必须在资源解析前返回 `unsupported_architecture`。

accelerator pack 若使用 archive，必须先下载到不可执行 staging，完成固定来源、profile 要求的签名（若有）、SHA 和大小验证后再按内置文件 manifest 解包；拒绝绝对路径、`..`、路径分隔符逃逸、symlink/junction/reparse entry、重复 leaf、未知文件和超过单文件/总量上限的内容。每个解包文件再次校验 hash，runner `probe` smoke 成功后才原子提交版本目录；验证完成前不得把下载目录加入 DLL search path 或执行其中任何文件。失败/取消保留旧 pack 可用并清理 staging。

### 11.5 模型支持范围与加载生命周期

内置下载能力使用版本化 allowlisted manifest，不把“whisper.cpp 上游存在某个模型”直接等同于“FusionKit 已支持一键下载”。PRE-006 首发清单冻结为：

| 模型 | 定位 | 首版文档口径 |
| --- | --- | --- |
| `large-v3-q5_0` | 跨平台验证过的量化 large-v3 | 首发唯一内置下载项与推荐默认；1,081,140,203 bytes，固定 SHA-256 |
| `large-v3` | 未量化质量优先候选 | 延后；需精确 artifact hash 与跨平台产品证据 |
| `large-v3-turbo` | 速度优先候选 | 延后；需跨平台质量/性能证据 |
| `large-v3-turbo-q5_0` | 轻量快速候选 | 延后；需跨平台质量/性能证据 |

model/VAD manifest v1 的每个可下载资源都必须包含 `id`、`resourceType`、`fileName`、`format`、`engineCompatibility`、exact `sourceRevision`/HTTPS URL、`byteSize`、SHA-256、license 和 `bundledInInstaller=false`。model 另含 multilingual/quantization/default/quality label；VAD 另含 default、token-timestamp policy 和 timeline policy。renderer 只提交 `resourceId`，不能覆盖 URL、hash 或目标路径。

`tiny`、`base`、`small`、`medium` 等其他 Whisper GGML 模型可在 runner 兼容、manifest 来源/哈希和真实质量验收完成后加入；在此之前不得笼统宣称支持所有 Whisper 或 whisper.cpp 模型。用户导入的兼容 GGML 模型通过 header、架构、大小、语言能力和 load smoke 后可以形成 managed model，但“允许自定义导入”不等于该型号自动进入 FusionKit 内置下载清单。

模型生命周期固定为：

1. 安装、更新或启动应用时不把数 GB 模型打进安装包，也不急切加载推理模型；启动阶段只做 schema/manifest 兼容检查与孤儿资源清理。
2. 打开本地字幕转写页时只探测 runner/backend、FFmpeg、已安装模型状态与磁盘占用；不得仅因进入页面就发送 `load_model`。
3. 下载或导入完成时允许 runner 做一次受控 load smoke 来判定 ready，校验结束后立即释放，不把它当成会话推理模型驻留。
4. 用户开始批次时，main 根据冻结的 `modelId` + manifest/hash 解析 managed file，并向 runner 发送 `load_model`；同一 model/backend 已驻留时跳过装载阶段。
5. 同一 runner 跨本批及后续兼容任务复用已加载模型。切换 model/backend、空闲超时、显存不足、最后一个活动 owner 结束、应用退出或进入更新时显式卸载/关闭；单个窗口销毁只释放其 owner 资源，不能影响其他窗口。
6. 应用重启后内存中的模型 context 不存在；只恢复最近 `modelId` 偏好，下一次真正开始任务时重新加载。

因此产品语义是“managed model + 持久化 `modelId` + 按任务加载并跨任务复用”，不是“只记录用户原始 `.bin` 路径并在每次打开应用或工具页时自动加载”。

## 12. 媒体预处理

### 12.1 为什么需要 FFmpeg

`whisper.cpp` 当前 CLI 可直接处理部分音频格式，官方也提供可选 FFmpeg build；但产品需要稳定支持 mp4/mkv/mov/webm 等视频容器、不同音轨和损坏输入诊断。统一预处理更容易控制行为：

```text
source media
  → ffprobe 获取时长、音轨和 codec
  → ffmpeg 选择音轨
  → 16 kHz / mono / PCM16 WAV 临时文件
  → runner
```

FFmpeg/ffprobe 是产品运行时组成，不是用户环境前置条件。正式发布必须为 macOS arm64 和 Windows x64 固定可再分发构建，并通过 `extraResources` 放在 asar 外。每个文件由版本化 runtime manifest 记录 `kind`、`platform`、`arch`、相对路径、字节数、SHA-256、版本、`licenseRef` 和平台完整性 profile；macOS 使用签名后 bytes，Windows 当前 personal distribution 使用 explicit unsigned final bytes。packaged 模式只接受这份 manifest 解析出的文件，禁止回退 `PATH`、Homebrew、Chocolatey、注册表、用户配置路径或文件选择器。公开发布时的应用/可选下载资源签名属于后续 QA 范围，不是本地运行依赖。

系统 FFmpeg 只用于 PRE/开发阶段生成测试媒体或在正式 staging 尚未建立前执行转码 PoC。PRE-005 packaged smoke 已只从 manifest 路径启动随包 FFmpeg/ffprobe；开发机探测成功不构成发布证据，开发机探测失败也不意味着未来用户需要自行安装 FFmpeg。

### 12.2 音轨选择

- ffprobe 只向 renderer 返回脱敏的音轨摘要：受控 `streamId`、default disposition、语言、标题、codec、声道和采样率，不返回媒体路径或可注入的 FFmpeg selector。
- 语言/标题/codec 等容器元数据属于不可信输入：main 去除控制字符、限制每字段与总 payload 长度，并保留原始 stream index 仅作私有映射；UI 使用可换行 block surface，不把长标题塞进不换行 Badge。
- 默认 `auto`：优先容器中唯一标记为 default 的音轨；没有或存在多个 default 时选第一条音轨，并在任务启动前显示“自动选择了第 N 轨”。无音轨直接返回 `no_audio_stream`。
- 多音轨文件允许用户在启动前按文件覆盖；renderer 只提交 probe 返回的 `streamId`，main 必须校验它仍属于同一 authorized file identity。批量偏好只保存 `auto`，不能把某个文件的 stream index 持久化给其他文件。
- probe 与 ffmpeg 启动之间若文件 identity 或流表变化，拒绝执行并要求重新 probe，不能让旧 streamId 指向新内容。

### 12.3 进程规则

- packaged 模式先完成 manifest identity、平台/架构、size、SHA-256 和声明的签名/unsigned integrity profile 校验，再从受控绝对路径启动；校验失败不得尝试同名 PATH 命令。
- 使用 `spawn(executable, args)`，不拼 shell 字符串。
- 使用与 runner 相同的最小环境策略，不把 API Key、下载 header 或代理凭据传给 FFmpeg/ffprobe；cwd 固定在受控 temp 根。
- 使用 FFmpeg `-progress` 机器可读输出计算媒体准备进度。
- 关闭 stdin，避免隐藏式交互等待。
- 临时文件名使用 task UUID，不使用原文件名直接拼接。
- 转码成功后校验 WAV 头、采样率、通道数和非零时长。
- 从已验证 PCM 按 frame 边界生成有界窗口，记录每窗绝对范围与 overlap；不得为每窗重新读取/转换原始容器，也不得让累计取整产生尾部覆盖缺口。
- 取消、失败和下次启动时清理超期 temp。

### 12.4 FFmpeg 许可证

FFmpeg 二进制必须固定来源、构建选项、许可证文本和源码获取方式，使用独立进程，不随意采用未知来源的“静态包”。PRE-006 为 macOS arm64 固定 FFmpeg 8.1.2 source build：关闭 GPL、nonfree、version3、network、autodetect 与外部库，只启用首版格式所需能力，使用 macOS 11 target 和稳定逻辑 prefix；最终二进制只有系统动态依赖且不含 host/private build path。source archive、detached signature、release key、license、notice、source offer 与 build recipe 一并固定，完整 fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` 已由 Windows `gpgv` 验证。

Windows x64 首版采用 immutable BtbN `autobuild-2026-06-30-13-34` 的 `ffmpeg-n8.1.2-21-gce3c09c101-win64-lgpl-8.1.zip`：archive 为 144,332,533 bytes，SHA-256 `3b9eceb438016b647e0755a51ce3a388cd4ed5679e2427cb83a01e1ae2cd0eba`，配置 hash `942a04ca7fafc83bb5ffaa5e40a4c74682b77e353b5d3e597d77219c54d04dc6`，GPL/nonfree 关闭、LGPL-3.0-or-later、51 个 external-library flags。它是已通过 packaged matrix 的 initial personal-distribution baseline；此阶段不为缩包引入未验证的 Windows source-build 工具链。QA-005 在把 artifact 分享给他人前核对精确 external-library notices/source offers；这不是 Windows 代码签名门禁。

打包前置脚本必须验证 ffmpeg、ffprobe、runtime manifest 与对应 license/source-offer 证据同时存在，否则构建失败，不能产出“安装成功但无法转写”的发行包。本文不是法律意见；发布前必须完成依赖许可证审计。Windows x64 使用 exact archive/version/config/final PE hashes 与 `unsigned-final-bytes-size-sha256` integrity profile，不能伪称已签名；artifact 获取、审计和 hash 在 staging 前完成，electron-builder 期间不得联网或从开发机随机复制二进制。

### 12.5 用户机器缺失或损坏时的处理

用户无需也不应自行安装或选择 FFmpeg。静态 verified bundle 仅代表校验完成时的时点快照，并公开 `runtimeGeneration = manifestSha256`；应用启动或首次进入工具页时做轻量 runtime probe，每次 batch commit 前都必须重新执行完整静态验证并复核当前 runtime generation：

1. 必需文件/manifest 项缺失时返回 `media_runtime_missing`。
2. 平台、架构、大小、SHA-256、声明的签名/unsigned integrity profile 或版本不匹配时返回 `media_runtime_invalid`。
3. 静态校验通过但 `ffmpeg -version` / `ffprobe -version` 无法受控启动时返回 `media_runtime_launch_failed`。
4. 任一失败都禁用新任务入队，不修改或删除原始媒体；当前窗口仍存活时保留已选文件的内存草稿，不删除安全偏好、`<userData>` 模型或已导出字幕。
5. UI 只提供“检查更新 / 修复或重新安装应用 / 查看脱敏详情”操作；若当前发行渠道不支持原地 repair，就明确引导重新安装同版本或更新版本。重启/重装后不恢复文件 capability，用户需重新选择输入文件，但安全偏好、模型和用户产物仍保留。不得让用户浏览到任意 executable，也不得建议修改 PATH。
6. packaged QA 必须在系统 FFmpeg 被移除或 PATH 隔离的环境中覆盖正常启动、文件缺失、hash 损坏、错误架构和不可执行四类场景。

## 13. 字幕整形与导出

### 13.1 独立 canonical pipeline

runner v1 输出结构化 segment；canonical schema 为未来版本化 word provenance 保留可选字段，但不直接把上游生成的 `.srt/.lrc` 当最终产物：

```text
normalized PCM window plan
  → independent engine request per bounded window
  → raw segment validity gate
  → relative-to-absolute integer timestamps
  → deterministic overlap merge
  → trim/merge whitespace
  → punctuation-aware split/merge
  → enforce monotonic cues
  → SRT/LRC exporters
  → parse-back validation
  → atomic commit
```

raw validity gate 必须位于任何删除、合并或 formatter 之前；否则后处理可能掩盖 decoder loop，却无法恢复锁死期间漏掉的语音。parse-back 仅证明最终序列化结构与 canonical cue 一致，不证明 raw transcript 内容有效。该 pipeline 让 Windows/macOS 和未来不同引擎生成一致格式，也能单独测试窗口覆盖、边界合并和输出时间轴。

### 13.2 字幕整形原则

- 不复制参考项目 `SubtitlesProcessor.py` 的 AGPL 实现。
- 使用全新的规则与测试：按语言选择 CJK/空格分词策略，在标点和词边界处分割。
- 文本统一把 CRLF/CR/U+2028/U+2029 规范为 LF，拒绝 unpaired UTF-16 surrogate、不受支持或会破坏字幕结构的 C0/C1 控制字符；保留合法 Unicode，不用 lossy ASCII 清洗。canonical strict schema 只接受 LF 换行，每 cue 内部换行数量和总字符数受 CORE 上限约束。
- cue 的 `startMs >= 0`、`endMs > startMs`、整体单调不倒退。
- cue 必须落在已校验的 `source.durationMs` 内。whisper/chunk rounding 允许的尾部误差阈值由 PRE 样本冻结：阈值内可 clamp 到 duration 并在 main-only processing report 记录 warning，超过阈值或 clamp 后无正时长则以结构化质量错误失败，不能被丢弃后伪装成 `no_speech_detected`，也不能静默输出越界时间轴。
- 连续相同文本只允许在窗口 overlap 边界按确定性规则仲裁；超出阈值的同文 run 必须在 raw 层触发检查/重试，不能在整形阶段直接去重。
- trim 后的空 segment/cue 不导出；整个文件没有任何非空 cue 时返回 `no_speech_detected`，不生成空 SRT/LRC，也不进入翻译交接。
- 相邻 cue 的轻微重叠按策略裁剪；不能静默制造负时长。
- 默认限制单 cue 时长和文本长度；短 cue 合并需同时满足间隔和阅读长度。
- v1 `segment_only_v1` 没有可信 word producer：segment 无需拆分时保留真实 segment 时间；因 cue duration/text limit 必须拆分时才按 grapheme-safe 字符比例估时，并在 canonical segment 标记 `estimatedTiming=true`。`words` 与 `estimatedTiming=true` 互斥。未来 versioned non-VAD word capability 才能在完整 word provenance/timeline 校验后按真实词边界分割。
- 整形预设和底层参数必须记录到任务 metadata，便于复现。

### 13.3 SRT

- 使用 `HH:MM:SS,mmm`。
- 为保证现有字幕翻译 parser 与常见播放器兼容，首版单文件 duration/cue end 上限为 `99:59:59.999`；ffprobe 或 canonical transcript 超过该值时在开始/导出前返回 `limit_exceeded`，不生成三位小时的非基线 SRT。未来放宽必须先做 parse-back/播放器矩阵并升级合同。
- 序号从 1 开始。
- UTF-8，无 BOM 为默认；如以后支持 BOM，作为显式选项。
- 导出后由独立 parser 回读，验证块数、时间格式和顺序。

### 13.4 LRC

首版默认标准行级 LRC：

```text
[00:01.20]原文
[00:04.38]下一句
```

这与现有 `LRCTranslator` 的逐行翻译和双语同时间标签输出最兼容。

canonical `startMs` 到标准 LRC 百分之一秒标签的投影固定为 `floor(startMs / 10)`，最多提前 9ms、绝不向后移动 cue。分钟字段至少两位但允许随时长增长，秒/百分秒固定两位。两个相邻 cue 量化到同一标签时保留原顺序并输出两行相同时间标签，不能仅因碰撞合并或丢弃文本；parse-back 对比量化后的 centisecond、行数和顺序，不拿 LRC 反推原始毫秒精度。测试覆盖 9/10/11ms、分钟进位、1h+ 和重复标签。

增强逐词 LRC 可作为显式高级格式：

```text
[00:01.20]<00:01.20>word <00:01.56>word
```

增强格式不能默认送入字幕翻译器，因为 LLM 翻译可能破坏内部逐词标签。若用户点击交接，UI 应提示改用标准 LRC 或 SRT。

### 13.5 原子写入与冲突

1. 写入同目录 `.partial`。
2. flush/close。
3. parse-back 校验。
4. 根据冲突策略覆盖或生成带序号文件名。
5. 原子 rename 为最终产物。

索引命名和 overwrite 都必须在 main 的目录级 reservation/mutex 下于 commit 前重新判定，防止两个任务同时选择同一 leaf；不能先删除旧文件再移动 `.partial`。index 可使用 hard-link no-clobber。overwrite 的最终生产合同还必须通过目录句柄相对的原生事务把校验、victim 备份、原子替换和回滚锚定到同一目录对象；仅用绝对路径 recheck + rename 不能证明父目录替换后旧文件仍可用。最终 leaf 仍需 no-follow、containment 和文件类型检查。

多格式输出应以一个 transcript 为源，各格式独立提交；一个格式失败不能删除已经成功的另一个格式，任务按 8.1 的 `completed + partial` 合同展示，不产生第二套隐式状态。

`SUB-002` 已实现 strict formatter/parser、同目录 exclusive `0600` partial 和目录对象级 mutex。partial ownership proof 只使用 device/inode/birthtime，写入中的 mutable size 单独作为内容条件；取消或失败路径只有 `ENOENT` 可视为已清理，identity mismatch 与 unlink failure 必须显式失败。index 模式使用 hard-link no-clobber，成功后先同步解除 temporary link、再冻结 final identity，避免 unlink 改变 inode `ctime` 使新 ref 立即失效；detach 或 Registry activation 失败时先撤销 reservation，并在 identity 仍匹配时同步回滚 final，绝不继续激活 ref。standalone overwrite 组件使用 atomic rename 且不先删除旧文件，Registry activation 可事后拒绝同尺寸换 inode或目录替换后的 ref，但无法恢复已被 replacement directory 吞掉的同名 victim，因此不是 hostile parent replacement 的安全证据，也未接入当前 production admission。每个格式在不可逆 commit 前均可取消，首个 commit 后取消保留既有产物并跳过后续格式；显式 `cancel_failed` 优先于同时到达的 abort，终态仍遵守无 commit 为 failed、已有 commit 为 completed partial warning。

`FS-TXN-001` 当前冻结了 main-private 的同步事务编排边界：branded Coordinator 向 native backend 传入目录路径、预期目录 identity、partial/final leaf、partial identity 与 byte size；backend 必须在同一目录 handle 下完成 no-follow victim receipt 与替换，并返回持有该 handle 的 receipt。Exporter 不在 `begin` 与 Registry activation、activation 与 `finalize/rollback` 之间插入 `await` 或 cancellation check；rollback 必须恢复 victim（或原先不存在）并由 retained handle 删除 exact new inode。若删除失败，receipt 保持 `rollback_pending` 且可重试；只有仍能证明授权路径绑定同一目录对象的 adapter 才可把 new inode 放回 partial leaf 交给 Exporter 做 identity-bound cleanup，hostile parent replacement 下不得依赖绝对路径清理。`begin` 抛错或返回非法值前必须已恢复 victim/partial 并释放所有 handle/backup；backend terminal method 真正开始后抛错必须保留对应 `finalize_pending` / `rollback_pending` 同方向重试 authority，调用前 reentry rejection 不改变状态。terminal成功进入`finalize_pending_ack` / `rollback_pending_ack`，只有main持久化settled后才允许ack删除marker。macOS developer component 已证明 cooperative-writer/APFS 边界下的 native syscall 和 durable process-crash recovery，但不证明 non-cooperative child writer、power-loss 或 packaged 运行时；完整 production 证据完成前双重 gate 不变。

`FS-TXN-001A` 已增加 macOS arm64 plain Node-API developer component：一个 verified directory fd 跨 begin/Registry terminal retained，existing/absent victim 分别用 `RENAME_SWAP` / `RENAME_EXCL`，partial 必须是 identity/size 匹配的 single-link regular file；rollback 删除后继续通过 pinned fd 验证 link count 为 0。post-wrap begin failure 会同步 `napi_remove_wrap + delete`，64 次 permission-denied commit failure 的 fd delta 为 0。真实 addon build/load、`LC_UUID`、existing/absent terminal、retained-dir parent replacement 和 symlink/FIFO/hard-link rejection 已通过。该 checkpoint 关闭 parent path replacement 与 component lifecycle；001B 随后关闭 cooperative-writer child-leaf 边界、terminal fault matrix 与 durable rollback recovery，但 verified staging/load、Windows 与 packaged composition 仍未关闭，所以 main 不注入、production 继续 index-only。

`FS-TXN-001B` 冻结 Darwin child-leaf 与 recovery 边界：本地开发证据先限宿主 APFS 及明确支持 `RENAME_SWAP`/`RENAME_EXCL` 的 volume；HFS+、网络/可移动文件系统和不报告能力的 volume 均不得由一次成功 syscall 推定受支持。FusionKit writer 继续按 directory object mutex 串行化；外部 writer 可在任意 child check/use 间替换 name，后置/重复 identity 检查只能发现部分竞态，不能提供 vnode CAS；identity mismatch 可拒绝，但 name absence 不能证明外部 writer 从未移动对象。001C 将 production surface 升级为 protocol v3，并把 journal 升级为 version 2：`transactionId` 必须与 `.fusionkit-local-subtitle-${transactionId}.partial` 一一对应，journal保存 exact transaction snapshot，recover只接收 opaque ID与重新授权后的目录 identity，自行派生 exact `.open` / `.rollback` leaf，不接受 caller-supplied rollback metadata、不扫描 prefix，也不保存输出 raw path/capability/token。fresh child 在 checkpoint 真正退出并由 fresh process 恢复才算 process-crash 证据；throw 不算 crash，process crash 也不等于断电安全。test-only artifact 只比 production exact exports 多 `testFaultInjection: true`，strict production loader 不接受它。

`FS-TXN-001B` 的历史checkpoint语义是跨进程 durable terminal decision 只有 `rollback_pending`：rollback 的第一次 namespace mutation 前原子发布 intent，fresh process 只重放 victim/absence 恢复与 exact new leaf cleanup。`finalize_pending` 只在当前 native/TypeScript receipt 内锁定同方向重试；Exporter 重试一次仍失败时保留已激活 Registry commit 方向，禁止 revoke 后反向 rollback，但该内存状态不是 durable cross-process commit decision。有效、request-matching 且仍存在的 open journal返回 `decision_required`；malformed、replaced或 request-mismatching journal必须拒绝。finalize crash若发生在 journal unlink后则可能返回 `not_found`，所以001B不提供 finalize-crash recovery。该限制已由下述001F durable decision + terminal marker/ack合同取代，但不得据此把旧测试扩张为power-loss证据。

`FS-TXN-001C` 的历史checkpoint实现了component-level composite recovery owner：唯一 branded owner绑定 native receipt/journal authority、Artifact Registry reservation/activation state与 owner/task/generation/format，持久文件只含 opaque/path-free metadata；Exporter在 begin前准备同进程 handoff，terminal或 Registry未收敛时执行 single-claim adoption，目录 mutex/fence、owner release、shutdown all-settled retry和shutdown后 late adoption均已覆盖。001C prepared handoff只存于进程内 `WeakMap/Map`，既不在 begin前持久化，也不关闭“native已修改 namespace、正式 adopt尚未持久化”时的进程退出窗口；重新授权后的`decision_required`与`not_found`都保留pending record和selection fence。该缺口已由下述001F schema-v2 durable preclaim/decision关闭；GC finalizer仍只能best-effort，不能成为durable owner。

`FS-TXN-001D` 已实现Windows x64 native parity：verified directory HANDLE跨transaction retained，所有child operation都绑定`RootDirectory`并使用`OBJ_DONT_REPARSE`；existing victim用exact hard-link backup + POSIX replace，absent victim用no-replace rename，rollback以identity-bound HANDLE收敛。Windows身份只接受固定宽度lowercase volume serial/FileId；creation time因NTFS tunneling不属于identity，128-bit FileId也不得压成JS safe-number。fresh-process rollback crash/retry矩阵已通过，但finalize crash在该checkpoint仍只保留显式unsupported boundary。`FS-TXN-001E` 已把该identity贯通输出目录authorization、Artifact Registry、Exporter和reauthorization recovery selection。

`FS-TXN-001F` 将当前两平台合同升级为protocol v4 / journal v3。Exporter在调用native begin前先写schema-v2 path-free `rollback_unpublished + not_started` preclaim；begin一旦标记开始，任何adoption/receipt validation失败都不得由`releaseAdoption`删除record。Registry activation成功后把durable decision改为`finalize_committed`；该写盘只允许首次尝试加一次完全相同payload的有界重试，两次都失败时保留receipt、Registry activation、record与directory fence，且不得进入native finalize或回退rollback。fresh-process recovery只按durable decision把exact `.open` 原子发布或续跑为`.finalize`/`.rollback` marker，不再让main从leaf布局猜测方向。native收敛后marker仍保留，main先持久化`nativeState=settled`，再调用receipt/module `acknowledge`，最后删除record并释放fence；任何settled持久化不确定都禁止ack。native finalizer对仍为`.open`的receipt保持方向中立，不得隐式选择rollback/finalize；它只可沿已armed的terminal方向best-effort续跑，pending acknowledgement也不得由finalizer执行ack。pending状态的`not_found`继续fail closed；只有`rollback_unpublished + not_started`可证明begin未建立journal，或已有durable settled proof后的acknowledgement `not_found`，才可作为幂等完成。production main尚未实例化native runtime/repository/owner，也没有reauthorization IPC/UI；verified staging/builder、真实Windows protocol v4与两平台packaged validation完成前，Job Manager/Executor继续只允许index。

Production 已按请求顺序接通 `[SRT]`、`[LRC]`、`[SRT,LRC]` 与 `[LRC,SRT]`；不会把双格式 canonicalize 成固定顺序。每个格式独立完成目录重解析、partial 写入、commit 与 Registry activation，第二格式失败不会撤销第一格式。普通第二格式失败形成无 warning partial；首格式 commit 后取消才以 artifact marker 形成 `cancelled_after_partial_commit` warning。若所有格式都失败，任意 `cleanup_failed` / `cancel_failed` 必须优先成为 task-level error，且取消时逐 artifact 规范化 cleanup code，避免格式顺序掩盖 required cleanup failure。

Artifact Registry 只在 main 保存真实路径、目录/文件 identity、size/hash 与 parser 结果来源，ref 绑定 owner、task、generation、TTL 和 operation。更高 task generation 会原子撤销旧 ref，低 generation 的迟到导出不能重新签发；read/reveal 每次都以 no-follow handle 复核 identity/size/hash/UTF-8/parser，文件或目录替换后稳定返回 `artifact_changed`。`readArtifactText` 与 `revealArtifact` 属于 SUB-002 并已接入 fixed IPC；跨工具 `handoffArtifact`、one-shot import token 与 ref 安全轮换仍严格属于 `LINK-006`，不能由导出器提前实现。

## 14. 与字幕翻译器的可选自动衔接

### 14.1 不共享 Store

本地转写完成后，main 在 `SubtitleArtifactRegistry` 注册：

```ts
interface GeneratedSubtitleArtifactRecord {
  artifactRef: string;
  ownerId: number; // main-private
  ownerSessionId: string; // main-private
  format: "SRT" | "LRC";
  displayName: string;
  outputPath: string; // main-private
  byteSize: number; // main-private integrity metadata
  sha256: string; // main-private integrity metadata
  expiresAt: number;
}

interface GeneratedSubtitleArtifactSummary {
  artifactRef: string;
  format: "SRT" | "LRC";
  displayName: string;
  expiresAt: number;
}
```

main 只把 `GeneratedSubtitleArtifactSummary` 返回 renderer，record 的 owner、路径、size/hash 不跨信任边界。`artifactRef` 是 owner-bound、operation-checked、可撤销的会话级引用，可供结果卡 preview/reveal 或请求交接，但不包含路径且不持久化；清除结果、窗口销毁、应用退出或 TTL 到期即失效。`getSessionSnapshot()` 复用仍有效的 ref；只有 ref 已过期且 completed task 仍保留在同一 main session 时，才在重新核对 identity/size/hash 后清理旧 entry 并签发新 ref。renderer 不能自行 refresh，文件不一致时只返回 `artifact_changed` 摘要。任务移除或 owner session 结束后不再补发 ref。

每次 `handoffArtifact(artifactRef)` 都由 main 以 no-follow/containment 方式重新打开文件，核对 identity、大小、SHA-256、格式、UTF-8、cue 数和固定最大字节数；不一致返回 `artifact_changed`/`content_too_large`，不得导入被替换内容。校验成功后把不可变字幕文本快照放进短 TTL、one-shot `translationImportToken` 对应的 main 内存记录，不再让 token 消费阶段重读路径。消费成功或失败后 token 都不能复用；自动/手动重试必须在 artifactRef 仍有效时重新校验并申请新 token。这样既允许完成卡重试，又不把可重放的跨工具 token 长期留在 renderer。

`displayName` 必须由 main 对最终 `outputPath` 取安全 leaf 后生成，拒绝路径分隔符、`.`/`..`、控制字符、设备名和超长名称；renderer 传回的 fileName 只用于显示，不能参与路径拼接。字幕翻译写入器使用 registry 中的安全 stem，在 target directory 下重新 `resolve` 并做 containment/symlink 检查后再原子写入。

本地工具只把一次性 token 和用户选择的交接模式交给字幕翻译模块公开的 `GeneratedSubtitleImportCoordinator`；它不调用 `useSubtitleTranslatorStore.addTask()` / `startAllTasks()`，也不读取模型 API Key、目标语言、输出目录或任何 `subtitle-translator-*` localStorage key。

### 14.2 “当前配置”的定义与快照时机

“使用字幕文件翻译工具当前的配置”定义为：用户开始本地转写批次时，由字幕翻译模块一次性读取并冻结的配置；同一批次后续逐文件完成时都使用该快照，避免用户中途修改翻译页导致同一批文件使用不同语言或模型。对已经完成的任务手动点击“一键送入字幕翻译”时，则在点击当下重新取一次快照。

快照字段包括：

```ts
interface SubtitleTranslationImportConfigSummary {
  snapshotId: string;
  createdAt: number;
  handoffMode: Exclude<SubtitleTranslationHandoffMode, "export_only">;
  executionBinding:
    | { status: "ready"; taskProfileId: string; taskProfileLabel: string }
    | { status: "needs_configuration" };
  sourceLang: TranslationLanguage;
  targetLang: TranslationLanguage;
  translationOutputMode: TranslationOutputMode;
  sliceType: SubtitleSliceType;
  customSliceLength?: number;
  outputMode: OutputPathMode;
  outputDirectoryLabel?: string;
  conflictPolicy: OutputConflictPolicy;
  concurrentSlices: boolean;
}
```

- `outputMode === "source"` 时，由 main 根据私有 artifact 的父目录派生任务级输出目录 capability；`custom` 时使用字幕翻译工具通过修复后的目录选择器取得、当前仍有效的 translator-owned capability。公开摘要只包含 `outputDirectoryLabel`，不得包含 token 或真实路径。
- 现有持久化 `outputURL` 在分阶段迁移中只用于保持旧版/手动/Agent 恢复扫描行为，不能被自动提升为目录 capability，也不能复制进新配置 Store。先把脱敏 label 和 `needsDirectoryAuthorization` 安全写入新 Store；只有新目录 picker、task target ref、checkpointRef、Agent/RecoveryDialog/tool-executor 等全部消费者和回滚测试都通过后，才能在 `LINK-005` 从旧 Store/localStorage 删除 raw path。任一步失败都保留 legacy 源值并禁用自动 `custom`，不得处于“旧值已删、新值不可用”的半迁移状态。应用重启、capability 过期或授权被撤销后，`custom` 自动交接必须要求用户重新选择目录；不得把旧 raw path 发送到内部授权 channel 重新换取权限。
- 创建快照时，字幕翻译模块尝试从当前 `taskExecution` profile 解析任务执行模型。`enqueue_and_start_translation` 必须得到 `executionBinding.status = "ready"`，并沿用现有 `createSubtitleTaskModelFields()` 逻辑生成私有模型字段；`enqueue_translation` 可以得到 `needs_configuration`，此时导入任务仍可进入 `NOT_STARTED`，但必须带显式“待配置执行模型”绑定，不能用空字符串伪造当前必填的 `apiKey/apiModel/endPoint`。用户在字幕翻译页显式配置/编辑后才可启动。
- 私有快照可在协调器内存中包含执行所需密钥，但不得持久化、不得返回本地转写模块；本地转写 Store 只持有上面的脱敏摘要和不透明 `snapshotId`。`SubtitleTranslatorTask` 在 LINK 阶段需迁移为 `ready | needs_configuration` 的 discriminated execution binding，所有 start 入口先验证为 `ready`。
- Whisper 检测到的语言只作为差异提示，不静默覆盖字幕翻译工具配置的 `sourceLang`。用户选择的翻译配置始终优先。
- 页面需要把当前分散的安全偏好迁移到字幕翻译模块自有的 `useSubtitleTranslatorConfigStore`（或等价读取服务）；API Key 仍归 `useModelStore`，不得复制进该持久化配置 Store。
- `prepareBatch` 必须显式等待字幕配置 Store 和 `useModelStore` 完成 hydrate/migration，再读取一次原子快照；超时或迁移失败返回 `configuration_not_ready` 并阻止批次进入自动交接模式，不能把初始化默认值误当成用户“当前配置”。
- 快照摘要至少展示模型名称或“待配置”、源语言→目标语言、双语/仅译文、切片模式和输出位置。若自动执行所需配置不完整，`enqueue_and_start_translation` 不可启用，并提供前往字幕翻译/模型设置的 CTA；`enqueue_translation` 保持可用但必须明确任务不会自动执行。
- `custom` 模式在 `prepareBatch` 时从当前目录 capability 派生 snapshot-bound batch lease；用户随后修改字幕翻译页目录不会改变已启动批次。lease 只能在同 owner、窗口存活且批次仍 active 时由 main 有界续期，并设最大墙钟寿命；过期后后续文件交接失败并要求重新授权，不能从 label/旧路径续权。
- 私有快照生命周期绑定本地转写批次，批次结束、取消、窗口销毁或超时即释放；它不能放进 localStorage。当前首版不续跑未完成文件，因此应用重启后不得尝试使用已经失效的快照静默自动翻译。

### 14.3 导入与精确启动流程

1. 批次启动先校验 draft 成员并暂存模型锁和输出 lease，再由字幕翻译导入协调器做配置预检；成功后把不透明 `snapshotId`/摘要写进不可变本地 batch snapshot，最后一次性 commit 为 active。任一环节失败都按逆序释放 start-scoped translation snapshot/local lease/model lock，不能留下“翻译快照已占用但本地批次未启动”的半提交状态；仍显示在 draft 中的 input refs 回到 draft 所有权，方便修复配置后重试，只有用户清空/离页时才撤销。
2. 每个文件完成标准 SRT/LRC 原子导出后，main 在 `SubtitleArtifactRegistry` 注册产物并校验 owner、文件存在、扩展名和内容格式。
3. `handoffArtifact()` 创建一次性 `translationImportToken`；协调器以该 token 和 `snapshotId` 消费产物。
4. main 消费 token 后生成候选 `taskId`/`handoffKey`，只向协调器返回已校验的字幕内容、展示名、无路径 source 标记和不透明 target 引用，不返回真实路径；协调器必须使用该 `taskId` 构造字幕翻译任务、尝试计算初始费用估算并通过字幕翻译队列的批量导入 API 入队，最后返回包含新增、未启动、等待、已启动及失败明细的 `SubtitleTranslationImportReceipt`。
5. `enqueue_translation` 到此结束，任务保持 `NOT_STARTED`。若 snapshot 为 `needs_configuration`，任务卡必须显示待配置状态，所有 start 入口返回 `configuration_required`，直到用户显式绑定有效 profile 后才可执行。
6. `enqueue_and_start_translation` 只能调用新的 `startImportedTasks(addedTaskIds)`（或逐一调用等价精确 API），沿用现有最大并发与 `WAITING` 队列；不得调用 `startAllTasks()`，否则会意外启动用户此前手动放在列表中的任务。
7. import token 消费后立即失效。只有 `addedTaskIds` 对应的 target handle 才把所有权转给字幕翻译器；duplicate、校验失败、add 失败或协调器异常的候选 handle 必须立即撤销，不能等待 TTL。导入不要求自动跳转页面，但完成卡片应提供“查看翻译任务”。

本地批次取消只停止尚未完成的转写和未来交接，不取消已经出现在 `addedTaskIds` 的字幕翻译任务；这些任务已由字幕翻译器拥有，用户需在字幕翻译页单独取消。取消与 import commit 竞态以原子回执为界：commit 成功则保留并展示 taskId，commit 前取消则撤销候选 handle 且不入队，不能出现“实际已入队但本地 UI 显示未入队”的未知状态。

导入 API 必须返回实际新增任务身份，`SubtitleTranslatorTask` 必须增加稳定 `taskId`；`fileName` 只用于展示，不能再承担 queue operation、active-task tracking 或重复判定。main 为每个 artifact/format/snapshot 组合生成不含路径的 `handoffKey`，同一交接重试只允许入队一次。handoffKey 的提交必须与任务入队原子完成：入队前失败不占用 key，允许新 token 重试；任务已入队但回执丢失时，同 owner/snapshot 的精确重试返回缓存的原始不可变回执，既不再建任务也不再次发起 start；同 key 但 task/content/owner 不一致则作为冲突拒绝。receipt registry 至少在 snapshot 生命周期内保留该 key，即使用户删除已入队任务也不能让自动重试静默重建。不同路径的同名文件、同一基名的 SRT/LRC 或用户明确创建新快照后重新交接都不能被误判为旧任务。自动执行只使用 `addTask` 回执中的 `addedTaskIds`。

建议的协调器与回执合同：

```ts
type AutomaticSubtitleTranslationHandoffMode = Exclude<
  SubtitleTranslationHandoffMode,
  "export_only"
>;

type PrepareGeneratedSubtitleImportResult =
  | {
      ok: true;
      snapshot: SubtitleTranslationImportConfigSummary;
      canAutoStart: boolean;
      warnings: string[];
    }
  | {
      ok: false;
      code:
        | "configuration_not_ready"
        | "directory_authorization_required"
        | "profile_required";
      warnings: string[];
    };

interface GeneratedSubtitleImportCoordinator {
  prepareBatch(
    mode: AutomaticSubtitleTranslationHandoffMode,
  ): Promise<PrepareGeneratedSubtitleImportResult>;
  importArtifact(request: {
    translationImportToken: string;
    snapshotId: string;
  }): Promise<SubtitleTranslationImportReceipt>;
  releaseBatch(snapshotId: string): Promise<void>;
}

interface SubtitleTranslationImportReceipt {
  receiptId: string;
  snapshotId: string;
  addedTaskIds: string[];
  startedTaskIds: string[];
  waitingTaskIds: string[];
  notStartedTaskIds: string[];
  startFailures: Array<{
    taskId: string;
    reason:
      | "estimate_failed"
      | "configuration_required"
      | "profile_unavailable"
      | "authorization_expired"
      | "start_rejected";
  }>;
  skipped: Array<{
    displayName: string;
    reason:
      | "duplicate"
      | "unsupported_format"
      | "artifact_expired"
      | "artifact_changed"
      | "content_too_large"
      | "invalid_content";
  }>;
}

interface GeneratedSubtitleTranslationTaskRefs {
  taskId: string;
  handoffKey: string;
  source: {
    kind: "generated_content";
    displayName: string;
  };
  target: {
    kind: "authorized_directory";
    token: string;
    displayLabel: string;
  };
}
```

`export_only` 不创建翻译快照。其余两种模式只在 `prepareBatch` 成功时获得 snapshot，且 `handoffMode` 在 snapshot 内冻结；`importArtifact` 故意不接收 `autoStart`，调用方不能把 enqueue-only 快照临时升级为付费执行。预检失败时 UI 可让用户修复配置，或明确改选较低权限模式并重新 prepare；不能静默降级后继续显示原模式。`releaseBatch` 必须 await，失败时沿用 capability cleanup 的有界重试；它撤销 snapshot、batch lease 和未转移候选 handle，但不得撤销已经出现在 `addedTaskIds`、所有权已转给字幕任务的 target handle。

`profile_required` 只允许由 `enqueue_and_start_translation` 的 prepare 返回；`enqueue_translation` 缺少 profile 时必须成功生成 `needs_configuration` snapshot，而不是走失败分支。`directory_authorization_required` 只在当前 snapshot 确实需要 `custom` target 且无有效 translator-owned capability 时返回。

回执必须满足集合不变量：`startedTaskIds`、`waitingTaskIds`、`notStartedTaskIds` 两两不交且并集恰好等于 `addedTaskIds`；`startFailures[].taskId` 只能出现在 `notStartedTaskIds`，`skipped` 项不能伪造 taskId。`enqueue_translation` 的全部新增任务进入 `notStartedTaskIds`；`enqueue_and_start_translation` 才允许出现 started/waiting，任何竞态或部分失败都通过同一不可变回执表达，不能靠 UI 猜测队列状态。`started` 只表示执行请求已被接受，不表示翻译成功；请求接受后的 API/解析/写入失败走原有任务失败状态，不回写或篡改导入回执。

`taskId`、`handoffKey` 和 target handle 都由 main 在消费 import token 后一次性生成，协调器不得替换 ID 或把 handle 绑定到另一个任务。生成任务的 `source` 只是“内容来自已校验生成产物”的无路径标记；字幕文本已在消费一次性 `translationImportToken` 时读入会话级任务，后续执行不再需要 source path 或第二个 source token。`target.token` 才是 main 随导入签发的 task-scoped directory handle，和一次性 import token 不是同一个 token。它绑定 owner、`taskId`、写操作和有界会话租约；任务未入队、终态、删除、窗口销毁或租约超时即撤销，写入前仍要重新校验目录和 owner。租约过期后启动任务必须返回 `authorization_expired`；字幕翻译页提供固定的“重新授权输出目录”，main 只允许为同 owner、仍在队列且未终态的同一 `taskId` 原子轮换 target handle，成功后立即撤销旧 handle。不得用显示名、历史路径或快照静默续权，也不得借重授权改变 `taskId`/`handoffKey`。

生成字幕任务在 renderer/Store 中只保存上述无路径 source 标记和不透明 target 引用；真实 target path 只在 main 的翻译执行适配层解析，source path 从不进入任务。现有手动/历史恢复任务可在兼容期继续使用 path 字段，但 schema 必须禁止 generated source 或 authorized target 同时携带 path 和 token，且自动交接不得通过“先换出 raw path、再填旧字段”绕过该边界。生成任务的恢复清单不得持久化 artifact path 或 capability token；已启动任务一律使用自包含的 `manifest_fragments` 保存恢复输入，renderer 侧的 `checkpointPath` 替换为 main 签发的 owner/session-bound `checkpointRef`。跨重启时用户通过固定恢复文件选择/扫描入口重新取得 ref，并重新授权目标目录；main 只返回展示信息和恢复摘要，不返回 manifest/output path。尚未启动的 `enqueue_translation` 任务沿用现有字幕翻译队列的会话级语义：应用重启后不恢复该队列，已导出的 SRT/LRC 仍保留，用户可重新手动导入。缺少自包含分片或新目录授权时，把任务标记为需要重新导入/授权，而不是猜测路径或静默扩权。

这次类型迁移不能只改 SubtitleTranslator 页面。当前 `src/agent/tool-executor.ts`、`src/agent/recovery-batch.ts`、`src/agent/tool-schemas.ts`、`src/pages/Tools/Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx`、`src/renderer/subtitle.ts` 以及 `electron/main/translation/*` 都直接消费 `originFileURL`、`targetFileURL`、`checkpointPath` 或 `outputURL`。`LINK-003` 先引入 target ref 与显式 legacy adapter，`LINK-004` 迁移普通/Agent 新建任务生产者，`LINK-005` 再迁移恢复扫描、事件 payload 和 checkpoint 合同；完成所有消费者回归后才删除 `outputURL`。兼容期的 `legacy_path_v1` discriminant 只能进入既有历史恢复入口，main 已登记的 generated `taskId` 一律拒绝该分支，避免本地字幕交接借兼容层回退为 renderer raw path。

Agent 迁移不能把任意模型参数中的 `roots`/`checkpointPaths` 直接换成“内部授权”。新建/恢复任务必须消费 main 固定 picker、用户确认的扫描动作或既有 main-owned scan receipt 签发的 opaque `subtitleSelectionRef` / `recoveryScanId` / `checkpointRef`；工具 schema、Agent 提示与确认 UI 同步更新。未经过用户确认或 main receipt 的 renderer raw path 明确拒绝，不能为了保留旧 Agent 参数静默扩权。

### 14.4 用户费用、失败与重试

- 默认始终是 `export_only`；记住自动执行偏好时仍应在每个新批次开始前展示模式，不得把一次授权升级为全局静默调用外部 API。
- `enqueue_and_start_translation` 是对当前批次的明确授权。启动前展示配置摘要和费用提示；得到字幕内容后的精确预计费用写入字幕翻译任务并可在翻译页查看。
- `enqueue_translation` 可以在未配置任务执行模型时使用，但任务必须使用显式 `needs_configuration` execution binding，摘要提示“加入后需配置模型”；`enqueue_and_start_translation` 必须有可用的任务执行 profile 和 API Key，禁止把空字段任务当作 ready。
- `enqueue_translation` 的费用估算失败不阻止入队，任务保留 `costEstimate.loading = false` 和可重试提示。`enqueue_and_start_translation` 若精确估算或启动前校验失败，任务仍保留在 `NOT_STARTED`，写入 `notStartedTaskIds`/`startFailures`，不得调用外部 API，也不得撤销已入队任务仍持有的 target handle。
- 导入失败、token 过期、重复项、翻译启动失败或后续翻译失败，都不回滚、不删除已导出的 SRT/LRC，也不把本地转写任务从 `completed` 改为 `failed`。
- 自动导入失败时保留完成卡片和有效 `artifactRef` 的可重试路径；用户可修复字幕翻译配置后，按当时的当前配置重新 prepare，并申请新的 one-shot import token 执行手动交接。
- 一批中只对成功导入的项请求启动；部分失败不阻断其余项，也不清空字幕翻译器原有队列。
- `enqueue_translation` 只保证加入当前会话的现有内存队列；应用重启不会恢复尚未启动的自动导入任务。产品必须在模式说明和完成回执中明确这一点，不能把“加入列表”表述为跨重启持久化。

## 15. 持久化、恢复与资源清理

### 15.1 Renderer 持久化

只保存：

- 最近模型 ID。
- device preference（建议 `auto`）。
- 语言、VAD、质量预设、字幕整形和输出格式偏好。
- 输出模式和安全的目录显示名，不保存授权 token。

不保存：

- `File`、真实路径、输入 token、输出 token。
- 初始提示词和其他可能包含用户内容的自由文本推理参数。
- segment/word 全量结果。
- runner stderr、临时 WAV 路径。

`CORE-004` 将 Store key 固定为 `fusionkit-local-subtitle-transcriber`，版本 1 的 persisted envelope 只包含经过逐字段 sanitize 的 `preferences`。安全白名单精确为 `modelId`、device preference、language、VAD enable、quality preset、beam size、temperature、VAD 最短静音、cue/line shaping、output formats、output mode 和不含分隔符的目录显示名。默认值固定为 beam `5`、temperature `0`、VAD silence `500 ms`、最大 cue `7000 ms / 84 chars`、最大行 `42 chars`；invalid/malformed 值逐字段回退。post-action、task mode、conflict policy、handoff format、初始提示词、File、token、task/batch/resource state、artifact、transcript、path、diagnostics 与 revision/tombstone 一律只存在当前 renderer session 内存或 main 权威状态，不进入 persist/migrate/merge。

草稿文件或 custom output 被替换、截断、重置或切回 source mode 时，Store 必须先把 capability 交给 renderer runtime cleanup queue，再清理 UI 引用；batch commit 成功则只消费 draft 引用，不撤销已经转为 task lease 的 capability。cleanup 使用 capability 的权威最早 expiry、有限退避和单次超时；rejected Promise、`ok:false` 与 timeout 重试，`ok:true`（包括 `revoked:false`）、`owner_released` 和 `authorization_expired` 终止。singleton 不因 SPA 页面卸载而销毁；在真实 Job Manager/session handler 接入前不从应用入口急切启动。

### 15.2 任务恢复

首版任务队列为会话级。异常退出后：

- 已原子提交的 SRT/LRC 保留。
- 受控 `<userData>/local-subtitle/temp` 内的临时 WAV/partial 可在下次启动按 identity/schema 清理。任意用户输出目录的真实路径不持久化，也不能在重启后全局扫描；SUB-002 保证正常失败、取消和未 commit 分支清理同目录 `.partial`，进程在写入与清理之间崩溃时仍可能留下隐藏的 `.fusionkit-local-subtitle-*.partial`。未来若要跨重启回收这类文件，必须使用 main-only、有界、经用户授权的 cleanup receipt，不能为方便扫描而把输出路径写入 renderer Store/session manifest。
- overwrite recovery repository使用schema v2，只保存opaque recovery ID、owner fingerprint、task/generation/format、`rollback_unpublished | finalize_committed` decision、`not_started | pending | settled | retry_failed` native state与时间戳；不保存raw path、capability、token、leaf或Registry ref。原子rename后若parent sync失败，只有exact payload read-back一致才可接受，且不得把这项验证扩张为power-loss声明。重启后必须由用户重新选择输出目录并重验directory object，再按exact ID lazy recover；pending状态的`not_found`保留recovery record和已选目录fence，只有not-started rollback preclaim或已有durable settled proof后的acknowledgement `not_found`可幂等完成。native terminal marker必须在settled持久化成功后才ack，最后才删除record并释放fence。当前这套owner/repository/reauthorization只完成组件合同，production main/IPC/UI尚未接线。
- 未完成任务显示为上一会话中断的诊断摘要，用户需重新选择/授权源文件后从头重试。
- 不声称支持文件中间断点续跑。

写入磁盘的 session diagnostic manifest 只保存 schema version、task/batch id、脱敏 display name、阶段/终态、格式、backend/build id、时间与稳定错误 code；不得保存 source/output/model/temp 绝对路径、capability/token、字幕文本、segment/word、命令行或 API Key。内部 temp 清理只扫描受控 `<userData>/local-subtitle/temp` 根下符合 UUID/age/schema 的条目，不依赖持久化任意路径。由于 artifact registry 不跨重启，重启后的摘要不提供 reveal/自动交接；用户重新选择已生成字幕后再导入。

### 15.3 内存与显存

- runner 每完成一个文件就把 canonical transcript 交给 main 并释放 PCM。
- main 导出后不长期持有全部批次的 word 数组；结果预览可分页或只保留摘要。
- 同一模型跨任务驻留；用户切模型、显存不足、空闲超时或应用进入更新时卸载。
- GPU 队列默认并发 1。CPU 并发属于后续高级能力，不能与 `num_workers` 混为一谈。

### 15.4 Session lifecycle 与清理顺序

owner release 使用固定顺序 `Job Manager → Media Normalizer → Server Supervisor → Model Manager → Session Registry`。Job Manager 必须最先 fence 新 admission、队列和活动任务，Session Registry 必须最后释放，以便其余 owner 在收敛过程中仍可完成权威状态结算；任一 target 同步失败都只保存首错，不能阻止后续 target release。

app quit、update 与 fatal shutdown 固定分为三个顺序阶段：

1. `Job Manager + Model Manager` 并行 quiesce，阻止新增任务/资源工作并等待活动 operation 收敛。
2. `Media Normalizer + Server Supervisor` 并行 cleanup，释放 private PCM/session、native request 与 child process。
3. `Session Registry` 最后 finalize。

每个并行阶段都使用 all-settled 语义；前一阶段失败后仍必须无条件执行后一阶段，最后再抛出按 target/phase 顺序保存的首个错误。不得写成 `firstFailure ??= await cleanupPhase()`，因为已有首错时会短路整个 cleanup；应先单独执行并保存 phase result，再合并错误。composite shutdown Promise 必须在调用任何 target 前缓存，使同步 reentry、abort listener 和并发调用观察同一个 operation；失败后允许显式重试，成功后稳定复用 resolved operation。`LocalSubtitleMainRuntime` 与 `LocalSubtitleServerAppLifecycle` 的 wrapper 采用相同的 pre-cache 规则。

## 16. 打包与发布

### 16.1 建议资源布局

```text
resources/local-subtitle/
  manifests/local-subtitle-runtime.v1.json
  win-x64/cpu/whisper-server.exe
  win-x64/cpu/*.dll
  win-x64/cuda/whisper-server.exe
  win-x64/media/ffmpeg.exe
  win-x64/media/ffprobe.exe
  mac-arm64/metal/whisper-server
  mac-arm64/media/ffmpeg
  mac-arm64/media/ffprobe
  licenses/...
```

开发环境和 packaged 环境统一通过一个 `resolveLocalSubtitleResourcePath()` 解析，不在业务代码散落 `process.cwd()` 或相对路径。CORE-002 已固定开发态 `<appRoot>/build/local-subtitle-resources/local-subtitle` 与 packaged `<resourcesPath>/local-subtitle` 两个唯一 root；runtime manifest 覆盖每个 runner、动态依赖、FFmpeg/ffprobe 的平台、架构、backend、相对路径、size、SHA-256、版本、许可证引用和 integrity profile，并拒绝 lexical/realpath 逃逸及任意 parent symlink。

### 16.2 electron-builder

- 使用 `extraResources` 放到 asar 外。
- macOS 保留可执行位，并在签名/公证前放入最终 app bundle。
- macOS 先对最终 staging 中的 nested executable 完成签名和严格验证，再计算 size/SHA-256 并生成 manifest；外层 app 签名必须排除这份已冻结 runtime，签名后重新比对全部 hash 并执行独立 deep/strict 验证。
- Windows runner、DLL、FFmpeg 和许可证一起进入资源清单。
- 平台产物名保留 `${arch}`，避免 Windows/macOS 或不同 runner 资源互相覆盖；macOS 只生成 arm64 产物。
- `beforePack`/staging 门禁验证目标平台所需 runner、FFmpeg、ffprobe、manifest 和 license/source-offer 证据；任一缺失、hash 不符或架构错误都必须让打包失败。
- 不构建一个同时塞入所有平台二进制的超大通用安装包。

### 16.3 更新兼容

- app version、official server release/build、engine commit、runtime contract version、model manifest version 分开记录。
- 新 app 启动时先检查 runtime manifest、server launch/health 与 response contract，再允许任务。
- 模型兼容时保留；不兼容时提示重新下载或迁移，不静默删除数 GB 模型。
- accelerator pack 必须按 distribution profile 校验固定来源、archive size/SHA、逐文件 manifest 与安全解包；public profile 采用签名时再验证签名。personal profile 不要求 OS 代码签名，但也不能只靠文件名判断可信。

## 17. 安全、隐私与许可证

1. 推理全程默认离线；只有模型/加速包下载访问网络。
2. 下载 UI 显示来源、大小、版本和校验状态。
3. 不上传媒体、文本、时间戳或模型使用信息，除非未来另有明确 opt-in 设计。
4. 诊断日志对用户路径只显示 basename 或稳定 hash；不记录媒体内容。
5. server 只监听 `127.0.0.1` 临时端口，使用随机私有 request path 和空静态目录；端口/path 不暴露给 renderer，普通推理不访问外网。
6. server 只接收 main 生成的私有临时 WAV；renderer 无法让它执行任意 binary、URL 或参数。
7. runner/FFmpeg 使用最小 allowlisted environment 和受控 cwd，不继承 Electron/Agent 的 API Key、header 或其他 secret；自定义模型 load smoke 使用短生命周期验证 runner，崩溃只得到脱敏错误。
8. `faster-whisper-GUI-main` 为 AGPL-3.0，只做 clean-room 行为参考。
9. `whisper.cpp` 与 `faster-whisper` 上游为 MIT；模型、FFmpeg、CUDA runtime、VAD 模型和发布二进制仍需逐项进入 `THIRD_PARTY_NOTICES` 与许可证审计。
10. 参考项目本地配置中出现的明文 token 不得复制到文档、测试 fixture 或提交历史。
11. 本地转写自己的 Store/session manifest/log/crash artifact 不保存字幕正文或 segment/word。唯一明确例外是用户已经启动字幕翻译后，为无路径恢复而写入的 v2 `manifest_fragments` checkpoint：它可以包含完成/待处理的字幕文本分片，但不得包含原始音视频字节、source/target/checkpoint 绝对路径、capability/token、API Key/header 或模型凭据。产品需明确这是本地恢复数据；首版在最终译文原子提交成功后删除内容 checkpoint、只留脱敏完成摘要，失败/取消时保留以便恢复，用户删除任务时一并清理。尚未启动的 enqueue-only 任务不创建 checkpoint。

## 18. 分期实施建议（高层阶段）

本节保留架构层面的阶段划分；可认领的工作包、依赖、状态、验证和实施记录以 `local-subtitle-transcriber_execution_plan.md` 为唯一执行台账。Execution Plan 已于 2026-07-16 建立，当前 39 个顶层工作包中16个已完成、23个剩余（`FS-TXN-001`与`BE-002`进行中，21个未开始）。M1 的 schema、resource staging、IPC/capability、renderer session、official server contract、真实 Supervisor 生命周期、media normalization/PCM proof、canonical post-processing、标准字幕原子产物和 managed model 合同均已冻结。`BE-002` 的 index-only production 批次已形成；`FS-TXN-001A`～`FS-TXN-001F` 已完成两平台developer components、protocol v4 / journal v3、schema-v2 durable preclaim/decision、terminal marker + acknowledgement、composite owner/exact reauthorization recovery、Windows x64 HANDLE-relative/lossless FileId与cross-platform exact identity composition，component checkpoint不增加顶层工作包数量。总包仍等待production main/IPC/UI composition、generation-bound verified staging/load、builder、真实Windows protocol v4与两平台packaged validation。在这些证据完成前production overwrite不可用，Job Manager/Executor双重`index-only` gate保持。`NATIVE-002`、`MODEL-002` 与 `LINK-001` 可按各自里程碑继续推进。Windows personal distribution 的 unsigned profile已明确；Developer ID、公证和 Gatekeeper accepted只由未来 `QA-004` 验收macOS分发产物。

其中本节原先汇总为一个 `PRE-001` 的跨平台 PoC，在 Execution Plan 中拆为 `PRE-001`～`PRE-006`，以避免把基准、CPU runner、Windows CUDA、macOS Metal、FFmpeg/打包许可和最终技术冻结塞进一个无法单会话闭环的工作包。其余高层包也在执行计划中按安全边界和可验证纵向切片进一步拆分。

### PRE-001：开发启动基线（已完成）

- 固定 3 段中/日真实样本的媒体 integrity 和 SRT/LRC 时间轴摘要。
- 验证 macOS arm64、Windows x64 CPU/CUDA 三个目标环境在各自声明 scope 下 ready。
- 固定 Windows 官方 `whisper.cpp v1.9.1` CPU/CUDA PoC 资产；CPU ZIP 完成 hash/help launch smoke。
- 明确 CMake/MSVC 不是 PRE-001、PRE-002 或最终用户前置；只有实际选择 source-build artifact 时才由构建机/CI 提供。
- 明确现有字幕只用于格式/时间轴 smoke 与人工对照，不做 FasterWhisperGUI 一致性或文本准确率基线。

PRE-001 已解锁 runtime 开发，PRE-003 已确定 Windows CPU/CUDA，PRE-004 已确定 macOS arm64 Metal/CPU 与最终窗口/VAD 时间轴策略，PRE-005 已形成 bundled media/staging 证据，PRE-006 已将这些结果冻结为唯一 production 基线。

### PRE-002：Node-managed official server（已完成）

- 固定并检查 `whisper.cpp v1.9.1` 官方 Windows x64 预编译包中的 `whisper-server.exe`。
- Node supervisor 已验证 loopback/private path、最小环境、`/health`、`verbose_json`、AbortController 与退出清理。
- 同一 CPU server/model 进程完成 3 个现有中/日样本；模型加载一次，取消后健康且可继续转写。
- 决定首版不写 FusionKit C++/JSONL runner；PRE-006 已接受阶段式进度为 HTTP contract v1。

### PRE-003：Windows x64 CPU/CUDA（已完成）

- 固定官方 `whisper.cpp v1.9.1` CPU/CUDA 预编译资产与公开 `large-v3-q5_0` 模型；模型只按需下载，不进入 Git 或默认安装包。
- 现有 3 个中/日样本在 CUDA 上全部快于实时，精确 PID 显存证据确认没有假 GPU 成功；CPU fallback 也全部快于实时。
- 同一模型进程完成多个正常任务；取消请求快速结算，但下一任务固定先重启 server，不能把 `/health` 当作底层推理已收敛的证明。
- SRT 和标准 LRC 均由独立 parser 回读；开发阶段内容抽查可读，最终产品质量由用户在实现完成后实际使用验收，不作为后续开发阻塞项。
- Windows 默认安装包采用小体积 CPU runtime；约 1.2 GB 解压占用的 CUDA runtime 已冻结为固定官方来源、archive/逐文件校验、按需安装的 accelerator pack。personal profile 不要求 Authenticode。
- 通过缺失 `cublas64_12.dll` 探针证明官方 server 可能静默使用 CPU；产品必须以 exact-PID GPU 证据判定 backend，未验证时显式 fallback，不得宣称 CUDA。

### PRE-004：macOS arm64 Metal/CPU（已完成）

- macOS 无官方预编译 server，候选固定为精确 `whisper.cpp v1.9.1 / f049fff` 源码构建；`arm64`、`BUILD_SHARED_LIBS=OFF`、`GGML_NATIVE=OFF`、`GGML_METAL=ON`、`GGML_METAL_EMBED_LIBRARY=ON`，不预设 FusionKit 自写 C++ runner。
- thin arm64 runner 只有 8 个系统 Framework/`/usr/lib` 动态依赖，Metal library 内嵌、可执行位保留，staged resource 中无 macOS x64 artifact。源码必须来自自身 Git clone/worktree；无 `.git` 的 tar 解压目录会错误继承祖先 FusionKit commit，不能作为 provenance 证据。
- 相同 `large-v3-q5_0` 与 3 个真实样本在最终有界窗口策略下全部完成：Metal RTF 0.0698～0.0821，显式 `--no-gpu` CPU RTF 0.1954～0.2811。正常请求各自复用一个 PID/一次模型加载，语言检测、raw validity 和 SRT/标准 LRC 结构回读通过；取消快速返回 `aborted`，后续任务仍固定重启 server。
- Metal 只有同时观察到有界初始化与 device 诊断、且无失败标志才是 verified；`/health` 或文件名不构成证据。显式 Metal 未验证时返回 `backend_unverified`，auto 只能在 batch commit 前解析为 CPU 并显示性能提示。
- Apple M5 最终策略上 CPU 比 Metal 慢约 2.57～3.42 倍；这是首个提示范围，不外推为所有 Apple Silicon 的固定承诺。
- raw `verbose_json` 证明整段策略不可用：Metal 日文长音频曾从 405.52 s 起连续重复 347 段，Metal/CPU 中文分别重复 77/43 段，CPU 长音频曾越界约 27.89 s。最终方案先一次性规范化 PCM16，再按 30 秒窗口/5 秒 overlap 做独立请求、owned-core 合并、raw gate 和最多 3 层有界拆短重试；不通过删除重复行、beam 或参数碰运气掩盖丢失语音。
- VAD 消除了纯静音窗口的短幻觉，但 v1.9.1 只有 segment 时间被映射回原媒体，token/word 时间仍处于去静音后的压缩时间轴。production v1 的 VAD/非 VAD 请求因此均固定 `token_timestamps=false`，parser 不向后处理暴露 words。未来 word path 必须先定义 versioned capability、可信时间域 provenance 和 validation/failure policy。最终矩阵 raw 时间轴错误为 0、最长连续重复最多 2 cue，长音频 `600～630 s` 为空且后续台词和媒体尾部恢复。
- staged runner 的资源路径、可执行位、thin arm64 和系统动态依赖通过；ad-hoc 签名/Gatekeeper rejected 只记录当前未采用的公开无警告分发能力。Developer ID、公证和 Gatekeeper accepted 由 `QA-004` 对真实发布产物验收，不阻塞 PRE-004。

### PRE-005：Bundled FFmpeg、runtime staging 与许可（已完成）

- macOS arm64 已固定 FFmpeg 8.1.2 最小 LGPL build recipe、源码 archive/hash、detached signature/key hash、完整 fingerprint、macOS 11 target、稳定逻辑 prefix 与 source-offer/notice；detached signature 已在 Windows 通过 `gpgv` 以完整固定 fingerprint 真实验签。
- `whisper-server`、`ffmpeg`、`ffprobe` 在最终 staging 中先完成 nested ad-hoc signing，再冻结 size/SHA-256 和 versioned runtime manifest；外层 app 签名排除 frozen runtime，签名后全部 hash 不变且独立 deep/strict 校验通过。
- ignored electron-builder spike 通过 `extraResources` 把 runtime 放在 asar 外；正向 arm64 build 成功，配置生成后删除 `ffmpeg` 的反向 build 在 `beforePack` 返回 `media_runtime_missing`，没有产生 `.app`。
- packaged no-PATH smoke 通过 mp3/wav/flac/aac/m4a/mp4/mkv/mov/webm、真实视频轨、多音轨、非 ASCII/225 字符路径、损坏/零时长输入和机器可读进度；缺失/损坏/错架构/无执行位/启动身份错误均在 enqueue 前映射为稳定 runtime error。
- Windows x64 已固定 immutable BtbN LGPLv3 candidate；15 个 PE 使用 explicit unsigned profile，在 final bytes 上冻结 size/SHA/manifest。x64 `dir` positive build、missing-ffmpeg negative build、packaged no-PATH 9 格式/多音轨/长路径/9 类 fault matrix 均通过，外层 `FusionKit.exe` 保持 `NotSigned`；未创建证书或修改信任库。
- PRE-005 已完成。Windows unsigned 包可供本人或朋友安装使用，但可能出现 Unknown Publisher / SmartScreen 提示，受管设备策略或安全软件也可能拦截；若未来要求公开低提示分发，再由可选 `QA-003` 覆盖受信任 installer 签名/timestamp。Developer ID、公证和 Gatekeeper accepted 仍归 `QA-004`。

### PRE-006：Production 技术冻结（已完成）

- `whisper.cpp v1.9.1 / f049fff` 与 Node-managed official server HTTP contract v1 固定；私有 loopback、单活动请求、模型复用、取消后重启和阶段式进度进入后续合同，首版不建 native bridge。
- Windows x64 默认 CPU、可选 CUDA 12.4 on-demand pack；macOS arm64 默认 Metal、显式 CPU fallback；auto 只在 batch commit 前可见解析，显式 GPU 不静默降级，macOS x64 固定 `unsupported_architecture`。
- macOS 固定 FFmpeg 8.1.2 最小 LGPL source build；Windows 固定 immutable BtbN LGPLv3 initial personal baseline。两者均先 acquire/audit/hash 后 staging，electron-builder 不联网、不回退 PATH，artifact 名保留架构。
- 首发内置 model manifest 只包含 `large-v3-q5_0`，VAD 固定 Silero v6.2.0；两者都不进安装包，按 exact revision/URL/size/SHA 下载并在 load smoke 后原子提交。未量化 large-v3 与 turbo 变体延后。
- Windows/macOS CPU/GPU RTF 均 < 1，30 秒窗口/5 秒 overlap 的 raw quality gate 通过；接受 Windows 789,147,424-byte unpacked baseline、1,209,487,872-byte optional CUDA pack 和 1,081,140,203-byte launch model，并要求 UI 展示磁盘占用。
- 决策记录为 `poc/pre006-production-decision.json`，五项均为 `go`，无 PRE blocker，解锁 `CORE-001` / `CORE-002`。QA-005 仍是向他人分发前的精确 notices/source-offer/NVIDIA DLL 门禁，但不会引入 Windows 代码签名要求。

### CORE-001：domain、状态机、事件、错误与 runtime schema（已完成）

- `src/type/localSubtitle.ts` 固定 PRE-006 pins、版本/上限、immutable batch snapshot、状态机、full/partial/none-success reducer、task generation/session revision、post-action、canonical transcript 与单一 error manifest。
- `src/type/localSubtitleIpc.ts` 只组合 strict renderer/main request、control request、IPC result、task/resource event、session snapshot 与 transcript schema；unknown field、raw path、executable/args/backend flags 和未发布 Vulkan 均拒绝。
- preload channel/owner capability 留给 `CORE-003`，official server HTTP response parser 留给 `NATIVE-001`，runtime/resource manifest 文件 schema 和 resolver 留给 `CORE-002`，没有跨包预实现。
- 57 项定向测试覆盖 PRE-006 drift、10×10 状态迁移、completion、取消、revision/generation、post-action/status 跨字段约束、UTF-8 frame/diagnostics、round-trip 和 Audio 隔离；TypeScript 通过。

### CORE-002：资源 manifest、路径 resolver 与构建 staging 合同（已完成）

- `resource-manifest.ts` 与 `resource-path.ts` 实现 strict/deep-frozen manifest、显式 dev/packaged root、main-only verified artifact lookup，以及 size/SHA/arch/execute/signature/license/source/containment gate；macOS x64 在 filesystem 前拒绝。
- `local-subtitle-staging.v1.json` 同时约束 TS 与 Node staging：macOS nested-signed final bytes、Windows unsigned personal final bytes、完整 base artifact/evidence 集、canonical build root 和 `${arch}` artifact naming。
- Windows base manifest 精确要求 server + 12 CPU DLL + ffmpeg/ffprobe；所有 artifact/evidence path 全局大小写不敏感唯一，不允许 PATH、用户 executable 或任意 relative path 补洞。
- `validate-runtime-staging.mjs` 只验证 canonical staging 和现有 builder naming；正式 `extraResources` / `beforePack` / sign ignore 留给 `NATIVE-002`，本包没有提交或生成真实 binary。
- CORE-002 定向 Vitest 2 files / 42 tests，CORE-001/002 + Audio IPC 5 files / 117 tests，全量 Vitest 97 files / 918 tests；TypeScript、35 项 staging/runtime Node 定向与 manifest gate 通过。canonical staging 固定 `point_in_time_static` / `launch:false`，descriptor-bound server/media launch 分别留 `NATIVE-001` / `MEDIA-001`。完整 Node 套件 104 项中 102 pass / 1 fail / 1 skip，唯一红灯仍为既有 `FK-PIT-0030` fixture。

### CORE-003：preload、IPC 与 capability 安全边界（已完成）

- `localSubtitleIpc.ts` 固定 public/internal/event 三组互不重叠的 exact channel、request/result byte budget、strict operation map 与无 generic invoke 的 `LocalSubtitleRendererApi`；preload 对 main response 和 event 再做 runtime 校验。
- owner session 由 main 签发并绑定 `webContents.id + processId + routing/frame identity`；reload、主导航、render-process-gone、frame/window destroy 单次释放，旧 document replay 和 late result 均失败。
- input/output registry 绑定 owner、kind、operation、TTL 与 filesystem identity；批次使用 reserve/commit/rollback 原子把 draft 转成 task/batch lease，lease 过期不能提交，renderer revoke 对 active lease 幂等返回 false。artifact ref 与 one-shot import token 只冻结 owner/TTL/op/dispose/quota 骨架，文件 parser/handoff 业务仍留 `SUB-002` / `LINK-006`。
- legacy generic bridge 对整个 `local-subtitle:` namespace 封闭，不再向 renderer 传 raw `IpcRendererEvent` 或底层 transport；`open-win` 子窗口恢复 `contextIsolation: true` / `nodeIntegration: false`。现有旧工具仍依赖全局 `electronUtils.getPathForFile()` 和 raw output picker，这些值不能换取 local capability，待既有 Subtitle/Text/Rename/HomeAgent 消费者分阶段迁移后再删除，不能违反 `FK-PIT-0022` 直接破坏旧流程。
- 本包只注册注入式业务 handler 与稳定 unavailable error，不伪造 media/runtime/model/task/artifact 成功；真实 handler 分别由 `MEDIA-001`、`NATIVE-001`、`MODEL-*`、`BE-002`、`SUB-002`、`LINK-006` 接入，renderer cleanup retry 已由 `CORE-004` 完成。

### CORE-004：Renderer Store、session runtime 与 cleanup retry（已完成）

- `useLocalSubtitleTranscriberStore` 只持久化 sanitize 后的安全偏好；rehydration/migration 强制恢复空 draft，prompt、capability、task、artifact、正文、路径与诊断不能从脏 envelope 进入内存。
- `localSubtitleSessionReducer` 共享 task/resource revision，派生 batch status，并以 generation/resource tombstone 拒绝 stale resurrection；`localSubtitleRuntimeService` 订阅后取 snapshot、缓冲并 replay 事件，覆盖 gap、overflow floor、snapshot retry、epoch invalidation 和 subscriber isolation。
- subscribe-before-snapshot overlap 额外保留 task/resource identity observation；covered omission 建 tombstone，post-snapshot addition 不误删，规则沉淀为 `FK-PIT-0037`。
- capability cleanup queue 从 Audio 目录提炼到无业务语义的 shared service；Local 使用 authoritative earliest expiry，并把 `revoked:false`、owner release 和 expiry 作为幂等完成。
- 9 files / 132 tests 定向、全量 109 files / 1034 tests、TypeScript、Vite test build、PRE manifest 0 error / 0 warning、validator 17/17 和 diff check 通过；未启动 Vite/Electron/native 长期进程。

### NATIVE-001：official server transport/process contract（已完成）

- `server-contract.ts` 固定 v1.9.1 request fields、BCP-47 → Whisper code、strict health/`verbose_json` schema、时间戳整数化、response/upload/diagnostic/deadline 上限和 restart disposition；不发送 formatter 的 cue/line 参数，也不启用 token timestamps、`--convert`、`/load` 或人类 progress parsing。
- `server-http-client.ts` 使用私有 `127.0.0.1 + 192-bit path` 的 `node:http` 流式 multipart，固定 `window.wav`；readiness/runtime health 分相、所有 operation single-active、文件 descriptor identity 复核、early response/UTF-8/header/body/schema 防护和 bounded close 均可测。任何 inference request 已开始后的 abort/timeout/HTTP/schema/transport/cleanup failure 都使 client `restart_required`。
- `server-process-contract.ts` 直接消费完整 CORE-002 verified bundle + artifact ID，冻结 model/VAD/backend/runtime generation/process flags 的 load identity、exact argv 与 secret-free environment；session 可位于同一 managed root 的专用 `temp/` 子树，但真实目录创建、empty/no-follow/realpath/identity 复核仍属于 launcher。
- `server-diagnostics.ts` 只接受 stdout/stderr，先脱敏 exact private values、endpoint/port/path/credential/prompt/body/transcript，再按 UTF-8 byte、行数和行长限额保留最近诊断。
- 定向 4 files / 75 tests、全量 113 passed + 1 skipped files / 1109 passed + 1 skipped tests、TypeScript 与 exact v1.9.1 CPU two-request/same-PID smoke 通过；real test 默认无 fixture 时 skip，未提交 native binary/model/media。

### BE-001：Server Supervisor 与真实进程生命周期（已完成）

- `server-session.ts` 创建 opaque、identity-bound 的 `<userData>/local-subtitle/temp/server-*`，复核五级 private directory 的 no-symlink、POSIX `0700`、realpath containment、launch emptiness 与 `dev/inode/birthtime/mode`；cleanup 只对持有 proof 的 root 做 quarantine rename + identity recheck，拒绝 structural copy、replacement path 和 permission drift。
- `server-supervisor.ts` 只从 CORE-002 verified bundle 与 main-managed model/VAD identity 构造 NATIVE-001 descriptor，持有 child、loopback reservation、HTTP client、opaque owner/load lease 和独立 process epoch。matching load identity 复用 PID，冲突 identity 返回 `resource_busy`；load/inference 输入先快照，`beginInference()` 同步占用 single-active ticket。
- starting 只轮询 `probeReadiness()` 的 reusable connect/timeout/503；schema fail-fast。early close 在共享 deadline 内以 fresh session/endpoint/epoch 重试一次；ready 后复用前 `health()` 任一失败先 retire，再由 lease 启动新 epoch。CPU exact `--no-gpu`，Metal/CUDA exact main-only epoch/PID/backend/runtime/artifact attestation，均不静默 fallback。
- cancel/owner release/unexpected close 先 fence epoch 和 late result，再 abort；请求或 child 不结算时 SIGTERM → SIGKILL。diagnostics finish 与 session delete 只发生在 child `close` 后；unconfirmed close 或 cleanup failure 锁存 `faulted` 并阻止 respawn，显式 shutdown 可重试。幂等 epoch finalization 遵守 `FK-PIT-0039`。
- `server-app-lifecycle.ts` 把同步 IPC owner release、app `before-quit` 和 update install 接到共享的 bounded shutdown；注册幂等，瞬时 failure 可重试，timeout 后仍观察同一底层 cleanup，更新安装不会越过成功清理。应用启动/打开页面保持 unloaded，只有受控 acquire 才启动 child。
- 聚焦 3 files / 37 tests、default real 1 skipped、显式 exact v1.9.1 CPU real 1/1、全量 116 passed + 2 skipped files / 1146 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest 0/0、validator 17/17 与进程清理通过。
- 本包不生成或验证 PCM window，不执行 raw quality/retry，也不拥有任务队列或启动 orphan scan：分别由 `MEDIA-001`、`SUB-001`、`BE-002`、`BE-003` 完成。

### MODEL-001：模型 manifest、managed 导入与 load smoke

- 冻结首发与 managed model manifest；`large-v3-q5_0` 仍是首发唯一内置型号，其他 large-v3/turbo 型号保持 deferred。
- 本地 GGML 导入必须通过 no-follow header/架构/大小/SHA-256 校验，默认复制；显式移动仍先进入受管 staging，校验和 load smoke 全部成功并原子提交后才删除源文件。CTranslate2/faster-whisper 目录和任意外部运行时路径一律拒绝。
- 导入使用可查询/取消的 `ResourceJob`，并由 app-scoped、per-owner `LocalSubtitleSessionRegistry` 独占 `{ revision, batches, resourceJobs }`；MODEL-001 初始 `batches=[]`，每次 mutation 只增加一次共享 revision，BE-002 后续扩展同一个 registry。
- Supervisor 调用显式区分 `purpose=inference` 与 `purpose=model_load_smoke`。smoke 只允许 CPU、verified runtime 和 managed staging model，不加载 VAD、不执行 inference；readiness 成功后必须先 retire/cleanup 才返回 ready。正常 inference 继续要求 pinned VAD。
- 本包已于 2026-07-22 完成：model catalog 运行时深校验、跨平台安全叶名、abortable GGML 分块校验、`0700` managed/models/staging identity proof、copy/move staging、CPU no-VAD load smoke、hard-link no-clobber commit、list/resolve 复验、owner/app shutdown cleanup 与 identity-bound move recovery 已接入 app-scoped main runtime 和 fixed IPC。
- move 回滚保留最后一份 verified managed copy，直到源路径恢复成功；隔离 rediscovery 必须先有本事务成功创建 path 的 receipt，不能凭相同 inode/prefix 认领既有隐藏链接。空 model 目录、symlink、root replacement、late verification/cache write 和 verifier metadata drift 均 fail closed。
- 验收：MODEL 聚焦 4 files / 50 tests、local-subtitle 29 passed + 2 skipped files / 504 passed + 2 skipped tests、全量 130 passed + 2 skipped files / 1456 passed + 2 skipped tests；TypeScript、renderer/main/preload 三段 Vite test build、manifest 0/0、validator 17/17 与 diff gate 通过。默认真实 server tests 保持 2 skipped，本包未把 unit smoke 冒充 packaged/target-hardware 证据。

### MODEL-002：下载、VAD、删除与 accelerator pack

- 负责模型下载/续传、磁盘空间与删除生命周期；首发内置下载仍只暴露 exact `large-v3-q5_0`。
- 负责 VAD manifest/下载/校验，以及 accelerator pack 的可信下载、安全解包、probe、原子提交和回滚。
- 复用 MODEL-001 的 `ResourceJob` 与 session revision registry，不另造下载状态机。

### MEDIA-001：媒体规范化（已完成）

- 只消费 CORE-002 verified runtime bundle，固定 macOS/Windows FFmpeg 8.1.2 版本并串行探测 exact binary；shell、PATH、用户 executable 与任意参数 fallback 均不可进入产品合同。
- `probeMedia` 绑定 owner、授权 file token、文件 identity、runtime generation 与 bounded track table；streamId 不能跨 owner/file/runtime 或在 reprobe 后复用，task lease 的 expected file token 在 auto/override 两条路径都原子复核。
- 每个 task 先从同一 no-follow handle 冻结私有 source snapshot，ffprobe/FFmpeg 前后复核 identity，原媒体只 decode 一次。FFmpeg 使用最小环境、受控 cwd、关闭 stdin、流式 machine progress、超时/abort、TERM→KILL 与真实 `close` cleanup boundary。
- decode 以 probe duration + 2 秒 trusted tolerance 验收，并在 process cap 再保留 1 秒 truncation sentinel；`-t` / `-fs`、cap-derived disk reserve、完成后 actual frame duration/file size 与 RIFF/RF64 parse-back 共同阻止短报 duration、磁盘耗尽和静默截断。
- 规范化输出严格验证 16 kHz mono PCM16、frame/size/duration；窗口按 exact half-open frame range 延迟物化并绑定 structural descriptor、file identity 与 SHA-256。WeakMap proof 不能由普通对象/路径伪造，source/window 失真或 owner fence 后同步且永久失效。
- owner 同时只允许一个 media operation；cleanup fault 会 abort active controller、撤销 probe/PCM/window proof 并阻止后续启动，只能由 release/shutdown 重试。多 owner shutdown 采用 all-settled cleanup，本进程只删除持有 identity proof 的 session。
- `NATIVE-002` 仍独占目标平台 final bytes、manifest、`extraResources`、builder/signing 与真实 packaged no-PATH 矩阵；`BE-002` 当前单文件 production slice 已把 proof 与 structural attempt/epoch/generation/response 原子绑定，后续执行路径必须保持同一合同，`BE-003` 负责下一次启动的历史 orphan 扫描。

### SUB-001：Raw gate、窗口合并与 canonical 字幕整形（已完成）

- `subtitle-post-processor.ts` 固定 16 kHz structural root plan、main-only attempt lineage、Supervisor epoch/HTTP generation、纯 raw assessment、结构化 split decision 与 exact parent→children replacement；`windowAttempt` 是 root-plan-local 唯一正整数 dispatch ID，child 大于 parent但允许有间隔，response generation 必须匹配 dispatch。0ms/正文不一致的空响应不能伪造 no-speech coverage。
- raw gate 在任何删除/整形前检查正时长、顺序/重叠、窗口边界、15 秒单段，以及连续 8 cue 首尾 wall-clock span 15 秒；正常 split 不映射公开错误，逐窗 quality retry 只有 depth/size 预算耗尽返回 `transcript_quality_failed`，protocol mismatch 与后续全局 merge/shaping failure 各自保留正确错误语义。
- overlap merger 只在相邻 owned core、真实 PCM overlap 和两边 raw observation 都有边界来源证明时删除/裁剪；raw-loop 与 destructive boundary fingerprint 分离，NFKC 只按完整 grapheme 裁剪，不做全局去重。
- segment-only v1 完成 CR/LF/U+2028/U+2029、unpaired surrogate 与不受支持/结构破坏 C0/C1 拒绝、CJK/Latin/标点、grapheme-safe split/wrap、300 ms short merge、100 ms clamp/overlap repair与 `estimatedTiming=true`；`words` 与 estimated timing 互斥。processing warnings/report 保持 main-only，public completion warning v1 仍只有 `cancelled_after_partial_commit`。
- 本包不生成/验证 PCM/WAV branded identity，不导出或写文件；`MEDIA-001` 已产出 brand，`BE-002` 当前单文件 production slice 已绑定 exact normalization/window/attempt/epoch/generation/response/file identity 并拒绝 swap、brand reuse 和 stale response。SRT/LRC formatter、parse-back、原子提交与 Artifact Registry 仍属于 `SUB-002`。

### SUB-002：SRT/LRC 导出、原子写与 Artifact Registry（已完成）

- 新增严格 SRT/LRC formatter/parser/round-trip：SRT 保留精确整数毫秒、LF-only、UTF-8 no BOM；标准 LRC 对 `startMs` 向下量化到 10 ms，同标签 cue 保序且不合并，多行正文投影为空格。
- formatter 逐块执行 16 MiB UTF-8 上限，避免先构造无界字符串；parse-back 校验 cue 数、顺序、时间与 canonical 投影，不能替代 SUB-001 raw transcript quality gate。
- 每格式使用同目录 exclusive `0600` partial、sync/close/reopen/parse-back；index 通过 hard-link no-clobber 提交。standalone overwrite 组件通过 atomic rename 替换且不先删除旧目标，但 path-only 校验无法证明 parent replacement 下 victim 可恢复，当前 production 不放行。目录对象 mutex、lease 重查和 final identity 复核覆盖同进程并发与可观察授权变化，不冒充目录句柄级证明。
- 导出复用共享 terminal resolver，覆盖 full/partial/none-success 和 commit 前后取消；已 commit 格式不因后续失败或取消回滚。
- partial ownership 与内容大小分离；大于 1 MiB 的分块写入取消仍能清理。required unlink failure 显式失败，hard-link detach/Registry activation 失败回滚 identity-matching final、撤销 reservation 且不激活 ref。
- Artifact Registry 绑定 owner/task/generation/TTL/operation，公开摘要无路径；每次 read/reveal 重验 directory/file identity、size/hash、UTF-8、cue/parser 和 v1 DTO 总预算。更高 generation 原子撤销旧 ref，task/owner 释放后不能重签。
- `readArtifactText` / `revealArtifact` 已作为 app-scoped built-in IPC 接通；`handoffArtifact` 与 one-shot import token 保持 unavailable，等待 `LINK-006`，没有提前读取字幕翻译 Store 或创建 target handle。

### FS-TXN-001：目录句柄相对 overwrite transaction（进行中）

- 已新增 main-private strict/deep-frozen transaction request、WeakSet branded Coordinator 与同步 receipt 状态机。Coordinator 捕获已验证 backend/receipt 方法，拒绝结构对象、原型伪造、subclass、expanded payload、pending/resolved/rejected thenable 和 terminal 重入；backend method 真正开始后抛错分别进入 `finalize_pending` / `rollback_pending`，只允许同 receipt 同方向重试，调用前 reentry rejection 不误写 pending。
- Exporter 对未配置 backend 的 overwrite 在目录解析/partial 创建前 fail closed；native transaction 与 legacy test adapter 互斥。transaction 路径在同一同步段执行 `durable preclaim → begin → Artifact Registry activate → durable finalize decision → terminal marker → settled persistence → acknowledge`：activation失败选择rollback；finalize decision写盘只允许首次加一次同payload retry，两次失败时保留receipt、Registry activation与fence且不调用native finalize；terminal或Registry authority未收敛时移交给branded composite owner，同一receipt只能被claim一次。schema-v2 preclaim在begin前落盘；只有明确尚未调用begin时才可删除，begin已标记开始后的任意失败都必须保留record/fence并通过重新授权恢复。
- component/real Registry 回归覆盖 existing/absent victim、连续 read、activation/finalize/rollback 故障、两类 pending/reentry fence、同方向 retry、victim 恢复、partial cleanup、late cancel、同payload decision持久化重试，以及abandoned-open existing/absent × finalize/rollback fresh-process矩阵；Production Executor 组合回归证明前一格式已 commit 时后一格式 cleanup/cancel failure 不删除可读 artifact。
- macOS arm64与Windows x64 protocol v4 backend跨Registry activation持有同一个目录handle，在该handle下做no-follow child验证、victim receipt、atomic replace、finalize/rollback；journal v3绑定exact `transactionId`与canonical partial leaf并提供`.open/.finalize/.rollback` marker。fresh-process recover只接收ID、重新授权目录identity与durable decision；module/receipt acknowledgement只在main durable settled proof后删除terminal marker。native finalizer对`.open`保持方向中立，只续跑已armed terminal且不自行ack。production main/IPC/UI composition、verified staging/builder、真实Windows当前协议矩阵与packaged validation仍需在放行前冻结。
- 001C验证为 native 11/11；7 files / 257 focused、local-subtitle 37 passed + 2 skipped files / 883 passed + 2 skipped tests、全量 138 passed + 2 skipped files / 1836 passed + 2 skipped tests、TypeScript、三段 Vite test build、manifest 0/0、validator 17/17 与 diff check 通过。macOS raw component仍明确 `finalizeCrashRecoveryClaimed=false`、`powerLossSafetyClaimed=false`；main未注入 transaction，Job Manager/Executor仍只允许 index。

### BE-002：Job Manager、Production Executor 与会话生命周期（进行中）

- foundation 已提供最多 100 文件的 app-scoped FIFO 批次、共享 task/resource revision、整批 capability transaction/连续 revision 原子发布、阶段进度、cancel/retry/remove、owner 分区 lease renewal、model identity revalidation、owner fence 和 Session/Job IPC。batch 内 task 按输入顺序排队；task scope 失败只结算当前文件，batch/session scope 在首个失败发布前 fence queued sibling，后续 batch 继续；失败任务保留可重试 capability authority，已完整 commit 的结果不被晚取消覆盖。每次 enqueue/retry admission 使用独立单调 sequence，runtime slice 只覆盖同一 batch、同一 admission 的连续 execution wave，不能跨 admission 误复用。
- 入队在 capability reservation/commit 前并行完成 managed model、input draft 与 owner-bound bundled media runtime admission。media admission 对 FFmpeg/ffprobe 做静态校验、精确 `-version` 启动探针与二次静态校验；失败保留 input/output draft。执行时 Media Normalizer 再 attestation，server runtime 也重新验证并必须与 normalized PCM 的 runtime generation 一致。
- `LocalSubtitleProductionExecutor` 仍按单 task context 执行，但 Job Manager 可把最多 100 个 task 作为一个 immutable CPU/transcribe/no-VAD、custom 或 source、index-only、export-only batch 依次调度；每个 task 可请求 SRT-only、LRC-only 或保序无重复双格式。Job Manager 为当前 queue admission execution wave 持有 main-only opaque runtime token；Production Executor 只有在首个实际任务完成 media normalization、managed model revalidation 和 server runtime revalidation 后才 lazy acquire Supervisor batch pin，入队、等待和 retry preflight 都不能提前占用模型。pin 绑定 owner、batchId 与完整 exact load identity，包括 runtime root/generation/target、server artifact path/hash/version/signature、managed model identity、backend 和 process options；后续 task 的 fresh proof 必须与 pin 完全兼容，不能只比较 generation 或 artifact ID。每个 task 再从 pin 获取短生命周期 task lease，并为每次 dispatch 绑定 normalization、完整 structural descriptor、唯一 brand、前后 file identity/SHA/size、root-plan-local `windowAttempt`、Supervisor `processEpoch`、实例级单调 `requestGeneration`、response 与 admission 时冻结的 media runtime generation；raw gate 的 split children 使用 exact retry geometry，成功 attempts 才进入 canonical post-processing。
- source output 不创建 batch directory lease。每个 task 的 committed input lease 必须同时具备 `transcribe` 与 `derive_source_output`；main 在 input authorization 时从 canonical file path 冻结 parent object identity，后续重验 exact owner/task/token/operation/TTL、file identity、canonical containment 与相同目录对象。Executor 在 normalization/pin 前 fail-fast，丢弃 raw path 但保留无路径 identity proof；SUB-002 exporter 的每次目录请求继续重新解析且必须匹配该 proof。输入文件 identity 失败保留 `media_changed/preparing_media`，父目录 availability/identity 失败使用 task-scope `output_write_failed/exporting`，TTL 失效保留 `authorization_expired/preflight`；terminal capability renewal failure 不得覆盖 executor 已产生的稳定执行错误。renderer state、event 与 IPC 不返回 token 或 raw path。custom/source overwrite 在 capability 消费前拒绝，直到目录句柄相对事务完成。
- 当前 production output conflict policy 仅放行 `index`；shared schema 与 standalone exporter 的同步 overwrite receipt 只表示未来 native 接入合同，不表示 main 已注入 backend、Job Manager/Executor 已放行，或具备 hostile filesystem replacement 安全证据。
- transport request 必填冻结的 expected file identity；HTTP client 在发起任何网络请求前 `open + fstat` 精确复核。每个 materialized window 在 finally 中释放，canonical transcript 形成后仍须先 release Supervisor lease 并 dispose normalized PCM；required cleanup 失败会阻止 export。输出 stem 处理 Windows `CON`/`NUL` 等保留名与 255-byte leaf 上限。
- `cleanup_failed` 表示无取消证据的 required cleanup failure；只有存在 abort/cancel 证据才保留 `cancel_failed`。Job Manager 在普通 abort/cancel 分支前结算两类 cleanup failure，跨格式 all-failed 时让 cleanup/cancel code 高于普通 write failure。至少一个格式 commit 后，普通失败结算为无 warning partial；artifact 带 `cancelled_after_partial_commit` 才结算为 cancellation partial。late cancel 或 lease renewal abort 不能清空已提交 artifact，invalid cancellation fallback 必须覆盖全部 requested formats。task cancel、task-scope `cleanup_failed` / `cancel_failed` 或普通 task failure 后，只要同 admission 仍有 queued sibling，runtime pin 就继续持有；安全取消可退役当前 process epoch，但下一 sibling 仍只能在原 pin authority 下恢复相同 exact load identity。batch/session failure 先 fence queued sibling，再关闭 slice。failed terminal 保留的 input/output retry authority 不持 pin；显式 retry 领取新 admission，只有真正开始执行才重新 lazy acquire。main 已实例化 output authorization、capability coordinator、exporter、production executor、Job Manager 和 `LocalSubtitleSessionLifecycle`，Session/Model/Job public handlers 只合并一次并由 Session bridge 单独 attach。
- owner release 固定 Job first、Registry last；shutdown 固定 Job+Model quiesce → Media+Supervisor cleanup → Registry finalize。Job Manager 先同步 fence admission/run 并 abort active acquire，再幂等关闭匹配 runtime slice；pin acquire/close 与 task operation 一起进入 owner idle/shutdown 收敛边界。各阶段 all-settled，保存首错但继续后续清理；MainRuntime、SessionLifecycle 与 ServerAppLifecycle 都在调用 target 前缓存共享 Promise，防止同步重入创建第二个 shutdown operation。
- Supervisor 的 task lease release 只释放当前 task 调用 authority；active batch pin 阻止 model smoke、不兼容 load identity 和 idle callback 驱逐。最后 pin 释放后，compatible `ready/leaseCount=0` epoch 仍可按既有 warm idle policy 短暂驻留。resident owner 只绑定当前 inference epoch，成功 finalize 后清空，并在 active lease/pin 重启 epoch 时按所有 compatible owner 重建；最后 owner release 立即清理。idle callback 同时校验 epoch 与 timer token；background idle cleanup failure 只锁存 runtime fault并由后续 acquire/shutdown 暴露或重试，不能追溯降级已完成 task。pin 保证 execution wave 内 identity 不被任意替换，但不禁止取消超时、runtime crash 等安全原因触发受控 epoch restart。
- 验证：LRC/multi-format/partial 聚焦 4 files / 176 passed；local-subtitle 33 passed + 2 skipped files / 700 passed + 2 skipped tests；全量 Vitest 134 passed + 2 skipped files / 1653 passed + 2 skipped tests；TypeScript、renderer/main/preload 三段 Vite test build、PRE manifest 0 error / 0 warning、validator 17/17 与 diff check 通过。Vite 只有既有 dynamic-import/chunk-size warning，2 个 skip 均为未启用的真实 native server tests。canonical runtime staging 因 Git 忽略的 canonical runtime path 缺失而按合同 fail closed，不能替代 `NATIVE-002` / QA 证据。
- 未完成：production overwrite 的generation-bound verified staging/load、builder、main/reauthorization IPC/UI injection、真实Windows protocol v4矩阵与两平台packaged validation，以及 CUDA/Metal、VAD、translate、translation handoff、FE与真实 native/packaged E2E。当前 source output、batch pin、多格式、overwrite durable decision/composite owner与两平台raw native/identity composition证据仍不构成真实 FFmpeg + official server + PRE-006模型及target packaged runtime的完整product E2E；non-cooperative child writer safety明确不属于当前或未来本合同的保证范围。完整范围闭环前 `FS-TXN-001` 与 `BE-002` 保持进行中，双重`index-only` gate不得解除。

### FE-001：独立工具页

- 新 route/tool metadata/menu/i18n。
- 模型状态、配置、批量队列、预览、错误和完成操作。
- 两种窗口尺寸和键盘可访问性。

### LINK-001：字幕翻译交接

- `SubtitleArtifactRegistry`、一次性 import token、字幕翻译模块自有的导入协调器。
- 收敛字幕翻译当前偏好并生成批次级配置快照；本地转写侧只持有脱敏摘要和不透明 `snapshotId`。
- 为无模型 enqueue-only 任务引入显式 `needs_configuration` execution binding，所有启动入口只接受 ready binding。
- 生成任务使用无路径 source 标记和 main-only 解析的不透明 target 引用；旧 `outputURL` 不得自动升级为目录授权，恢复清单不持久化路径或 capability。
- 按 `LINK-003`～`LINK-005` 顺序迁移页面、Agent、RecoveryDialog、renderer event 与 main translation 消费者；全部切换前保留可回滚 legacy adapter，不提前删除旧路径值。
- 实现 `export_only`、`enqueue_translation`、`enqueue_and_start_translation` 三种模式。
- 自动执行只启动当前 import receipt 实际新增的 `taskId`，不调用 `startAllTasks()`。
- 批量导入返回稳定任务 ID；自动模式只启动本次成功导入任务，不触碰原有待执行队列。
- 覆盖配置缺失、重复项、部分导入失败、token 过期、启动失败与手动重试。

### QA-001：真实发布矩阵

- Windows x64 installer、macOS arm64 DMG/ZIP；macOS x64 必须稳定拒绝且不生成产物。
- 签名、公证、asar 外资源、更新后模型保留。
- 在隔离系统 FFmpeg 的环境验证 bundled ffmpeg/ffprobe，并覆盖缺失、损坏、错误架构、启动失败和修复指引。
- 真实长音频/视频、取消、OOM、磁盘不足、runner crash、批量部分失败。

## 19. 验证与验收策略

### 19.1 PoC 开发语料

使用用户当前提供的 3 段实际“烤肉”场景作为开发样本集：

- 日文视频与 SRT。
- 日文 WAV 与 LRC。
- 中文视频与 SRT。
- 三者均以非 ASCII 文件名验证路径处理；媒体和字幕正文不进入 Git。

在后续真实 server runtime 上记录产品需要的事实：

- 语言检测。
- SRT/LRC 可回读和时间轴单调性。
- 实时系数 RTF。
- 峰值 RAM/VRAM。
- 模型首次/再次加载时间。
- raw segment 数/规范化 unique text 数、最长连续重复 run 的 cue 数与时长、零/负时长/重叠/越界数量，以及每个计划窗口的执行覆盖状态。
- 中文、日文输出供用户人工确认是否可用。

初始门槛：所有计划窗口都有明确终态，raw transcript validity 与所有输出格式 parse-back 同时通过；声明支持的 GPU 目标机 RTF 小于 1；中文和日文结果由用户在实际产品中人工确认可用。若硬件不满足速度门槛，UI 必须如实标记 CPU/低性能 fallback，不伪装成 GPU 成功。parse-back、HTTP 200、语言匹配或尾时间戳到达媒体末尾均不能单独构成内容通过。

### 19.2 单元与合同测试

- 时间戳毫秒转换：0、59.999、1 小时以上、浮点边界。
- PCM frame 对齐的窗口计划：首窗/中间窗/短尾窗、overlap、取整、完整覆盖和取消后的未执行窗口。
- raw segment quality gate：数十段同文重复、合法短重复、零/负时长、倒退/重叠、窗口与媒体越界、遗漏窗口和有界 retry 耗尽。
- overlap merge：边界半句、相同文本的双窗观测、合法重复台词、真实 raw interval overlap 与 crossed-midpoint ownership；v1 不消费 word timeline，不得全局字符串去重。
- SRT/LRC golden fixtures 与 parse-back。
- CJK/Latin 分句、标点、空文本、超长 grapheme、segment-only 比例估时、`words` / `estimatedTiming` 互斥和轻微重叠修复。
- 状态机非法迁移。
- 多格式 full/partial/none-success、首个 artifact commit 前后取消，以及 committed 产物不回滚。
- task cancellation race、server late response、旧 generation 事件丢弃。
- server 单活动请求、loopback/private path、health timeout、AbortController、kill fallback、最小 environment、diagnostics 上限和 model/process 复用。
- token owner、过期、重复消费、路径越界。
- draft capability → task lease 原子转移、SPA 离页/返回 snapshot revision 重同步、reload/window owner 结束清理。
- 本地转写 Store/session/log 无字幕正文；已启动翻译的 v2 checkpoint 只含恢复所需 fragments，且无媒体字节、path/token/key，终态/删除清理策略可测。
- 三种翻译衔接模式、批次配置快照、配置中途修改不影响已开始批次。
- 自动执行只启动 import receipt 中的任务；原有 `NOT_STARTED` 任务、重复同名任务不得被误启动。
- 翻译配置无效、导入部分失败和启动失败不影响本地任务 `completed` 与已导出产物。
- enqueue-only 无 profile 生成 `needs_configuration`，所有 start 入口拒绝；绑定 profile 后才能启动。
- SubtitleTranslator 页面、Agent queue/recovery、RecoveryDialog、renderer event 与 main translation 的 path/ref 双分支迁移回归。
- 模型 `.part`、断点续传、哈希失败、磁盘不足。
- FFmpeg progress parser 和错误分类。
- fake server HTTP/status/schema mismatch、乱码、非 JSON、崩溃和超时。

### 19.3 实施后的项目验证

```text
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vitest run test/local-subtitle src/store/tools/subtitle src/services/subtitle src/agent test/translation test/audio
node_modules/.bin/vite build --mode=test
git diff --check
```

官方 native server artifact 仍需真实 CPU/CUDA/Metal、动态依赖、签名和 packaged matrix；不能用 Node 合同测试代替目标硬件与安装包验证。只有实际 source-build 路径才增加 CMake/build tests。

Electron 视觉/交互验证必须等待 preload loading 完全退出。若启动 Vite/Electron，结束会话前关闭服务并确认无残留 runner、FFmpeg 或前端进程。

## 20. 主要风险与决策

| 风险 | 决策 |
| --- | --- |
| 把新工具做成 AudioTranscriber 的 local provider | 禁止；独立 route、Store、IPC、runtime、队列和配置 |
| macOS faster-whisper 无 GPU | 首版统一使用 whisper.cpp；Apple Silicon 用 Metal |
| Windows CUDA 运行库导致包体和安装失败 | PRE-006 固定 CPU runner 保底、CUDA on-demand pack 与 1.25 GB expanded guard；personal profile 用官方来源+hash/逐文件清单，不要求 Authenticode |
| 每个文件重载大模型太慢 | Node 管理 persistent official server，批次内模型驻留 |
| 解析 stock CLI 日志随上游变化 | 不用 CLI 日志；固定 official server release，以 `/health` + `verbose_json` 为合同 |
| 整段请求进入重复 decoder 状态但仍返回 HTTP 200 | 规范化后做有界独立窗口；raw gate 检查重复/时间轴/窗口覆盖，失败受控重试且不得进入 formatter |
| VAD segment 时间正确但 word 时间仍是压缩时间轴 | v1 VAD/非 VAD 都强制关闭 token timestamps，strict parser 不向 post processor 暴露 words；未来 word path 必须先定义版本化 capability、provenance 与 validation/failure policy |
| 模型数 GB 拉大安装包 | 按需下载、续传、SHA-256、用户可删除/导入 |
| 视频格式复杂 | FFmpeg 统一转 16 kHz mono PCM16，保留机器可读进度 |
| 字幕分句效果不稳定 | v1 canonical segment + 独立整形预设 + 真实语料 golden tests；未来 word path 必须先有 versioned provenance |
| LRC 逐词标签被翻译破坏 | 交接仅支持标准 LRC/SRT；增强 LRC 明确隔离 |
| 自动翻译意外产生费用或启动旧任务 | 默认仅导出；每批显式授权并展示配置/费用提示；按 import receipt 精确启动，禁止 `startAllTasks()` |
| 长任务取消卡住 | abort callback，超时后杀 runner 并重启 |
| 前一 shutdown 阶段失败后跳过 native/registry cleanup | 每个阶段先无条件执行并 all-settled，再保存首错；禁止用短路赋值包裹有副作用的 awaited phase，Registry 始终最后 finalize |
| child `close` 与主动 retire 并发导致重复 diagnostics/session cleanup | 每个 process epoch 共享幂等 retirement/finalization；只在 `close` 后清理，失败锁存 `faulted` 并由显式 shutdown 重试，遵守 `FK-PIT-0039` |
| renderer 注入任意路径/参数 | fixed preload methods、private channels、sender-bound token、拒绝未知字段 |
| AGPL 参考代码污染 | 只参考行为和参数，独立实现与测试，不复制代码 |
| FFmpeg/CUDA/model 许可证遗漏 | 发布前完整第三方清单和许可证审计 |
| 用户机器没有系统 FFmpeg | 无影响；发行包内置并校验 ffmpeg/ffprobe，packaged QA 隔离 PATH |
| 内置 FFmpeg 缺失、损坏或无法启动 | 打包阶段先失败；运行时入队前禁用转写并提供更新/修复/重装指引，保留草稿、模型和设置 |
| macOS x64 被误判为可运行 | 资源解析前返回 `unsupported_architecture`，不提供 Rosetta 或用户自备 runner fallback |

## 21. 不得违反的实现约束

1. 不得把本地字幕转写加入现有 `/tools/audio/transcriber` 页面或 `audio:*` IPC。
2. 不得复用 Audio API profile、assignment、provider route 或 route constraints 表达本地模型。
3. 不得让 renderer 提交真实路径、任意 executable、任意模型路径或任意 backend flags。
4. 不得在公开 preload bridge 暴露可调用内部 channel 的 generic invoke。
5. 不得把模型、VAD、可选 CUDA pack 或临时 WAV 放进 localStorage、asar 或默认安装包；平台 runner 与经 PRE-006 审计的 FFmpeg/ffprobe 必须作为安装包内、asar 外的 `extraResources`，并由版本化、声明签名/unsigned integrity profile 且含 size/SHA-256/licenseRef 的 manifest 解析。packaged 模式不能回退系统 PATH，也不能接受用户选择的 executable。
6. 不得每个文件启动一个会重新加载大模型的独立 CLI 进程作为正式批处理架构。
7. 不得解析上游人类可读日志作为唯一进度和结果合同。
8. 不得用浮点字符串作为字幕时间轴事实来源；统一使用整数毫秒。
9. 不得直接复制 AGPL 参考项目的输出器、字幕切分器或 GUI 代码。
10. 不得默认自动启动字幕翻译；只有当前批次显式选择 `enqueue_and_start_translation` 才可产生 API 费用，且只能启动本次 import receipt 中确认新增的任务。
11. 不得把“模型文件存在”当作 ready；必须校验哈希和 runner 加载。
12. 不得把开发机 CUDA/FFmpeg 环境当作 packaged app 已支持。
13. 不得用 macOS CPU 可运行来宣称 macOS GPU 已支持；Apple Silicon Metal 必须真实验收。
14. 不得让一个文件失败清空整个批次已完成的字幕产物。
15. 不得在任务结束后遗留 runner、FFmpeg、临时文件或未撤销 capability。
16. 不得把 artifact/目录/checkpoint capability 解包成 renderer raw path 以适配旧 `originFileURL`、`targetFileURL` 或 `checkpointPath`；旧 `outputURL` 也不是新授权来源。
17. 不得让 `importArtifact` 调用方临时传入或修改 auto-start；是否调用外部 API 只能来自当前批次成功 prepare 后冻结的 `handoffMode`。
18. 不得把可重试的 session `artifactRef` 当成 one-shot import token；跨工具的 `translationImportToken` 必须短 TTL、消费即失效且内容快照在 main 清零。
19. 不得让页面组件拥有已提交任务的唯一事件 listener 或 capability；SPA 离页后任务继续，返回时必须通过 revision snapshot 重同步，reload/window owner 结束才按合同取消。
20. 不得用只改任务布尔值冒充取消；必须 abort 当前 inference 连接并等待稳定 `aborted`，超时则 kill/restart server，旧 generation 的 late response 不得覆盖新任务。
21. 不得让 resource install IPC 接收任意 URL、路径或下载参数；renderer 只能提交内置 manifest 的 `resourceId`，并能查询、取消和重同步 resource job。
22. 不得用空 `apiKey/apiModel/endPoint` 表示“加入队列后再配置”；未绑定模型的 enqueue-only 任务必须使用显式 `needs_configuration` execution binding，所有 start 入口统一拒绝。
23. 不得在 Agent、RecoveryDialog、recovery scanner、renderer event 和 main translation 消费者仍读取旧路径字段时提前删除 `outputURL`/`checkpointPath`；兼容值只能在全部消费者切换且回滚验证通过后清理。
24. 不得生成、发布或加载 macOS x64 runner；macOS 非 arm64 必须在资源探测前返回 `unsupported_architecture`。
25. 不得让 bundled media runtime 缺失/损坏的任务进入队列；`media_runtime_missing`、`media_runtime_invalid`、`media_runtime_launch_failed` 必须提供可操作修复指引并保留用户数据。
26. 不得把 HTTP 200、`verbose_json` schema 通过、SRT/LRC parse-back 或开头几段抽查当作整段字幕有效性；raw segment quality gate 必须先于任何整形与导出。
27. 不得通过删除连续重复行掩盖 decoder loop；只能在 overlap 边界按时间和内容仲裁重复观测，无法恢复的窗口必须重试或以 `transcript_quality_failed` 失败。
28. 不得在 `whisper.cpp v1.9.1` v1 请求中使用 token/word 时间轴；当前 VAD/非 VAD 都固定 `token_timestamps=false` 与 `segment_only_v1`。未来 non-VAD word path 必须升级 versioned server contract、提供可信时间域 provenance 并显式定义 validation/failure policy，不能靠可选 `words` 属性猜测或提前承诺 fallback。
29. 不得在 subscribe-before-snapshot reconciliation 中只保留 payload 或按 snapshot omission 无条件建 tombstone；task/resource channel 必须共用 revision cursor，并按 observation revision 判断 snapshot 是否已经覆盖实体身份。
30. 不得把 main-only `timeline_boundary_clamped` / `estimated_timing_used` 塞进 shared completion warnings；v1 public warning 只有 `cancelled_after_partial_commit`，扩展必须升级 CORE contract。
31. 不得让结构 window descriptor、媒体 brand、dispatch identity 和 response 分离流转；所有当前与未来 production executor 路径必须绑定 exact normalization/window + `windowAttempt` + `processEpoch` + request/response generation + inference 前后 file identity，拒绝 window swap、brand reuse 和 stale response。
32. 不得把 source preflight 的 raw path 当 authority，也不得丢弃 parent object proof 后接受下一次解析出的新 identity；授权时冻结目录对象，后续每个写边界只允许相同 identity。
33. 不得把 path-only overwrite 的 post-commit identity rejection 当 victim 可恢复证明；custom/source production 在目录句柄相对事务落地前只允许 `index`。
34. 不得把 Darwin child identity recheck 当作 vnode compare-and-swap，也不得把 N-API finalizer、异常注入或 output-directory prefix scan 当作持久 recovery owner、真实 crash 或 journal ownership 证明。
35. 不得在schema-v2 durable preclaim成功前调用native begin，也不得在begin已标记开始后由`releaseAdoption()`删除record/fence；terminal marker只有在main成功持久化`nativeState=settled`后才可ack。pending状态的`not_found`必须保留record/fence，只有`rollback_unpublished + not_started`或已有durable settled proof后的acknowledgement `not_found`可幂等完成。

## 22. 推荐下一步

`PRE-001`～`PRE-006`、`CORE-001`～`CORE-004`、`NATIVE-001`、`BE-001`、`MEDIA-001`、`SUB-001`、`SUB-002` 与 `MODEL-001` 已完成，M1 的共享 schema、resource manifest/resolver/staging、preload/IPC/capability、renderer session runtime、official server transport/process contract、真实 Supervisor 生命周期、media normalization/PCM proof、canonical post-processing、标准字幕原子产物和 managed model 合同已冻结。唯一 production decision record 是 `poc/pre006-production-decision.json`，后续实现不得静默更换引擎、平台矩阵、首发模型或 media acquisition policy；SUB-001 自有 policy 也不得伪装为 PRE-006 字段。

1. `BE-002` 的 Job Manager foundation、最多 100文件的custom/source CPU/no-VAD/index-only批次、SRT/LRC保序单/双格式、full/ordinary partial/cancellation partial、逐文件失败隔离、exact-identity batch runtime pin与可信多父目录source output已实现；`FS-TXN-001A`～`FS-TXN-001F` 已完成macOS arm64与Windows x64 developer components、strict loader、protocol v4 / journal v3、schema-v2 durable preclaim/decision、terminal marker + acknowledgement、composite owner/file repository、exact reauthorization recovery、lossless Windows volume/FileId与cross-platform exact identity composition。下一步继续generation-bound verified resource staging/load、builder、production main与reauthorization IPC/UI，再完成真实Windows protocol v4与两平台packaged validation。完整验收前不得解除Job Manager/Executor双重`index-only` gate，也不得把`FS-TXN-001`、`BE-002`或M2标记为已完成。
2. Windows 继续使用 `unsigned_personal_distribution`；本人/朋友安装不引入证书或信任库变更。若以后明确要求公开低提示分发，受信任 installer 签名/timestamp 才归可选 `QA-003`。
3. Developer ID、公证和 Gatekeeper accepted 只由 `QA-004` 验收 macOS 分发产物；QA-005 完成分发前第三方 notices/source-offer/NVIDIA DLL 核对。
4. 仍无需 FusionKit 自写 C++ runner；只有 official server 出现产品必需能力的真实硬缺口，才通过独立工作包重新评估 native bridge。
