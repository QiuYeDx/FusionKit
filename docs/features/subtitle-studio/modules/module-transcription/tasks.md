# I2 任务台账

T01–T04已集成于e80ef6b，T05–T08已集成并推送99d0647。T09应用级共享资源、实际已有安装接管及两工具真实验证已完成；用户明确暂停打包演练，用户整体验收仍单独记录。

### T-TRANSCRIPTION-09 共享资源、迁移与两工具统一维护

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-09 |
| 验收 | AC-TRANSCRIPTION-09-1, AC-TRANSCRIPTION-09-2, AC-TRANSCRIPTION-09-3, AC-TRANSCRIPTION-09-4, AC-TRANSCRIPTION-09-5, AC-TRANSCRIPTION-09-6 |
| 依赖 | T-TRANSCRIPTION-08 |
| 写集 | electron/main/speech-resources/, src/speech-resources/, resources/speech-resources/, electron/main/index.ts, electron/main/app-shutdown.ts, electron/main/local-subtitle/, electron/main/subtitle-studio/, electron/preload/, src/subtitle-studio/, src/vite-env.d.ts, src/services/local-subtitle/, src/services/subtitle-studio/, src/pages/Tools/Subtitle/, src/components/local-subtitle/, src/locales/, scripts/subtitle-studio/, scripts/subtitle-studio-provenance/, resources/subtitle-studio/provenance/, test/speech-resources/, test/local-subtitle/, test/subtitle-studio/, test/subtitle-studio-provenance/, test/app-shutdown.test.ts, docs/features/subtitle-studio/, .gitattributes, .agents/skills/fusionkit-pitfall-guard/references/, test-results/, userData中固定转写资源与独占测试目录 |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-08已在99d064719d7ec93dea02944a9bfde31c4afec221及远端集成，开工工作树干净。已读两域管理器、真实资源清单、任务/IPC/生命周期、T08共享前实测及快照；两款模型与VAD完整定义相同，CUDA20文件相同而包ID/回执不同 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-shared-resources.md |
| 集成版本 | 99d064719d7ec93dea02944a9bfde31c4afec221加本轮未提交工作树；源码与证据见records/2026-09-12-transcription-shared-resources.snapshot.json |

#### 实现要点

按design T09分工单写：windows负责中立资源引擎/清单及renderer/preload/UI，admission负责目录迁移及恢复，ipc负责两域主进程适配与接线，root负责共享服务/租约、来源审计、规格及集成验证。新共享资源作业为应用所有；业务任务仍按owner隔离。固定ASR副本保留，资源抽取和组合变更独立来源审计。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-09-1 | unit | required | 中立资源引擎精确校验/下载/ZIP/probe/取消/清理、纯依赖闭包与固定来源；同包别名和错误版本拒绝 | - |
| V-TRANSCRIPTION-09-2 | integration | required | 实际文件系统迁移、各持久断点恢复/去重/损坏/未知/符号链接/身份变化/目标冲突/权限失败；保留最后有效副本及完整源码资源hash | - |
| V-TRANSCRIPTION-09-3 | integration | required | 两域共享安装/删除互斥、准入租约/排队/驻留busy、全局作业与页面释放、事件revision、应用先fence后join和失败重试 | - |
| V-TRANSCRIPTION-09-4 | browser | required | 隔离Electron两页面共享状态、跨页更新、取消/删除确认/busy/错误、窄屏与键盘、迁移后就绪和真实renderer/preload/main接线；实际看最终截图 | - |
| V-TRANSCRIPTION-09-5 | integration | required | 固定真实已有模型/VAD/CUDA无网络接管，两域相同资源路径/内容、CPU/CUDA短样本实际转写及新版文档重开，移除模拟旧资源根仍可用、精确PID及清理证据 | - |
| V-TRANSCRIPTION-09-6 | static | required | 旧/新任务与资源接口回归、冻结来源和新增抽取/组合审计、真实边界、两套TS/i18n、spec/diff、最终源码与证据快照 | - |

### T-TRANSCRIPTION-08 默认 VAD 与 CPU/CUDA 有界真实对照

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-08 |
| 验收 | AC-TRANSCRIPTION-08-1, AC-TRANSCRIPTION-08-2, AC-TRANSCRIPTION-08-3, AC-TRANSCRIPTION-08-4, AC-TRANSCRIPTION-08-5 |
| 依赖 | T-TRANSCRIPTION-07 |
| 写集 | test/subtitle-studio-provenance/, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/, test-results/, 本轮mkdtemp独占系统临时资源根 |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-07已在e80ef6b加共享工作树完成；开工逐项复核30源文件/25资源文件匹配快照dfd09dceaf788427f23b17198b0708e95c3e4bed920a8bb869e6be73d88f2ea4，无漂移。固定六样本/模型/CUDA ZIP均只读hash核对，RTX4070TiSUPER/驱动610.62可用；保留T05–T07未提交结果 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-default-devices.md |
| 集成版本 | e80ef6b加既有T05–T07和本轮工作树；9源文件/22证据/22文档文件快照165ef2e9fb88355f8d0ab2b6f840dcad38b8493a682278f7f56fbc15ce90846b；26次真实链路已验证，未提交 |

#### 实现要点

依design T08单写分工。新维护harness保留T07冻结，真实生产安装/推理/文档持久化，只有下载传输允许本地固定字节适配。全部真实ASR由root串行调度，agent不并发占用GPU或改生产参数。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-08-1 | integration | required | 固定输入hash；新旧真实模型/VAD/CUDA安装、全包布局/验证/探针/重新解析/删除证据，原资源不变 | - |
| V-TRANSCRIPTION-08-2 | integration | required | 六样本两设备24项真实配对、CUDA精确PID正显存、默认VAD/长样本真实窗口/回退；固定CUDA A每侧重复一次 | - |
| V-TRANSCRIPTION-08-3 | integration | required | 新版实际任务成功入库、canonical完整映射、关闭后重开；无识别内容保留真实失败且无文档；输出/差异/耗时保存并按历史局限人工审阅 | - |
| V-TRANSCRIPTION-08-4 | unit | required | 资源适配器固定输入拒绝/安全路径及差异分析时间或词证据变化反例，harness默认跳过与真实超时合同 | - |
| V-TRANSCRIPTION-08-5 | static | required | 相关任务/文档回归、冻结来源/T07实物、实际边界、两套TS与新harness类型、spec/diff/最终进程清理与快照 | - |

### T-TRANSCRIPTION-07 Windows 独立资源与真实 CPU 对照

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-07 |
| 验收 | AC-TRANSCRIPTION-07-1, AC-TRANSCRIPTION-07-2, AC-TRANSCRIPTION-07-3, AC-TRANSCRIPTION-07-4, AC-TRANSCRIPTION-07-5 |
| 依赖 | T-TRANSCRIPTION-03, T-TRANSCRIPTION-06 |
| 写集 | scripts/subtitle-studio-provenance/, scripts/subtitle-studio/, resources/subtitle-studio/provenance/, test/subtitle-studio-provenance/, test/subtitle-studio/, docs/features/subtitle-studio/, .gitattributes, .agents/skills/fusionkit-pitfall-guard/references/, build/subtitle-studio-resources/, test-results/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-03已集成于e80ef6b；T-TRANSCRIPTION-06在共享工作树可用，24文件逐项hash匹配快照0ed05341d32e5b287bb86ba51c0097ee99fb4ccfb5a995ef5502c0a824d2eaae；保留既有T05/T06未提交结果。已核对Windows固定资源合同及本机历史FFmpeg审计回执 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-windows-runtime.md |
| 集成版本 | e80ef6b加既有T05/T06和本轮工作树；30源文件/25资源文件快照dfd09dceaf788427f23b17198b0708e95c3e4bed920a8bb869e6be73d88f2ea4 |

#### 实现要点

依design T07分工单写，root维护规格/集成；分别补齐Windows资源工具和Windows addon工具的独立派生闭包。真实媒体验证采用显式只读输入和隔离资源/文档根，不注入推理结果。现有冻结校验器不放宽。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-07-1 | unit | required | 新资源及Windows addon工具反例、固定来源/精确变换重建、旧T02/T03无漂移 | - |
| V-TRANSCRIPTION-07-2 | integration | required | 固定完整资源输入逐项hash、审计回执、独立staging/manifest、实际FFmpeg/ffprobe/Whisper启动探针 | - |
| V-TRANSCRIPTION-07-3 | integration | required | 实际LLVM-MinGW构建及Electron addon加载、隔离事务/恢复/命名空间、新版贡献完整验证 | - |
| V-TRANSCRIPTION-07-4 | integration | required | 固定真实短音频/模型，旧生产链路及新版任务→真实文档，保存原始输出/同配置差异/耗时/隔离与清理证据 | - |
| V-TRANSCRIPTION-07-5 | static | required | 相关任务文档回归、实际边界、两套TS、spec/diff、实物快照及进程清理 | - |

### T-TRANSCRIPTION-06 转写工作区与文档交接

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-06 |
| 验收 | AC-TRANSCRIPTION-06-1, AC-TRANSCRIPTION-06-2, AC-TRANSCRIPTION-06-3, AC-TRANSCRIPTION-06-4, AC-TRANSCRIPTION-06-5 |
| 依赖 | T-TRANSCRIPTION-05, T-WORKSPACE-08 |
| 写集 | src/services/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/locales/, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/transcription-ipc.ts, electron/preload/subtitle-studio-api.ts, test/subtitle-studio/, scripts/subtitle-studio/, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-05已在e80ef6b加共享工作树集成，38文件快照691dfa0d687968d85f21e3c51f6b80df99d5df9bcf4ddf4a9fa5efaa23fecc02；T-WORKSPACE-08已在HEAD祖先。核对固定API/队列/现有页面实物与1137项回归记录，保留既有未提交结果 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-ui.md |
| 集成版本 | e80ef6b加既有T05和本轮工作树；最终文件摘要见records/2026-09-12-transcription-ui.snapshot.json |

#### 实现要点

依design T06单写分工，根节点集成；不改冻结副本，先补probe接口并公布controller类型。既有文档消费控制器常驻；清理和未知提交状态在SPA切换后仍可恢复观察。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-06-1 | unit | required | controller去重/限额/过期/重探测/撤销重试、惰性及SPA订阅、参数就绪、单飞和未知提交、迟到快照及取消清理反例 | - |
| V-TRANSCRIPTION-06-2 | interface | required | probe固定方法/严格schema/owner与frame校验、sanitized结果、legacy拒绝，现有IPC回归 | - |
| V-TRANSCRIPTION-06-3 | browser | required | 隔离Electron真实renderer/preload/main注册及仓库，受控runtime完成媒体→资源→队列→真实文档；缺失/失败/取消、视图切换与筛选交接 | - |
| V-TRANSCRIPTION-06-4 | browser | required | 对照现有布局审阅1280×860浅色、786×540深色、长名称Tooltip、键盘/焦点、资源Dialog、窄屏滚动和等距几何，修复后复验截图 | - |
| V-TRANSCRIPTION-06-5 | static | required | 相关工作区/转写/来源回归、实际边界、两套TS、i18n、根Vite构建/preload、spec与diff检查，关闭隔离进程 | - |

### T-TRANSCRIPTION-05 任务准入、文档队列与应用接线

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-05 |
| 验收 | AC-TRANSCRIPTION-05-1, AC-TRANSCRIPTION-05-2, AC-TRANSCRIPTION-05-3, AC-TRANSCRIPTION-05-4, AC-TRANSCRIPTION-05-5 |
| 依赖 | T-TRANSCRIPTION-03, T-TRANSCRIPTION-04 |
| 写集 | src/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/locales/, electron/main/subtitle-studio/, electron/main/index.ts, electron/main/app-shutdown.ts, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, test/subtitle-studio/, test/app-shutdown.test.ts, test/subtitle-studio-provenance/, scripts/subtitle-studio-provenance/, .gitattributes, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-03 与 T-TRANSCRIPTION-04 均已集成于 e80ef6b；当前分支跟踪 origin/feat/subtitle-studio-transcription，开工工作树干净。已实际读取 runtime/executor/producer/sink/repository；本机两套TS和298文件边界通过 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-admission.md |
| 集成版本 | e80ef6b加本轮工作树；最终代码摘要见records/2026-09-12-transcription-admission.snapshot.json |

#### 实现要点

依 design T05 分工单写。以任务准入至文档仓库为当前集成链路，不提供旧式文件输出/转写UI，不声明真实ASR或重启恢复。同步 fence/异步 join、失败重试清理及发布回执语义不得简化。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-05-1 | interface | required | 请求/摘要schema、固定preload方法、legacy拒绝、非法frame/URL/capability、原生picker/copy-only、owner替换和迟到授权拒绝 | - |
| V-TRANSCRIPTION-05-2 | integration | required | 准入/FIFO/多文件回滚、续租、资源忙/身份失效、跨owner、取消、终态移除及清理失败测试 | - |
| V-TRANSCRIPTION-05-3 | integration | required | 实际队列→T04 producer/sink→真实仓库及文档读回，取消/发布故障/能力与资源清理反例 | - |
| V-TRANSCRIPTION-05-4 | integration | required | runtime与应用双运行时关闭/更新，重入、失败重试和根锁；I1功能懒初始化不依赖ASR资源 | - |
| V-TRANSCRIPTION-05-5 | static | required | 相关I1/T02/T04回归、来源/实际边界、两套TS、i18n、Vite test构建/preload、LF属性/规格/diff；清理本轮测试进程 | - |

### T-TRANSCRIPTION-01 生产基线、依赖与资源来源冻结

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-01 |
| 验收 | AC-TRANSCRIPTION-01-1, AC-TRANSCRIPTION-01-2, AC-TRANSCRIPTION-01-3, AC-TRANSCRIPTION-01-4 |
| 依赖 | T-WORKSPACE-06, T-WORKSPACE-08 |
| 写集 | scripts/subtitle-studio-provenance/, resources/subtitle-studio/provenance/, test/subtitle-studio-provenance/, docs/features/subtitle-studio/modules/module-transcription/, docs/features/subtitle-studio/records/ |
| 负责人 | Codex root |
| 依赖确认 | T-WORKSPACE-06 已集成于002be2d；T-WORKSPACE-08及界面跟进已集成于a742746至3a0f50e；已核对Git祖先及当前源码，并复跑334项模块回归和130文件实际边界检查；旧转写来源保持3a0f50e |
| 完成日期 | 2026-09-11 |
| 实施记录 | records/2026-09-11-transcription-baseline.md |
| 集成版本 | 3a0f50e加本轮未提交维护工具/规格工作树；最终基线SHA-256 c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66，完整工具摘要见记录 |

#### 实现要点

沿本模块设计冻结固定提交，不修改旧业务。root 独占规格、基线生成产物及集成；baseline_checks 独占维护脚本与对应测试；另外两名审查者只读代码，可写临时清单，不能修改同一基线。共享策略由消息确认后单写，不并行更新生成 JSON。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-01-1 | unit | required | 隔离仓库覆盖稳定重建、源内容漂移、文件遗漏、未解析依赖、目的冲突和篡改拒绝 | - |
| V-TRANSCRIPTION-01-2 | integration | required | 当前3a0f50e生成基线，历史重建和工作树对照；核对每项hash、输出无绝对路径与未发生的复制/实测结论 | - |
| V-TRANSCRIPTION-01-3 | manual | required | 审查主进程/类型/默认值闭包、测试fixture、原生及构建资源、字符串边界、拟议复制与排除理由 | - |
| V-TRANSCRIPTION-01-4 | static | required | I1实际源码边界、模块回归、两套TypeScript、i18n、规格ready/done及git diff --check | - |


### T-TRANSCRIPTION-02 独立源码副本与等价回放

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-02 |
| 验收 | AC-TRANSCRIPTION-02-1, AC-TRANSCRIPTION-02-2, AC-TRANSCRIPTION-02-3, AC-TRANSCRIPTION-02-4, AC-TRANSCRIPTION-02-5 |
| 依赖 | T-TRANSCRIPTION-01 |
| 写集 | scripts/subtitle-studio-provenance/, test/subtitle-studio-provenance/, electron/main/subtitle-studio/transcription/, src/subtitle-studio/transcription/, resources/subtitle-studio/transcription/, resources/subtitle-studio/provenance/, test/subtitle-studio/transcription/, test/subtitle-studio/boundaries.test.ts, scripts/subtitle-studio/, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-01来源3a0f50e及已集成共享工作树可用；基线SHA-256 c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66，开始时核对既有副本工具、任务和工作区，不覆盖上轮未提交结果 |
| 完成日期 | 2026-09-11 |
| 实施记录 | records/2026-09-11-transcription-copy-replay.md |
| 集成版本 | 3a0f50e加本次未提交共享工作树；120文件副本，fork SHA-256 993e57a72b3a191e8ba6afe50d90899baefd4f6af4f8f62ad25cc3d6371befa3；完整工具及回放证据摘要见记录 |

#### 实现要点

root独占规格、边界规则、最终记录与整合；baseline_checks独占copy工具/策略、生成的新生产/类型/资源/正常测试副本及fork provenance；workspace_progress独占维护侧replay测试/harness/输入表；broader_roadmap只读审查资源/命名空间。T01工具与冻结baseline不改。写权细分通过协作消息登记，临时旧树只用于迁移验证、不注册服务。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-02-1 | unit | required | 复制工具反例：固定重建、精准变换、缺依赖/源漂移、覆盖/目的冲突拒绝、实际目标hash校验 | - |
| V-TRANSCRIPTION-02-2 | integration | required | 实际副本生成及重建校验、T01旧来源对照；逐文件检查修改仅为允许的路径/身份变换，原生/脚本递延有理由 | - |
| V-TRANSCRIPTION-02-3 | integration | required | 隔离新旧执行器完整transcript/请求/窗口/回退配对；窗口策略、quiet、重复/未知句界、overlap、DTW矩阵与预期路径断言 | - |
| V-TRANSCRIPTION-02-4 | integration | required | 实际签发的backend/accelerator/batch runtime/PCM-window双向跨副本拒绝；有效本侧正例保留 | - |
| V-TRANSCRIPTION-02-5 | static | required | 新版正常回归、真实业务依赖边界、两套TypeScript、i18n、I1模块回归、spec ready/done与diff检查 | - |

### T-TRANSCRIPTION-03 独立资源工厂与原生构建组合

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-03 |
| 验收 | AC-TRANSCRIPTION-03-1, AC-TRANSCRIPTION-03-2, AC-TRANSCRIPTION-03-3, AC-TRANSCRIPTION-03-4, AC-TRANSCRIPTION-03-5 |
| 依赖 | T-TRANSCRIPTION-02 |
| 写集 | native/subtitle-studio-overwrite/, scripts/subtitle-studio/transcription/, scripts/subtitle-studio-provenance/, resources/subtitle-studio/provenance/, electron/main/subtitle-studio/transcription/, test/subtitle-studio/transcription/, test/subtitle-studio/transcription-runtime.test.ts, test/subtitle-studio/helpers/, test/subtitle-studio-provenance/, test/subtitle-studio/boundaries.test.ts, scripts/subtitle-studio/, scripts/packaging/, electron-builder.subtitle-studio.json, .gitignore, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-02共享工作树已集成于3a0f50e加未提交副本，120副本fork SHA-256 993e57a72b3a191e8ba6afe50d90899baefd4f6af4f8f62ad25cc3d6371befa3；20项回放及679新版回归已通过，当前核对未提交结果和冻结来源并复跑copy --check通过，不修改T02机械副本 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-runtime-native.md |
| 集成版本 | 3a0f50e加T01/T02及本次共享工作树；42文件集成快照SHA-256 cfba72e89fc0320771051c2484aac4273d0fec6fd5f2194c13d2ce403a52d86b；新版native/tooling fork和真实签名后addon摘要见实施记录 |

#### 实现要点

root独占规格/边界/最终集成；baseline_checks独占native、overwrite-native脚本与native来源工具/测试/记录；broader_roadmap独占runtime构建校验脚本、双资源builder/组合hook与tooling来源记录；workspace_progress独占runtime工厂与正常测试。shared runtime-manifest/staging-contract由broader_roadmap单写并提供给native；不修改T01/T02清单和机械副本。所有新增来源记录分文件单写，不由多个agent更新同一JSON。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-03-1 | unit | required | native/tooling来源hash和准确变换重建；旧源对照、目标冲突拒绝；生产源码/脚本新版闭包与动态装载审计 | - |
| V-TRANSCRIPTION-03-2 | integration | required | 独立runtime工厂/owner/目录、copy-only导入及源删除后副本可用、并发初始化/关闭、失败重试与清理、无旧目录修改 | - |
| V-TRANSCRIPTION-03-3 | integration | required | 完整双资源builder配置校验、逐贡献真实验证器调用、错映射/错平台/缺失/篡改负例、新版单贡献独立验证 | - |
| V-TRANSCRIPTION-03-4 | integration | required | 当前macOS arm64实际新版编译、ad-hoc签名、最终hash、Electron独立加载和事务/恢复；分开登记Windows及完整app实跑待验 | - |
| V-TRANSCRIPTION-03-5 | static | required | 新增正常回归、T02回放、真实边界、两套TypeScript、i18n、spec ready/done及diff；清理本轮进程 | - |

### T-TRANSCRIPTION-04 最终转录文档生产者

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-04 |
| 验收 | AC-TRANSCRIPTION-04-1, AC-TRANSCRIPTION-04-2, AC-TRANSCRIPTION-04-3, AC-TRANSCRIPTION-04-4, AC-TRANSCRIPTION-04-5 |
| 依赖 | T-TRANSCRIPTION-03, T-WORKSPACE-06, T-WORKSPACE-08 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, test/subtitle-studio/, scripts/subtitle-studio-provenance/, test/subtitle-studio-provenance/, resources/subtitle-studio/provenance/, scripts/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/locales/, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-03共享工作树42文件快照cfba72e89fc0320771051c2484aac4273d0fec6fd5f2194c13d2ce403a52d86b与已集成I1源码可用；核对T03记录及当前schema/repository/executor实物，T-WORKSPACE-06与T-WORKSPACE-08已在HEAD3a0f50e祖先；保留未提交结果 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-document.md |
| 集成版本 | 3a0f50e加T01/T02/T03及本次共享工作树；33文件集成快照SHA-256 e770f8180a7a0da230cbdce8004f5a119bf29b6e899b93cb0ec457b615d32d51；派生来源与13类配对/10项边界证据摘要见实施记录 |

#### 实现要点

按design T04独占写集分工；保持T02精确副本，新派生输出边界单独来源记录。只创建隔离文档，不开转写UI、不接真实模型。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-04-1 | unit | required | 完整字段映射/旧schema兼容、100k边界/超限/坏word/重复id/快照字节拒绝 | - |
| V-TRANSCRIPTION-04-2 | integration | required | 派生精准变换重建、最终transcript配对、无文件export/输出授权、pipeline及task/batch cleanup与取消负例 | - |
| V-TRANSCRIPTION-04-3 | integration | required | sink实际仓库创建/重开、并发去重、owner/generation/signal发布前拒绝、提交故障/迟到取消/重试/墓碑不复活 | - |
| V-TRANSCRIPTION-04-4 | integration | required | 媒体文档翻译/分页/导出投影与损失，证据保持，原文件/双语保护及旧字幕兼容 | - |
| V-TRANSCRIPTION-04-5 | static | required | I1/T02与本轮回归、T02来源无漂移、实际边界、两套TS/i18n、ready/done、diff、进程清理 | - |
| V-TRANSCRIPTION-04-6 | browser | required | 隔离Electron媒体105cue/旧字幕，分页、原文件菜单、默认SRT、损失确认与实际输出，查看最终截图 | - |
