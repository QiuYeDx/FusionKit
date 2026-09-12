# T-TRANSCRIPTION-01 生产来源冻结

| 字段 | 值 |
| --- | --- |
| 任务 | T-TRANSCRIPTION-01 |
| 日期 | 2026-09-11 |
| 验证版本 | 来源3a0f50ed15c1b63451402cecf27240182235e567；维护工具与规格为本次未提交工作树，最终摘要见下文 |
| 环境 | macOS arm64，Node20.19.5，已安装TypeScript/Vitest2.1.9，Git blob读取；没有安装依赖 |
| 任务指纹 | 8ffd64965bb097fc736d799686a95a1180f09b84e1425f5ff95d40b3509bfc58 |

## 实际结果

承接进度盘点后的用户继续指令，先完成I1审计补漏，再展开I2来源冻结。root负责规格、最终清单和集成；baseline_checks负责维护工具和隔离测试；workspace_progress与broader_roadmap分别独立审查生产和资源闭包。所有读取旧实现的代码都属于维护工具，新版业务没有反向依赖它们。

两份独立只读初查分别枚举84个生产图文件和231个资源/脚本/测试候选；这两个集合有重叠，不能相加当作最终复制文件数。最终权威来源为生成的 `resources/subtitle-studio/provenance/transcription-baseline.json`，包含固定Git来源、内容身份、实际解析边、拟议去向、默认值和资源身份，以及不能由AST证明的审计项。拟议去向不表示已复制，不提供尚不存在的副本hash。

### 生产与身份审查

23个主进程组装import连同executor、类型和实际配置入口形成26个根；静态生产闭包84文件（76个主进程模块、3个类型/配置、5个直接引入manifest），executor含type import的闭包为60文件。外部仅Node内置、Electron、zod、yauzl。没有未解析的静态本地import。overwrite-native-backend中的`createRequire(import.meta.url)(absoluteNodePath)`是需要显式核对的原生动态装载。

核对31处Symbol/WeakMap/WeakSet品牌位置，覆盖运行时、后端、PCM/窗口、server lease/pin/ticket和覆盖事务。副本必须使用自己的模块注册表并拒绝旧proof，类型名称一致不能证明所有权可互通。

旧main中的资源/服务组装、生命周期/IPC和旧翻译owner交接只留组合层证据，不整文件复制。旧renderer PostActionService依赖generatedSubtitleImportCoordinator，必须由新版文档翻译替代；旧页面、persist key和任务队列不成为新版状态源。

### 默认值与资源审查

默认值来自实际配置和sanitize：auto设备/语言、large-v3-q5_0、VAD开启、acoustic_quiet_v1、beam5、temperature0、500ms静音；停顿策略强制VAD。已有任务缺策略仍保持fixed，不能把新默认静默套给历史任务。CUDA large-v3 f16专属DTW资格保留，不推广到默认q5_0或所有后端。

冻结whisper.cpp v1.9.1 / f049fff95a089aa9969deb009cdd4892b3e74916；默认q5_0与可选f16模型、Silero6.2、CUDA12.4的预期大小/hash/平台来自5份Git跟踪manifest。Windows x64 CPU/CUDA与macOS arm64 CPU/Metal各自保留资源契约，当前没有新版的运行或签名结论。CUDA分发许可仍按源manifest保留待收口状态。

资源/脚本审查覆盖license/source-offer字节来源、beforePack的动态moduleUrl装载、runtime到whisper process-metrics helper、native编译源和Windows delay-load hook。C++中`.fusionkit-local-subtitle-`及`.fusionkit-overwrite`前缀、构建回执和签名identity需在副本阶段独立处理。旧validator和beforePack都限制单资源映射，必须后续新建真实组合配置/hook。

### 测试与下一阶段边界

最小确定性回放入口为productionExecutor、subtitlePostProcessor、serverContract、pauseWindowPlan、quietAudio；原基线5文件/280项实际通过。后续副本回放还应覆盖cue/overlap/separator扩展矩阵，比较完整transcript、请求计划、回退/重试、时间与去重决定。

runtimeFixture、acceleratorFixture、两份native test support和旧docs中的pre006-production-decision.json都有独立来源。必要旧docs fixture需复制到新版测试fixture；legacyIpcBridge保持旧版共存测试，两项旧preload测试等新版API契约后重写。未采用的质量研究不能仅因存在脚本就变成生产算法。

document sink的正确接点是production-executor最终separator处理、清理成功和取消检查之后的exportArtifacts边界。旧transcript允许200,000 segments，I1文档只有100,000 cues且origin/timing只接受SRT/LRC；接入前明确容量、来源与word/speaker/confidence承接，不通过SRT往返丢失信息、不静默截断。当前仅冻结，尚未改变这些业务契约。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-01-1 | 通过 | inline: test/subtitle-studio-provenance/generate.test.ts 17/17通过；固定重建、5类篡改、增删改漂移、CRLF、外部filter拒绝、相对/URL缺依赖、大小写目的冲突、动态表达式/源hash审计、静态默认值、缺根/语法错误均覆盖 |
| V-TRANSCRIPTION-01-2 | 通过 | inline: 最终--write、--check、--check-worktree均exit0，279文件/1605边；与独立84生产文件路径及SHA-256逐项完全匹配，固定历史重建逐字节一致，工作树无来源漂移；最终清单961850 bytes，SHA-256见下文 |
| V-TRANSCRIPTION-01-3 | 通过 | inline: 两名独立审查者核对84生产文件、31处品牌、默认值、资源脚本和fixture；发现的动态装载、native前缀、旧导出交接及文档容量差异均已记录，最终279文件清单资源/生产覆盖复查通过；两条测试到历史参考依赖已明确标copy-then-adapt |
| V-TRANSCRIPTION-01-4 | 通过 | inline: I1真实边界130文件/0错误、334项模块回归、两套TypeScript及i18n通过；当前规格ready/done --require-approval和git diff --check最终通过，无业务源码/锁文件改动 |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-01-1 | 通过 | V-TRANSCRIPTION-01-1, V-TRANSCRIPTION-01-2 |
| AC-TRANSCRIPTION-01-2 | 通过 | V-TRANSCRIPTION-01-2, V-TRANSCRIPTION-01-3 |
| AC-TRANSCRIPTION-01-3 | 通过 | V-TRANSCRIPTION-01-2, V-TRANSCRIPTION-01-3 |
| AC-TRANSCRIPTION-01-4 | 通过 | V-TRANSCRIPTION-01-1, V-TRANSCRIPTION-01-2, V-TRANSCRIPTION-01-4 |

## 最终集成与可复核摘要

清单包含279个来源：224项拟议复制、20项复制后适配、35项仅供参考；1605条AST/显式审计边，47个未采用研究文件列排除理由。9份资源JSON快照包含5份manifest及4份来源/许可证据。与独立生产图84项逐文件比对无缺失、无hash差异、无生产文件被误标仅供参考。

两条测试到参考来源的边保留且明确适配：whisper-server/supervisor.test.mjs使用历史run-poc；overwriteProductionRuntime.test.ts读取旧main组合入口。后续分别剥离PoC测试、改验新版组合，不把参考来源隐式带入新业务。

动态审计例外同时绑定精确源文件、表达式和源SHA-256；即使import(moduleUrl)文字不变，周围路径构造变化也会拒绝旧例外。真实生成前后均未执行业务模块或native。只读路径审计首次把所有绝对路径一概拒绝，命中的是原始FFmpeg来源回执的固定逻辑安装前缀；依FK-PIT-0034确认后保留`/opt/fusionkit/local-subtitle/ffmpeg/8.1.2`，本机用户/临时路径为0，不修改原始manifest掩盖证据。

| 文件 | SHA-256 |
| --- | --- |
| resources/subtitle-studio/provenance/transcription-baseline.json | c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66 |
| scripts/subtitle-studio-provenance/generate.mjs | 91a1422f702097d9f15aaf99873d4110e8c9de885e6fa806dc34a8fb76bd18c3 |
| scripts/subtitle-studio-provenance/policy.mjs | eaed99668990ceb5e0e64d5ecc77510c34d977280e02360c3ec8ff38931797b2 |
| test/subtitle-studio-provenance/generate.test.ts | 40f41c481be1bc1c461e62203a69c90ba92d5e70fcdaa7c18561085601a0ad31 |

```sh
node scripts/subtitle-studio-provenance/generate.mjs --check
node scripts/subtitle-studio-provenance/generate.mjs --check-worktree
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance
node node_modules/vitest/vitest.mjs run test/local-subtitle/productionExecutor.test.ts test/local-subtitle/subtitlePostProcessor.test.ts test/local-subtitle/serverContract.test.ts test/local-subtitle/pauseWindowPlan.test.ts test/local-subtitle/quietAudio.test.ts
```

当前T-TRANSCRIPTION-01已完成并在共享工作树集成，尚未提交Git。下一就绪阶段是按冻结清单机械复制与确定性回放；详细任务就近展开，不把本阶段done理解为整个I2完成。

## 风险与未执行项

本阶段没有复制/接线新版转写运行时，没有修改旧v1或真实用户数据，没有运行新模型/GPU、真实音频、安装包、签名或公证。Git中的预期二进制身份不等于本机实物验证；独立盘点里本机旧staging的只读hash核对不纳入可重建基线。I1/I2用户整体验收保持独立pending，本记录只证明当前来源冻结任务。未启动前端或原生模型服务，无本次服务进程需要终止；没有调用pnpm、安装依赖或更改锁文件。
