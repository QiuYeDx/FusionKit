# T08：默认 VAD 与 CPU/CUDA 固定样本对照

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-12 |
| 任务 | T-TRANSCRIPTION-08 |
| 验证版本 | feat/subtitle-studio-transcription，e80ef6b加T05–T08工作树；快照165ef2e9fb88355f8d0ab2b6f840dcad38b8493a682278f7f56fbc15ce90846b |
| 环境 | Windows x64，Node20.19.4、Vitest2.1.9、TypeScript5.9.3；RTX4070TiSUPER、驱动610.62 |
| 任务指纹 | 221a8fe81f86882cfdcae1a4b34b15718b914f11c4fbaae30bf85e85d8a32fa8 |

## 任务与版本

- 任务：T-TRANSCRIPTION-08；需求R-TRANSCRIPTION-08；2026-09-12完成本任务的固定样本迁移与资源验证。
- 授权：T07交付后用户再次要求“好的，继续推进工作吧”，按既有I2路线继续；不代签整体验收。
- Git基线：feat/subtitle-studio-transcription，e80ef6b6460a2c3a27c9f102078543ba07d29352，加T05–T08未提交工作树。
- 批准范围指纹：ef96924a85f3e48dc99c07e7e966dcd60f6e1a25af3458cbacc646a5daf78ccb。
- 任务指纹：221a8fe81f86882cfdcae1a4b34b15718b914f11c4fbaae30bf85e85d8a32fa8。
- 前置T07快照：dfd09dceaf788427f23b17198b0708e95c3e4bed920a8bb869e6be73d88f2ea4；开工30源文件与25运行制品逐项匹配。旧staging28文件、package.json与pnpm-lock.yaml同时冻结。
- 最终[源码与证据快照](2026-09-12-transcription-default-devices.snapshot.json)：165ef2e9fb88355f8d0ab2b6f840dcad38b8493a682278f7f56fbc15ce90846b；包含9源文件、22项证据及11文档的22个持久文件摘要。
- 最终实跑report.json SHA-256：87e8351f23f3d2ae0ef011207b5da9eeaa9f9a71c30545d899bb138f5e7072d1；独立审查final-quality-review.json SHA-256：9d2104e434b0557e0724fa314a62dcdafa5e8d2753a4062dde465acfd43de08d。

## 实际结果

新增维护侧真实资源fixture、矩阵harness、完整转录分析器及各自测试，生产源码与冻结副本不改。模型通过真实copy-import，VAD/CUDA仅下载传输替换为固定本地字节，其余验证、完整ZIP解压、探针、提交、重新解析与卸载均调用各域生产实现。

固定参数为large-v3-q5_0、ja、transcribe、VAD=true、acoustic_quiet_v1、beam5/temperature0/silence500/cue7000/84/42。保留原生产辅助separator及恢复请求，不把每个内部请求误当主配置。新旧逐项运行、每次新服务状态，默认24侧加CUDA A每侧固定一次重复；没有额外crop调参。

### 实物与输入

宿主为Windows x64，实际测试Node20.19.4，Vitest2.1.9；显卡RTX4070TiSUPER、驱动610.62、compute8.9、16376MiB。T07的Electron41.10.6原生验收单独保留，当前维护harness不是Electron UI或完整安装包测试。

| 输入 | 字节数 | SHA-256 |
| --- | ---: | --- |
| A，30秒 | 960078 | 196a524c3805cdc5cccd9711711220bc5591c04906be442c6fa00955874798c5 |
| B，30秒 | 960078 | 43e4541f77f7c9e0b9351431da61ff6912814f963159b17d5a51b1ba3b14bd93 |
| C，30秒 | 960078 | e57ad65505ebb1e8042939cb71023807d6761810c112fdcefc2653c54433b8b7 |
| B-noise，18秒 | 576078 | 2f979f0bbb50c3a3896cee437e9b9ea7bd7745bb55bbd4b6decf24280da0d510 |
| independent，175.993秒 | 5631844 | 9c80350769700f72edc5bd7e7428122f42b1c8eede81967dbe723e5fb7c4fc10 |
| full，216秒 | 83025744 | 9ae30957514dd75faa08464f3aeee6025cb2d9bdb98ae98bd703649451ded527 |
| large-v3-q5_0 | 1081140203 | d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1 |
| Silero VAD v6.2.0 GGML | 885098 | 2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987 |
| 官方CUDA12.4/v1.9.1完整ZIP | 677887125 | 106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b |

六样本均为已有工作区授权测试副本；full保留float32/stereo/48k原输入并走真实规范化，其他为16k/mono/PCM16。B/C是已有低声样本，B-noise来自历史无词句注释扩展，不当18秒逐时声学真值。旧记录full的两处seam重复及剩余分隔不足继续保留；旧full-large-v3/CUDA结果不当本轮q5精确文本预期。

### 有界失败与审查修正

首次run-6m5eEe完成旧版模型与VAD真实安装/加载，随后CUDA安装在preflight失败，尚未开始矩阵ASR。失败诊断完整保留于test-results/studio-t08/initial-resource-failure.log及该run/report.json；旧版两个实际加载进程均退出，真实卸载返回VAD/model已删、未安装CUDA不存在，独立managed根已移除，输入未变。该失败不计入质量通过。

根因用真实Node20 mkdtemp对照确定：现有managed路径140字符、receipt前缀247字符、目录253字符，报ENAMETOOLONG(-4064)；短managed93字符/目录206字符成功。探针目录均已清理，证据windows-cuda-path-probe.json。只缩短维护测试物理资源根，沿用原生产目录/UUID/校验；报告和文档根不变。系统临时根由本轮独占创建，最长安装路径预检，清理只针对该根。目录/ZIP/原生artifact要求<=245；文本manifest单独检查完整路径<260且父目录<=245。FK-PIT-0143记录此真实路径反例，不把元信息路径混称原生路径预算。

工具审查修正了清理超时后过早释放操作锁、无界等待观察结果、辅助请求误判，以及只校验text/time而遗漏完整文档字段的风险。FK-PIT-0142记录清理deadline与底层操作锁的区别；受控Promise负例不冒充发生过原生超时。

### 第二次运行的资源证据

run-dvZ4vI已在短根完成两侧真实资源准备：模型/VAD/CUDA作业均completed，各侧20个原生文件总计1199083008字节逐项匹配固定hash，两侧内容相等而物理inode不同。旧manifest/packGeneration为8036c8053606c16adcfd126b0afc963944afa29e4958b12faeb358ce299e7852，新版为cdf12c71912de60702d7ed4f989ddd87c6bfcdb91119de4dd3586621938f4079；各自匹配实际manifest，不能要求跨命名空间generation相等。准备进程22004/34508与32972/33040均退出，输入hash保持不变。此安装结论与后续真实CUDA PID证明分开。

实际CUDA证明来自本次server精确PID对应的生产attestor，14个CUDA任务共18次证明均verified=true；包含辅助separator的独立租约。其验证条件包含正GPU显存，回执未暴露具体显存字节数，故不补造数值。以A首轮为例，旧PID7528、新PID34532均具有真实CUDA加载、VAD模型及activeRequest状态；设备证明不能由安装成功或诊断文字替代。

### 最终矩阵与文档

run-dvZ4vI于2026-09-12 18:09:45–18:29:23（Asia/Shanghai）完成，整轮1178.506秒。26次真实链路包括默认24次和固定CUDA A每侧各一次重复：22次成功、4次真实no_speech_detected，无基础设施失败。13组配对终态全部一致；11组成功canonical比较包含ID、文本、时间及其余字段，均无差异；2组同侧A首轮与重复控制也完全一致。新版11份schema2文档完整映射、preservation/digest及关闭后重开均通过。

下表耗时为各链路记录的总耗时（秒，旧/新，包含准备和清理），不是纯推理速度基准；字幕数列为各设备下新旧共同结果。

| 样本 | CPU字幕数 | CPU耗时旧/新 | CUDA字幕数 | CUDA耗时旧/新 |
| --- | ---: | --- | ---: | --- |
| A | 4 | 26.692 / 26.717 | 5 | 10.356 / 10.022 |
| B | 1 | 19.671 / 19.925 | 1 | 8.655 / 9.113 |
| C | 3 | 21.791 / 23.414 | 3 | 13.792 / 13.745 |
| B-noise | 无文档 | 5.190 / 5.197 | 无文档 | 8.428 / 8.791 |
| independent | 37 | 201.676 / 201.606 | 37 | 19.340 / 19.422 |
| full | 56 | 188.979 / 188.530 | 60 | 24.685 / 25.468 |
| A固定重复 | 不适用 | 不追加CPU重复 | 5 | 10.263 / 10.602 |

CPU与CUDA的A（4/5条）及full（56/60条）存在分句、文本或时间差异，本任务只要求同设备同参数的新旧迁移保持，不要求跨后端相等，也不据条数评价效果提升。原始报告的qualityStatus保留requires_review，自动比较无差异不等于整体识别质量通过；以下人工审查与用户整体验收分开记录。

### 真实路径与质量审查

- A无实际增益；B两设备实际施加12dB增益与1000ms VAD padding。C主请求无增益；CUDA C另有真实no-VAD separator候选，最终保留主请求三条字幕。C末条持续11060ms，属于新旧共同可读性局限。
- B-noise四次均走实际18秒请求、12dB增益及1000ms padding，原始识别为空并真实失败；没有canonical或新文档。不据空ASR推断声学静音。
- independent实际规范化2815883帧，49个quiet候选，7窗口、6个安全切点26100/52010/77380/101850/126850/152140ms，无重叠；切点两侧均满足实际quiet保护区。各链路10次请求包含7次增益及3次原音回退（w000001/w000003/w000005），原音回退确实更换WAV内容并取消增益/padding；新旧同设备请求、窗口hash和完整原始结果一致。最终保留请求序号1/3/4/6/7/9/10，对应37条字幕；不能把被舍弃的增益与原音观察重复算成最终重复字幕。
- full真实处理float32/stereo/48k输入，规范化为16k/mono/PCM16、3456000帧；7个quiet候选、9窗口。96140/114980ms为安全切点，其余27500/52500/77500/142480/167480/192480ms为5秒overlap回退。CPU为9次主请求，CUDA为9次主请求加1次separator辅助请求；各自同设备新旧原始结果、请求和窗口内容相等。
- 人工检查full保留历史142480/192480ms的文本变体重复，以及本轮q5下共同可见的27500/77500ms接缝变体。CPU对应cue 3→4、16→17、31→32→33、49→50；CUDA对应3→4、19→20、33→34→35、51→52。77500ms附近含140ms短条，142480ms附近CPU含60ms、CUDA含140ms短条。完全相同文本重复检测为空也不能排除这些实际变体重复。它们在同配置新旧两侧一致，无证据表明是此次迁移引入；新增观察仅登记共同风险，不扩展质量接受范围，不调阈值、加特例或追加crop试验。

### 清理与隔离

两侧真实卸载均确认模型、VAD、CUDA已删，manager关闭、各侧目录及独占TEMP根移除成功，joined=true、cleanupPending=false。26条链路记录的进程均退出；最终独立CIM检查没有whisper/ffmpeg/ffprobe进程，且本次确切TEMP根不存在。输入前后hash不变，integrityErrors为空。

最终实测六源文件逐项匹配开跑snapshot。T07快照30源文件中29项不变，仅避坑索引因登记FK-PIT-0142/0143预期增加；25个新版运行制品、28个旧staging文件和package.json/pnpm-lock.yaml均不变。T07历史快照未重写。此前误触工具包装器生成的单个工作区.pnpm-store缓存，经归属/路径/无链接/内容核对后清除，证据store-cleanup.json；没有依赖变更。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-08-1 | 通过 | inline: test-results/studio-t08/real-default-comparison/run-dvZ4vI/report.json记录两域实际模型/VAD/CUDA安装、全ZIP验证/解压/探针/解析与最终真实卸载；固定输入hash不变，旧staging28文件无变化 |
| V-TRANSCRIPTION-08-2 | 通过 | inline: 同一report包含26条真实链路、13组终态配对、18次精确PID CUDA证明、真实quiet/overlap及增益回退；final-quality-review.json核对两组同侧A重复完整canonical/raw一致 |
| V-TRANSCRIPTION-08-3 | 通过 | inline: 同一report中11组成功完整canonical无差异，11份schema2文档完整映射及关闭重开通过；4次no_speech_detected没有文档。final-quality-review.json及本记录保留共同接缝和可读性局限，不自动接受质量 |
| V-TRANSCRIPTION-08-4 | 通过 | inline: tooling-unit-final.log为51项通过、1项真实ASR显式跳过；资源路径/固定输入/清理锁/观察器/完整文档和差异分析负例通过；显式real-default-comparison.log中实际26条链路通过 |
| V-TRANSCRIPTION-08-5 | 通过 | inline: core-regression.log130项、frozen-regression.log89项、checkout-boundaries.log8项；boundaries.log333文件0错误，typescript-root/node/harness-final通过。spec-done.json及git-diff-check.log通过；final-process-source-check.json确认原生进程为空、独占根不存在及6源无漂移，isolation-current.json确认T07资源与原输入不变 |

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-08-1 | 通过 | V-TRANSCRIPTION-08-1 |
| AC-TRANSCRIPTION-08-2 | 通过 | V-TRANSCRIPTION-08-2 |
| AC-TRANSCRIPTION-08-3 | 通过 | V-TRANSCRIPTION-08-3 |
| AC-TRANSCRIPTION-08-4 | 通过 | V-TRANSCRIPTION-08-2, V-TRANSCRIPTION-08-3 |
| AC-TRANSCRIPTION-08-5 | 通过 | V-TRANSCRIPTION-08-4, V-TRANSCRIPTION-08-5 |

相关普通检查共278项通过：核心130项、冻结来源/回放90项、边界7项、新工具51项；普通新工具命令另有1项真实ASR显式跳过。显式实跑使用FUSIONKIT_REAL_ASR=1与FUSIONKIT_REAL_DEFAULT_ASR=1，4项Vitest通过，其中1项实际串行执行26条链路，另3项观察器单元已计入上述51项，不重复累加。实际边界333文件0错误；根/构建侧TS与最终harness专属TS均通过。spec done要求approval的检查及git diff --check通过。

维护测试直接调用已安装Node20与Vitest/TypeScript入口，不经包管理包装器。原始日志、请求、转录、文档及失败诊断保留在Git忽略的test-results/studio-t08/；源码与证据hash见本记录配套snapshot.json。快照不收录私有转录文本或系统绝对路径；测试输入、模型和build资源不随Git分发，换机需按来源重新准备，不能只凭摘要声称实物就绪。

## 风险与未执行项

本次完成固定Windows样本迁移验证，不扩展为所有音频或整体ASR准确率承诺。接缝重复、分隔不足及可读性风险如上保留，I1/I2用户整体验收仍pending。完整应用共存/移除打包、macOS完整资源、签名/公证、许可分发闭环及用户整体验收仍未执行；CUDA冻结清单的acceptance/license状态未伪改为通过。

下一项沿既定路线做Windows完整应用共存/移除包演练。当前T05–T08工作树尚未提交；没有读取NAS或真实userData，也没有开启前端服务。测试模型与CUDA包已从独占测试根卸载，不代表已安装到用户应用资源页。
