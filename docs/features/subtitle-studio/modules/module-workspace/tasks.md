# I1 任务台账

### T-WORKSPACE-08 文档库、异常管理与批量工作流

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-09 |
| 验收 | AC-WORKSPACE-09-1, AC-WORKSPACE-09-2, AC-WORKSPACE-09-3, AC-WORKSPACE-09-4, AC-WORKSPACE-09-5, AC-WORKSPACE-09-6 |
| 依赖 | T-WORKSPACE-06 |
| 写集 | electron/main/subtitle-studio/, electron/preload/subtitle-studio-api.ts, src/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/store/tools/subtitle-studio/, src/locales/, test/subtitle-studio/, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root 集成；backend_audit 后端/IPC契约及仓库测试；ux_audit 翻译/导出组件；batch_verification 新 library-ui 验证；root 文档库/异常UI、偏好、四语言与其余集成 |
| 依赖确认 | T-WORKSPACE-06 已在002be2d集成并包含于b68477a；git历史和实际源码核对b68477a含开发启动修复6157cbd，起始工作树干净；本轮用户明确要求 I2 前改进，属于新增 R09 行为授权 |
| 完成日期 | 2026-09-11 |
| 实施记录 | records/2026-09-11-library-batch.md |
| 集成版本 | a742746 文档库与批量工作流；后续2878b94/d5e98d4/3a0f50e界面打磨已集成；当前边界补漏见records/2026-09-11-boundary-closeout.md |

#### 实现要点

根任务独占 index.tsx/studio.css/StudioLibrary 与恢复UI、偏好、locale和规格台账；backend_audit 独占主进程新服务、IPC契约/preload和仓库/IPC测试；ux_audit 独占 StudioTranslation/StudioExport/StudioBilingual触发器及配套新batch组件；batch_verification 独占新 library-ui.test.ts。共享树在 root 协调消息中领取，契约先同步再实现，不并行启动同端口服务。既有 AC 不降低，I2 保持未批准。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-08-1 | integration | required | 仓库与IPC测试：坏文档token/恢复竞争/目录约束，部分导入，全库查询，跨owner/非法参数；批量计划、失败隔离、revision、同名、取消与恢复 | - |
| V-WORKSPACE-08-2 | browser | required | 开发版隔离Electron完成多导入、搜索/排序/筛选/跨页选择、批量翻译导出删除、关闭提示重启与异常清除；查看最终深浅/窄窗口截图并复验发现 | - |
| V-WORKSPACE-08-3 | static | required | 两套默认TypeScript、i18n locale/usage、preload、git diff --check及spec checker | - |
| V-WORKSPACE-08-4 | integration | required | 字幕工作台模块回归与受影响原有单文件UI；记录真实输出和进程清理，无真实用户数据变更 | - |

本文件是唯一任务状态源。依赖完成不等于已集成，实施时须登记实际版本。当前只展开 I1，按以下顺序连续推进；真实实施授权登记于 spec.json。

执行恢复：2026-09-08 用户在 UI 优化后明确回复“好，继续推进工作吧”；暂停历史与恢复来源登记于 spec.json。

2026-09-08 UI 跟进：按用户“提交代码并推送，然后修一下”上下空白的指令，先推送 T02，再修复工作台纵向布局；实现与 Electron 验证见 [布局记录](../../records/2026-09-08-layout-height.md)。纵向布局已按后续用户指令提交为 `ddf178b`；随后优化原始内容密度，见 [密度记录](../../records/2026-09-08-raw-density.md)，已提交为 `5afc695` 并推送。T03/T07 与后续双语修复已集成于 `9c88565`；2026-09-10 本轮继续完成 T04/T05，T06 验证进展及未执行项见其任务块。本轮随 `feat(subtitle-studio): add recovery and multi-mode export` 提交集成，父提交为 `9c88565`，实际提交 SHA 以 Git 历史为准。

### T-WORKSPACE-01 新版最小文档链路与格式核心

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-01, R-WORKSPACE-02 |
| 验收 | AC-WORKSPACE-02-1, AC-WORKSPACE-02-2 |
| 依赖 | - |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, src/pages/Tools/Subtitle/SubtitleStudio/, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, test/subtitle-studio/, scripts/subtitle-studio/, src/App.tsx, src/constants/router.ts, src/pages/Tools/index.tsx, src/pages/Tools/_shared/toolMeta.ts, electron/main/index.ts, electron/preload/index.ts, electron/electron-env.d.ts, src/locales/, src/i18n/resources.ts |
| 负责人 | Codex（当前任务，串行实施） |
| 依赖确认 | 无前置任务；已核对 v0.3.1 基线 4791e10cd8443a0aecbfe7ad5bd05ad2b57555b2，初始工作树干净 |
| 完成日期 | 2026-09-08 |
| 实施记录 | records/2026-09-08-i1-implementation.md |
| 集成版本 | a8e2eea72ea08c6ed40e684fbbc9c2de3e529774（含已完成 UI 优化）；此前验证快照保留在实施记录 |

#### 实现要点

先盘点新入口必需的应用公共依赖并建立禁止依赖清单/静态检查，禁止导入旧 subtitleCueProtocol。定义带版本的文档与严格校验，实现 SRT/LRC 原节点保留和格式诊断；建立最小真实 import→保存→只读详情→source 导出链路。仅做此链路需要的仓库/IPC，不先实现全部后台服务。

在新测试目录创建独立 fixture，不调用旧测试 helper；保留已存在未提交文件。源码细分可按职责调整，但不能扩展到 v1 专属目录。任务涉及应用壳的新增贡献，必须留存增量清单供最后移除演练。

#### 当前验证进展

2026-09-08 用户先后补充几百 KB LRC 导入/显示正常、原生保存导出正常；结合原有受控 Electron 重启及源字节一致性验证，V-WORKSPACE-01-3 证据已补齐。首项任务完成，不代表 I1 整体验收。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-01-1 | unit | required | 运行新 domain/format 测试：覆盖 AC-WORKSPACE-02-1 的格式矩阵、ID 与原节点映射，并核对 source 导出内容 | - |
| V-WORKSPACE-01-2 | unit | required | 注入 AC-WORKSPACE-02-2 的解码/结构/资源负例，确认诊断与不提交半文档 | - |
| V-WORKSPACE-01-3 | integration | required | 实际 Electron 选择两种合成文件，保存、预览、关闭重开和源导出；核对源文件 hash 未变 | - |
| V-WORKSPACE-01-4 | static | required | node scripts/subtitle-studio/check-boundaries.mjs；加入旧 import 和传递 barrel 负例证明检查能失败 | - |

### T-WORKSPACE-02 持久化故障恢复与主进程权限

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-03, R-WORKSPACE-07 |
| 验收 | AC-WORKSPACE-03-1, AC-WORKSPACE-03-2, AC-WORKSPACE-07-2 |
| 依赖 | T-WORKSPACE-01 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, test/subtitle-studio/, electron/electron-env.d.ts, src/locales/, scripts/subtitle-studio/boundaries.json |
| 负责人 | Codex（串行实施） |
| 依赖确认 | T-WORKSPACE-01 已完成且集成于 a8e2eea；已核对当前 repository、IPC、UI 和测试，开始时工作区干净 |
| 完成日期 | 2026-09-08 |
| 实施记录 | records/2026-09-08-workspace-02.md |
| 集成版本 | b8eac4c6df24e0dca2241bbc8e7d546edd14a158，已推送 origin/v0.3.1；原验证源码摘要保留在实施记录 |

#### 实现要点

落实 generation 快照、文档/检查点一致提交、current 指针恢复、索引重建和尺寸边界；建立删除墓碑和清理归属。完整 IPC DTO/owner/revision 校验、精确公开 allowlist、快照/事件归并；不持久化凭据或租约。先补故障注入与跨 owner 反例，再完善可靠性。

实际扩展写集仅用于四语言删除操作文案，以及审计 ScrollableDialog 的既有第三方依赖后登记 allowlist；未安装依赖。42 项自动化、生产 Electron 恢复/删除与既有 UI 回归通过。全局原配置 tsc 和 i18n usage 仍有已核对的既有失败，详见实施记录，未据此宣称 I1 整体验收完成。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-02-1 | integration | required | 在临时仓库逐点中断写入/指针发布，破坏索引并重启，移走源文件后读取和导出，映射 AC-WORKSPACE-03-1 | - |
| V-WORKSPACE-02-2 | integration | required | 清任务/删文档/迟到响应与删除并发；扫描持久快照凭据字段；核对旧数据与导出文件不被清理，映射 AC-WORKSPACE-03-2 | - |
| V-WORKSPACE-02-3 | interface | required | 伪造 owner/路径/方法/版本与旧事件覆盖测试，验证拒绝；模型/字幕脚本注入在 Electron 只显示文本，映射 AC-WORKSPACE-07-2 | - |

### T-WORKSPACE-03 文本翻译协议与实际预算

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-04 |
| 验收 | AC-WORKSPACE-04-1, AC-WORKSPACE-04-2 |
| 依赖 | T-WORKSPACE-02 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, test/subtitle-studio/, src/locales/, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, scripts/subtitle-studio/boundaries.json, electron/main/ai/model-runtime-client.ts, electron/main/ai/adapters/chat-completions-adapter.ts, electron/main/ai/adapters/responses-adapter.ts, test/ai/model-runtime-response-limit.test.ts |
| 负责人 | Codex root（计划/服务/IPC/集成）；translation_protocol（协议与单测）；translation_ui（独立组件与四语言）；model_audit（通用 adapter 限额与只读评审） |
| 依赖确认 | 2026-09-09 核对 T-WORKSPACE-02 提交 b8eac4c 已包含于基线 5afc695；repository 事务、墓碑、IPC owner 校验可用，工作树干净 |
| 完成日期 | 2026-09-09 |
| 实施记录 | records/2026-09-09-workspace-03.md |
| 集成版本 | 已包含于 9c88565276349955d23df1b926092634346f6413；实施记录保留当时验证源码摘要 |

#### 实现要点

审计应用通用模型客户端及重试层，不改旧翻译模块。新 planner 生成带源修订映射的短 ID 和文本上下文，共用实际请求序列化做预算与预估。支持普通文本和声明过的简单内联保护，不要求译文视觉行数与原文一致。完整批次校验后写入译文轨；显示实际或未知 usage。

2026-09-09 用户报告实际 DeepSeek 翻译 52 条 LRC 失败，T03 曾退回进行中。现已统一主进程 thinking 默认策略、区分输出截断诊断，并用用户指定的同一文件完成真实 API 翻译（52 条、2 批、2 次请求），139 项回归及 Electron 验证通过后恢复完成。保留原验收标准，修复证据见实施记录的 DeepSeek 跟进部分。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-03-1 | unit | required | 捕获请求正文与上下文、比较 planner 估算/执行输入；响应乱序、源时间不变、usage 缺失；覆盖 AC-WORKSPACE-04-1 | - |
| V-WORKSPACE-03-2 | unit | required | 漏/重复/未知 ID、截断 JSON、保护标记漂移、Unicode/超长单元反例；确认整批拒绝及只重试该批，覆盖 AC-WORKSPACE-04-2 | - |
| V-WORKSPACE-03-3 | integration | required | 用明确配置并允许发送的合成短字幕做真实 API 请求，核对译文对应、用量及 source 不变；缺配置记录待验证，不上传用户文件替代 | - |
| V-WORKSPACE-03-4 | browser | required | 隔离 Electron 导入合成字幕，配置/预算/提交/用量/译文轨预览，检查错误恢复、1280 与 786 窗口、主题和原工作台空间回归；实际查看最终截图 | - |

### T-WORKSPACE-07 双语导入解释与清轨

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-08 |
| 验收 | AC-WORKSPACE-08-1, AC-WORKSPACE-08-2, AC-WORKSPACE-08-3 |
| 依赖 | T-WORKSPACE-03 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, src/pages/Tools/Subtitle/SubtitleStudio/, src/locales/, test/subtitle-studio/, scripts/subtitle-studio/boundaries.json, docs/features/subtitle-studio/ |
| 负责人 | Codex root（规格/IPC/仓库/集成/验证）；translation_protocol（分析转换核心与领域）；translation_ui（独立确认组件与四语言）；model_audit（只读样本/评审） |
| 依赖确认 | 2026-09-09 已核对 T-WORKSPACE-03 在基线 5afc695 加当前工作树中可用，源码摘要 3c21da04b3eef8dd96577e5625694f1b6ae6ec6b697b163a9007d058e5fcad71；用户反馈翻译已正常，事务/源hash/译文轨已读验 |
| 完成日期 | 2026-09-10 |
| 实施记录 | records/2026-09-10-workspace-07-preview.md |
| 集成版本 | 初版集成于 019bb3b；混合双语与预览/分页修复均已包含于 9c88565276349955d23df1b926092634346f6413，历史源码摘要保留在实施记录 |

#### 实现要点

新增本地候选分析、分页预览及 revision 保护的双语解释提交；原始证据不变，导入译文为 imported/unreviewed。用稳定节点/字符范围记录双方来源；既有无双语字段快照兼容。既有文档可选择整理，新导入满足稳定结构推荐时自动预览确认；单行混排明确启用、可改边界/跳过。清除单轨与关联终态任务同事务；同文档任意排队/运行任务，或选中轨可继续任务存在时拒绝。历史任务清理入口同样保护运行中的其他任务。主页面沿用紧凑图标工具栏与 ScrollableDialog，区分原文件下载文案，导出序列化后续 T05。

2026-09-09 用户报告同时间双行中第一行同时含行内译文，开启空格拆分后原文仍夹带旧译文。按用户要求复开修复，保留原 AC；结构配对后组合执行有证据的行内重复分离，并完成正文正确性回归和真实文件 Electron 验证。用户 LRC 的 282 处重复尾段已修正，59 组相同原译文保留；不能只用配对数或双列存在作为通过条件。旧版已整理文档需重新导入原文件并确认，历史初版证据保留于 records/2026-09-09-workspace-07.md。

2026-09-10 用户要求修复预览中未拆分的混排双语，并增加页码输入跳转，授权在 T07 内复开，现已完成。实际文件另有 46 组双方均为完整混排的相同正文，显式开启行内拆分后提供有字种证据的分界并统一预览/提交；13 组普通同文继续保留。两份文件共 830 条需复核预览已逐页比对最终整理正文；Electron 验证用户截图位置、数字页码跳转、筛选后页数更新、默认主表分页和窄窗底栏通过。前次 282 处重复尾段修复未回退，历史证据保留于 records/2026-09-09-workspace-07-mixed.md。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-07-1 | unit | required | 结构/字种/同文/顺序/空白/样式/多标签/歧义/反向/非法覆盖矩阵；原节点range、源hash及输入不变，覆盖 AC-WORKSPACE-08-1, AC-WORKSPACE-08-2 | - |
| V-WORKSPACE-07-2 | interface | required | 生产IPC跨owner、过期revision、已有任务拒绝；转换/清轨重启、原文件导出字节不变、原文再翻译及迟到写入拒绝，覆盖 AC-WORKSPACE-08-1, AC-WORKSPACE-08-2, AC-WORKSPACE-08-3 | - |
| V-WORKSPACE-07-3 | browser | required | 隔离Electron双语LRC/SRT导入→候选预览/方向/混排选择→确认→清轨→模型fixture重新翻译；桌面/窄窗、错误状态、最终截图人工审阅，覆盖 AC-WORKSPACE-08-1, AC-WORKSPACE-08-2, AC-WORKSPACE-08-3 | - |
| V-WORKSPACE-07-4 | integration | required | 用户指定两文件仅本地分析和隔离转换，不发送API；记录数量、未匹配和复核项，重读/保真导出核对；相关vitest、构建、边界、i18n、类型检查及进程清理 | - |

### T-WORKSPACE-04 批次恢复、取消与旧结果防护

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-05 |
| 验收 | AC-WORKSPACE-05-1, AC-WORKSPACE-05-2 |
| 依赖 | T-WORKSPACE-03, T-WORKSPACE-07 |
| 写集 | electron/main/subtitle-studio/, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, src/subtitle-studio/, src/services/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, test/subtitle-studio/, src/locales/, docs/features/subtitle-studio/ |
| 负责人 | Codex root（契约/IPC/仓库校验/文档/集成）；translation_protocol（执行服务/冻结计划/恢复测试）；translation_ui（状态操作/四语言/UI场景）；model_audit（只读并发与恢复审计） |
| 依赖确认 | 2026-09-10 在干净基线 9c88565 核对 T-WORKSPACE-03 与 T-WORKSPACE-07 均已集成，已读取 planner/service/checkpoint/preview/clear 实现及验证记录；用户明确要求核对后继续 I1 |
| 完成日期 | 2026-09-10 |
| 实施记录 | records/2026-09-10-workspace-04.md |
| 集成版本 | 随本轮 recovery/export 提交集成（父提交 9c88565）；T04 阶段验证源码摘要 14d442b718cfb028fffbd3148c85c9c48ffa73714d0bad4b5c34eb235b609bd5 |

#### 实现要点

固定任务配置，检查源/轨修订与 generation；一文档一个活动翻译任务，应用级请求并发有界。落实 interrupted/needs_configuration、恢复未提交批次、单层退避及 Retry-After。取消任务不能撤销已提交译文，也不能接受迟到结果。请求成功但本地未提交的未知计费单独记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-04-1 | integration | required | 两批以上：第一批提交后故障/进程关闭，重启继续；捕获调用次数；配置删除/变化、取消与迟到结果，覆盖 AC-WORKSPACE-05-1 | - |
| V-WORKSPACE-04-2 | unit | required | 注入源/轨修订和 generation 冲突、重复启动、多文档同时运行；限流/退避取消与重试计数，覆盖 AC-WORKSPACE-05-2 | - |
| V-WORKSPACE-04-3 | browser | required | 隔离 Electron 翻译第一批后重启，恢复只处理未提交批次；取消与迟到响应、模型缺失/变化修复入口、未知请求提示、深浅主题和窄窗口，检查截图及清理测试实例 | - |

### T-WORKSPACE-05 多模式导出与发布一致性

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-06, R-WORKSPACE-08 |
| 验收 | AC-WORKSPACE-06-1, AC-WORKSPACE-06-2, AC-WORKSPACE-06-3, AC-WORKSPACE-08-4 |
| 依赖 | T-WORKSPACE-04 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, src/pages/Tools/Subtitle/SubtitleStudio/, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, test/subtitle-studio/, src/locales/, scripts/subtitle-studio/boundaries.json, docs/features/subtitle-studio/ |
| 负责人 | Codex root（统一契约/IPC/发布/文档/集成）；translation_protocol（本地导出规划/序列化与测试）；translation_ui（导出弹窗/四语言/Electron场景）；model_audit（独立发布与边界审计） |
| 依赖确认 | 2026-09-10 T-WORKSPACE-04 已在同一共享工作树通过 125 项回归与实际强制退出/重启 Electron 场景，验证源码摘要 14d442b718cfb028fffbd3148c85c9c48ffa73714d0bad4b5c34eb235b609bd5；已核对 sourceBytes 实属 original、repository/IPC/原生保存实际落点，按同一 I1 授权继续 |
| 完成日期 | 2026-09-10 |
| 实施记录 | records/2026-09-10-workspace-05.md |
| 集成版本 | 随本轮 recovery/export 提交集成（父提交 9c88565）；T05 阶段验证源码摘要 fcf8008d9bbb4b33f1ba3db0a27742cd94109928ab739c71281f34e0728597fc |

#### 实现要点

完善 source/target/bilingual、顺序、SRT/LRC 与编码/换行，固定导出修订。提供估算结束时间、损失列表和不完整译文策略，不更改 source evidence。使用新版自有发布与清理，默认索引命名；不得依赖旧 exporter 或覆盖 addon。

original 继续导出原文件保留字节；source 始终以当前原文 cue 序列化，尤其双语导入/清轨后不得直接使用 rawText 夹回旧译文。imported 轨与 AI 轨均可 target/bilingual；无译轨或缺失项沿用显式不完整策略。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-05-1 | integration | required | 一次翻译后重启，切模式/顺序/格式导出并 parse-back；捕获模型调用计数始终不增长，覆盖 AC-WORKSPACE-06-1 | - |
| V-WORKSPACE-05-2 | unit | required | LRC 同起点/末条/offset、缺失/过期译文、格式精度/样式损失；用户选择前后计划对照，源时间 provenance 不变，覆盖 AC-WORKSPACE-06-2 | - |
| V-WORKSPACE-05-3 | integration | required | 临时目录同名、原生保存取消、写入失败/Windows 锁定、导出中提交新译文；核对目标完整性与单修订快照，覆盖 AC-WORKSPACE-06-3 | - |
| V-WORKSPACE-05-4 | integration | required | 双语文件整理后分别 original/source/target/bilingual 导出并 parse-back；清轨后 source 不夹带旧译文、target 拒绝，调用次数不增长，覆盖 AC-WORKSPACE-08-4 | - |
| V-WORKSPACE-05-5 | browser | required | 隔离 Electron 操作导出模式、格式/顺序、缺失策略、时长估算与损失确认；保存取消及真实文件读验，深浅主题/窄窗/键盘、最终截图审阅并清理实例 | - |

### T-WORKSPACE-06 UI 完整验收、v1 共存与移除演练

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-01, R-WORKSPACE-07 |
| 验收 | AC-WORKSPACE-01-1, AC-WORKSPACE-01-2, AC-WORKSPACE-07-1 |
| 依赖 | T-WORKSPACE-05 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/, src/pages/Tools/_shared/ui/toolBooleanControlConsumers.test.ts, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, test/subtitle-studio/, scripts/subtitle-studio/, src/locales/, src/i18n/resources.ts, tsconfig.json, tsconfig.node.json, scripts/i18n-usage-manifest.mjs, test/local-subtitle/jobManager.test.ts, test/local-subtitle/jobManagerIpc.test.ts, test/local-subtitle/subtitleExporter.test.ts, docs/features/subtitle-studio/, electron/main/local-subtitle/model-manager.ts, test/local-subtitle/authorizations.test.ts, test/local-subtitle/modelManager.test.ts, test/local-subtitle/resourcePath.test.ts, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root（本次 Windows 收尾串行执行；历史协作分工保留于前序记录） |
| 依赖确认 | T-WORKSPACE-05 已在 27cdca3 集成且包含于当前 3173616；通过最终新版导出与重启场景复核依赖可用。本次 A-06 明确授权仅补 T06/I1 收尾。Windows 最终隔离共存与实际移除副本均由本轮源码重新构建；旧模型/限定音频已具备并实际验证 |
| 完成日期 | 2026-09-10 |
| 实施记录 | records/2026-09-10-i1-closeout.md |
| 集成版本 | 随 fix(subtitle-studio): complete I1 Windows acceptance 提交集成，父提交 3173616，实际 SHA 以 Git 历史为准；最终 927 文件验证摘要 ef0be604e4b0a56967a0f248168e5a139081f851a23bb7d09ea70e80526997d7。任务技术完成，用户最终确认仍 pending |

#### 实现要点

完成状态、分页、窄窗口、键盘和 i18n。依照 transcription-fork.md 第 6 节在隔离副本移除 v1 与组合层旧贡献，彻底重建；本任务不授权删除用户工作树中的旧文件。若发现集成缺陷，将相应任务退回并记录实际写集，不在测试任务里绕过边界。

共存与移除演练分别取证。I1 不声称原生资源打包独立性已通过；I2 再补全。记录真实 API/UI/文件结果和待人工确认项，不把所有任务完成当作用户已验收。

2026-09-10 已完成新版 313 项本地测试、四语言/长文/空文/键盘 Electron 验证，以及共存和实际移除构建的导入→三批合成翻译→重启→12 组合导出。旧文件/偏好未改，移除副本保留工具 83 项通过；新版生产源码与最终共存构建逐字节一致。旧版相关回归 620 通过、5 失败，后者在未修改 HEAD 同样复现；旧转写未配置真实模型/音频，旧恢复仅验证空目录扫描及受控服务回归。默认 tsc 和 i18n usage 的既有失败仍在，故不标完成。所启动进程已清理。

2026-09-10 检查跟进：用户明确授权只处理默认 TypeScript、NameTranslator i18n 清单及旧字幕 5 项路径显示断言，验证后提交推送；复杂且影响面大的既有问题允许后置，禁止继续其他工作。在干净基线 27cdca3 上核对后完成这三项：两个 tsconfig 采用 Bundler 读取真实包类型，更新一条精确 i18n selector，按 8950e15 已定义的仅显示路径契约修复三个测试文件。root 独占 tsconfig/文档与集成，translation_ui 独占 i18n 清单，translation_protocol 独占上述三个旧测试文件，model_audit 只读复核模块解析。默认及构建配置 TypeScript、隔离 Vite/preload、i18n 与 282 项相关回归通过；未降低路径/token 保护或修改旧工具生产实现。此前记录中的失败为历史结果，本次结果见检查修复记录。保留原 AC，T06 因真实 ASR/历史恢复缺证据保持待验证，本轮到此停止。

2026-09-10 最终收尾：A-06 授权下完成真实旧版 CPU 转写与原生历史恢复（1/4 → 4/4，已提交分片未重译），2069 项相关回归通过；Windows 模型 move 的关闭句柄 ctime 问题及测试/演练可移植性问题已修复。最终共存构建四项 Electron 流程通过，移除构建独立流程及 87 项保留工具测试通过。默认/构建配置 TypeScript、i18n、边界和最终截图已核验。T06 技术完成，I1 用户最终确认仍 pending；不推进 I2。用户随后明确要求提交并推送，本轮随上述提交集成。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-06-1 | integration | required | 正常共存构建运行旧翻译/转写相关测试，隔离 userData 操作旧导入、恢复/重试和已有资源下的转写；比较旧源文件/偏好未改，覆盖 AC-WORKSPACE-01-1 | - |
| V-WORKSPACE-06-2 | integration | required | 执行边界正反例及隔离 v1 实际移除/全新构建；新版导入→翻译→重启→导出，无旧目录读取，覆盖 AC-WORKSPACE-01-2 | - |
| V-WORKSPACE-06-3 | browser | required | Electron 全流程、四语言、长文/分页/空文/窄窗口、键盘与状态区别；查看截图并检查 loading 已退出，覆盖 AC-WORKSPACE-07-1 | - |
| V-WORKSPACE-06-4 | static | required | 项目本地 tsc --noEmit；vite build --mode=test；node scripts/check-preload-bundle.mjs；node scripts/check-i18n.mjs；node scripts/check-i18n-usage.mjs；git diff --check | - |
| V-WORKSPACE-06-5 | integration | required | 新版全套 vitest 与相关旧版回归；检查所启动 Vite/Electron/子进程全部结束，记录未运行的平台/人工验证项 | - |
