# I1 任务台账

本文件是唯一任务状态源。依赖完成不等于已集成，实施时须登记实际版本。当前只展开 I1，按以下顺序连续推进；真实实施授权登记于 spec.json。

执行恢复：2026-09-08 用户在 UI 优化后明确回复“好，继续推进工作吧”；暂停历史与恢复来源登记于 spec.json。

2026-09-08 UI 跟进：按用户“提交代码并推送，然后修一下”上下空白的指令，先推送 T02，再修复工作台纵向布局；实现与 Electron 验证见 [布局记录](../../records/2026-09-08-layout-height.md)。纵向布局已按后续用户指令提交为 `ddf178b`；随后优化原始内容密度，见 [密度记录](../../records/2026-09-08-raw-density.md)，该项尚未提交。T03 未开始。

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
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-04 |
| 验收 | AC-WORKSPACE-04-1, AC-WORKSPACE-04-2 |
| 依赖 | T-WORKSPACE-02 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, test/subtitle-studio/, src/locales/ |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

审计应用通用模型客户端及重试层，不改旧翻译模块。新 planner 生成带源修订映射的短 ID 和文本上下文，共用实际请求序列化做预算与预估。支持普通文本和声明过的简单内联保护，不要求译文视觉行数与原文一致。完整批次校验后写入译文轨；显示实际或未知 usage。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-03-1 | unit | required | 捕获请求正文与上下文、比较 planner 估算/执行输入；响应乱序、源时间不变、usage 缺失；覆盖 AC-WORKSPACE-04-1 | - |
| V-WORKSPACE-03-2 | unit | required | 漏/重复/未知 ID、截断 JSON、保护标记漂移、Unicode/超长单元反例；确认整批拒绝及只重试该批，覆盖 AC-WORKSPACE-04-2 | - |
| V-WORKSPACE-03-3 | integration | required | 用明确配置并允许发送的合成短字幕做真实 API 请求，核对译文对应、用量及 source 不变；缺配置记录待验证，不上传用户文件替代 | - |

### T-WORKSPACE-04 批次恢复、取消与旧结果防护

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-05 |
| 验收 | AC-WORKSPACE-05-1, AC-WORKSPACE-05-2 |
| 依赖 | T-WORKSPACE-03 |
| 写集 | electron/main/subtitle-studio/, src/subtitle-studio/, src/services/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, test/subtitle-studio/, src/locales/ |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

固定任务配置，检查源/轨修订与 generation；一文档一个活动翻译任务，应用级请求并发有界。落实 interrupted/needs_configuration、恢复未提交批次、单层退避及 Retry-After。取消任务不能撤销已提交译文，也不能接受迟到结果。请求成功但本地未提交的未知计费单独记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-04-1 | integration | required | 两批以上：第一批提交后故障/进程关闭，重启继续；捕获调用次数；配置删除/变化、取消与迟到结果，覆盖 AC-WORKSPACE-05-1 | - |
| V-WORKSPACE-04-2 | unit | required | 注入源/轨修订和 generation 冲突、重复启动、多文档同时运行；限流/退避取消与重试计数，覆盖 AC-WORKSPACE-05-2 | - |

### T-WORKSPACE-05 多模式导出与发布一致性

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-06 |
| 验收 | AC-WORKSPACE-06-1, AC-WORKSPACE-06-2, AC-WORKSPACE-06-3 |
| 依赖 | T-WORKSPACE-04 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, test/subtitle-studio/, src/locales/ |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

完善 source/target/bilingual、顺序、SRT/LRC 与编码/换行，固定导出修订。提供估算结束时间、损失列表和不完整译文策略，不更改 source evidence。使用新版自有发布与清理，默认索引命名；不得依赖旧 exporter 或覆盖 addon。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-05-1 | integration | required | 一次翻译后重启，切模式/顺序/格式导出并 parse-back；捕获模型调用计数始终不增长，覆盖 AC-WORKSPACE-06-1 | - |
| V-WORKSPACE-05-2 | unit | required | LRC 同起点/末条/offset、缺失/过期译文、格式精度/样式损失；用户选择前后计划对照，源时间 provenance 不变，覆盖 AC-WORKSPACE-06-2 | - |
| V-WORKSPACE-05-3 | integration | required | 临时目录同名、原生保存取消、写入失败/Windows 锁定、导出中提交新译文；核对目标完整性与单修订快照，覆盖 AC-WORKSPACE-06-3 | - |

### T-WORKSPACE-06 UI 完整验收、v1 共存与移除演练

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-01, R-WORKSPACE-07 |
| 验收 | AC-WORKSPACE-01-1, AC-WORKSPACE-01-2, AC-WORKSPACE-07-1 |
| 依赖 | T-WORKSPACE-05 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/, src/services/subtitle-studio/, src/store/tools/subtitle-studio/, test/subtitle-studio/, scripts/subtitle-studio/, src/locales/, src/i18n/resources.ts, docs/features/subtitle-studio/ |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

完成状态、分页、窄窗口、键盘和 i18n。依照 transcription-fork.md 第 6 节在隔离副本移除 v1 与组合层旧贡献，彻底重建；本任务不授权删除用户工作树中的旧文件。若发现集成缺陷，将相应任务退回并记录实际写集，不在测试任务里绕过边界。

共存与移除演练分别取证。I1 不声称原生资源打包独立性已通过；I2 再补全。记录真实 API/UI/文件结果和待人工确认项，不把所有任务完成当作用户已验收。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-06-1 | integration | required | 正常共存构建运行旧翻译/转写相关测试，隔离 userData 操作旧导入、恢复/重试和已有资源下的转写；比较旧源文件/偏好未改，覆盖 AC-WORKSPACE-01-1 | - |
| V-WORKSPACE-06-2 | integration | required | 执行边界正反例及隔离 v1 实际移除/全新构建；新版导入→翻译→重启→导出，无旧目录读取，覆盖 AC-WORKSPACE-01-2 | - |
| V-WORKSPACE-06-3 | browser | required | Electron 全流程、四语言、长文/分页/空文/窄窗口、键盘与状态区别；查看截图并检查 loading 已退出，覆盖 AC-WORKSPACE-07-1 | - |
| V-WORKSPACE-06-4 | static | required | 项目本地 tsc --noEmit；vite build --mode=test；node scripts/check-preload-bundle.mjs；node scripts/check-i18n.mjs；node scripts/check-i18n-usage.mjs；git diff --check | - |
| V-WORKSPACE-06-5 | integration | required | 新版全套 vitest 与相关旧版回归；检查所启动 Vite/Electron/子进程全部结束，记录未运行的平台/人工验证项 | - |
