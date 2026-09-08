# 转写继承、资源归属与 v1 删除验证

本文是 I2 的架构边界和进入计划，不是 I2 已获实施授权或验证通过的记录。I1 不必等待原生推理对比才能开发。

## 1. 已核对的基线

设计查阅基线：`152b5632bcac4d93e8d44530c892fa9b55776463`，2026-09-08。复制发生在 I2 时，重新核对实际工作树；如果 v1 在此期间修复，冻结有效生产版本，不能机械复制本次较旧快照。

| 现有来源 | 继承意义 |
| --- | --- |
| `electron/main/local-subtitle/production-executor.ts` | 实际调度、质量恢复、局部增强和最终后处理编排；不能只参考原始 Whisper API |
| `media-normalizer.ts`、`pcm-window.ts`、`quiet-audio.ts` | 音频归一化、窗口来源、低音量调理与原音回退 |
| `pause-window-plan.ts`、`subtitle-post-processor.ts` | 停顿分块、窗口策略和质量约束 |
| `cue-boundary-planner.ts`、`cue-separator-restorer.ts`、`cue-display-separators.ts` 及 production-executor 实际引用的 cue/overlap 模块 | 句界、时间证据、短句起点、跨窗重复处理；按闭包复制而非挑几个看似核心的文件 |
| `server-supervisor.ts`、`server-contract.ts`、`server-http-client.ts`、server/process/session 系列 | 模型驻留、任务状态隔离、取消、长请求及时间域合同 |
| resource/model/vad/accelerator 的 manifest、manager、path、download 模块 | 资源身份、校验、平台解析、下载与清理 |
| `src/type/localSubtitle.ts`、`localSubtitleIpc.ts` 及前端配置快照 | 有效默认值、受支持路由与冻结任务参数；复制必要定义到新命名空间，不能 type-import v1 |
| `test/local-subtitle/` 与对应类型/配置测试 | 边界与回归基线；复制相关 fixture/helper，不保留测试对旧实现的 import |
| `resources/local-subtitle/`、`scripts/local-subtitle/`、`electron-builder.json` | 原生二进制、构建/签名/校验依赖；路径字符串也在复制范围审计中 |

以上是已发现的能力簇，不冒充完整机械依赖清单。I2 的首项工作才产出逐文件闭包和 hash。

当前默认的依据是 [停顿分块推广记录](../../v0.2.11/subtitle-quality-harness/phase13-cross-window-reconciliation/pause-default-rollout.md)：新安装采用 acoustic_quiet_v1 + VAD，保留 fixed_v1 选择与旧任务冻结语义。记录明确仍有已知接缝重复，不宣称全部问题根治。移植必须复制生产生效路径，不导入仅存在于研究脚本中的未采用候选。

已有质量限制见 [第十二阶段收束](../../v0.2.11/subtitle-quality-harness/phase12-sentence-boundaries/records/2026-09-06_T-SEG-08C_context_stop_decision.md)。这些是历史证据来源，不是新版测试必须读取的运行依赖。

## 2. 复制而非提取改造 v1

采用两阶段 fork：

1. **机械复制并建立身份。** 冻结生产源码、默认配置、manifest、二进制身份、测试和必要脚本；复制到新版命名空间，先仅调整 import、资源根、类/品牌身份和服务构造。原文件不移动、不变成 re-export、不改 v1 调用方。
2. **接入新版文档。** 在复制后的生产链最终 transcript 边界接入 document sink。保持推理、回退和后处理结果不变，删除副本中不再需要的旧文件交接/自动翻译/UI 集成；对副本逐项验证后才能收缩依赖。

production-executor 当前绑定 job-manager、authorizations、exporter 等，不是可直接取出的纯函数。最初复制必要闭包后，再将输出边界换成新版 `TranscriptionResult → SubtitleDocument`；不能拿旧 exporter 伪造成功，也不能让新 job 通过旧 IPC 执行。

闭包包含类型、品牌 Symbol/WeakMap、工具函数、静态资源、manifest loader、平台脚本、native addon 及测试 helper。相同类型名不意味着品牌验证可互通，两个版本的授权对象不得交叉使用。

拟议 provenance 文件：`resources/subtitle-studio/provenance/transcription-fork.json`。字段包括来源 commit、源码相对路径与 SHA-256、目的路径、复制后 hash、保留许可、运行时/model/VAD 版本与内容 hash、默认策略快照、fixture 摘要、排除项及原因。单个大模型文件不提交 Git，以受管下载/本地导入 manifest 重建。复制后业务构建和测试只消费新版副本；provenance 里的历史路径是说明，不触发运行时读取。

不将 v1 整个前端复制成第二套旧任务 UI。模型环境管理等可复制必要控件，最终状态源和 IPC 均属于新版。v1 到新版的“导出文件再导入”可由用户手动使用，但不是新版 ASR→翻译的内部数据流。

## 3. 质量与行为等价门

### 确定性回放

固定旧版原始响应、PCM 窗口身份、配置和增强响应，经旧基线与新版副本处理后比较：源文字/标点、cue 数量与顺序、起止时间、时间证据、去重决定、回退次数及请求计划。只允许应用身份、显示路径和新文档封装不同；任何语义差异都要定位，不能在复制任务里顺手调参并宣称等价。

生产路径应覆盖停顿与 fixed 两种窗口策略、低音量原音回退、合法重复发言保留、重复接缝仲裁、未知句界保留，以及 CUDA large-v3 专属 DTW 的资格边界。不能把当前特定模型/后端能力泛化到所有路由。

### 有界真实样本

优先使用现有可访问且用户已允许本地处理的样本：此前开头短片段、完整音轨、低音量语音及噪声反例、跨窗接缝、无安全停顿的回退；从已有记录定位实际文件，缺失就明确登记，不能写成通过。原音只读、不上传、输出在独立测试目录。

相同模型、量化/后端、语言、beam、VAD、窗口、增益和运行时版本对照。原生推理允许非确定性，不能要求所有运行逐字相等，也不能只用 cue 数或 parse-back 证明质量。比较遗漏/添词/重复、关键已听校时间点、可读性与新增成本；差异提供可听校片段和原始记录。既有确定性修复丢失视为回归；同等配置下明确新增质量退步需修复或等待真实用户接受，不能由 Agent 代签。

不为复制建设新的大型语言排行榜，不更换 ASR 引擎，不重新展开已被用户停止的无限调参。旧版已接受的缺陷继续记录，不将“保持基线”描述成“全部修复”。

### 生命周期与集成

重复任务、取消再运行、CPU 回退、窗口关闭、异常退出、应用关闭均验证新实例清理。同进程请求序列复核 VAD 状态隔离；不存在旧 supervisor/runtime 实例调用。新版 transcript 直接导入文档后保持词时间、说话人、置信度和来源，不先降为 SRT/LRC。

## 4. 模型与原生资源隔离

- 新版独立资源 manifest、受管下载/导入、安装回执和目录。不能扫描并默认为可用的 v1 userData/model 目录，也不能持久引用 v1 路径。
- 允许用户显式选择已有模型作为一次性本地导入：在主进程校验预期模型 hash、复制到新版目录、验证副本后登记；磁盘空间不足时明确失败，不改用指向源文件的链接。读入后新版可在 v1 文件删除时继续工作。
- 默认接受双份占用，不先实现共享缓存、硬链接、符号链接或自动去重。未来若建设应用级内容寻址资源服务，需独立引用计数/删除契约；不能以“共用一个模型文件”绕过所有权问题。
- 每个版本拥有独立进程、端口、临时文件、锁和能力注册表。二者并用可能增加显存压力；新版按实际资源失败给出重试/CPU 选择，不修改或杀死 v1 正在运行的任务。I2 再验证两工具并用的受限资源行为，不保证单卡同时承载两套大模型。
- FFmpeg、ffprobe、whisper-server、平台依赖和必要 addon 的版本及签名/最终字节 hash 都进入新版资源闭包。打包不能退回依赖开发机 PATH。

## 5. 已发现的打包阻点及方案

当前 `scripts/local-subtitle/runtime/validate-runtime-staging.mjs` 的 assertBuilderConsumptionContract 严格要求旧 beforePack 路径、恰好一项 extraResources、恰好一项 mac.signIgnore；`electron-builder.json` 也只配置旧 local-subtitle 目标。因此“直接给 extraResources 多加一项”不是可执行方案。

I1 不引入新版原生资源，保持现有构建路径。I2 新增应用层的双工具打包配置（拟议 `electron-builder.subtitle-studio.json`）和组合校验入口（`scripts/packaging/subtitle-studio-before-pack.cjs`）；保留旧 builder 配置和旧工具脚本内容不动。新配置可作为并存版本的构建入口，正式默认入口切换在发布集成时处理，不自动发布。

组合校验器验证实际最终配置中每套资源的准确映射、平台矩阵和签名规则；新版脚本目录中复制所需的纯验证/打包依赖，用完整新配置契约替代旧“仅一项”假设。旧资源仍执行同等二进制完整性、addon 和签名校验，不能伪造缩小后的 config 去骗旧 hook，也不能禁用校验。旧独立打包入口仍可运行。

新配置的文件完整性、macOS 嵌套签名与最终 hash 顺序都需要平台证据；Windows 通过不冒充 macOS 通过。复制后的新版资源构建与校验脚本不得 import/call `scripts/local-subtitle/`。组合层可以列出 v1 资源贡献，但移除它后不得留下新版对旧资源的需要。

## 6. 可删除性作为持续验收

维护 `scripts/subtitle-studio/boundaries.json` 的新版根、允许应用基础设施、v1 专属根与组合层贡献。静态工具检查 import/export/type import/dynamic import 的传递图，以及 IPC/资源/脚本路径；加入故意引入旧 import、barrel 转发、测试 helper 和旧资源字符串的反例，不能只搜索一个目录名。

在隔离临时工作副本实施删除演练，不删除用户工作树或真实 userData：

1. 复制当前待验证代码和明确的依赖环境，记录版本；不使用旧 dist 掩盖源码缺失。
2. 按清单移除两套 v1 专属代码、类型、测试、脚本和资源，以及 App/main/preload/工具元数据/旧 Agent 中的 v1 注册贡献。保留非 v1 工具仍使用的应用基础设施；逐符号处理混合文件，禁止整文件误删。
3. 移除 v1 的构建资源、beforePack 和签名贡献，清空隔离副本的构建输出，以新版构建组合重建。
4. I1 证明新文档导入、翻译、重启、再导出可运行；I2 再证明只含新版原生资源的打包版本可转写、取消并关闭。
5. 在隔离用户目录准备文档及新版模型副本，移除模拟的旧数据/模型目录，重启新版并导出/转写；确认没有旧路径回读。清理新版任务也不能删除模拟 v1 文件。
6. 原共存构建另行复核 v1 普通任务、恢复/重试和转写链路，记录未改动的基线问题。二者证据分别记录，删除演练不能代替共存验证。

I1 的删除演练只证明当期已有能力；不能提前宣称原生运行时独立性已通过。实际从产品删除 v1 仍需未来用户指令，本设计只保证届时能够安全移除。

## 7. I2 开始时的工作顺序

冻结有效基线与闭包 → 复制源码/测试/manifest 并验证回放 → 新版资源管理和进程生命周期 → transcript 到文档适配 → 新版转写 UI → 有界真实对照与听校 → 共存及删除后的打包演练。

各阶段就近细化任务；第一步不会重写 v1，也不会要求先改善旧版所有已知缺陷。
