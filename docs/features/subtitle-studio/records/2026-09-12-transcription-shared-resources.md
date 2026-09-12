# T09：共享转写资源与已有安装接管

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-12 |
| 任务 | T-TRANSCRIPTION-09 |
| 验证版本 | feat/subtitle-studio-transcription，99d064719d7ec93dea02944a9bfde31c4afec221加本轮工作树；文件摘要见配套snapshot.json |
| 环境 | Windows x64，Node20.19.4、Electron41.10.6、Vitest2.1.9、TypeScript5.9.3；RTX4070TiSUPER |
| 任务指纹 | 68902cf864b9600d4cedc6c1d9cbc5f15b304e489abb016c92527dae98884b47 |

## 任务与版本

- 任务：T-TRANSCRIPTION-09；需求：R-TRANSCRIPTION-09；2026-09-12完成。
- 授权：用户明确要求“可以，先别管打包演练的事，先把上面说的共享资源调整给彻底做好做完”。本轮完成共享资源，不开展打包演练。
- Git基线：feat/subtitle-studio-transcription，99d064719d7ec93dea02944a9bfde31c4afec221；T09为本轮未提交工作树，T01–T08历史证据保留。
- 批准范围指纹：adf628f3e91baa6a73f554d25ba6ca2088aa4d6b2f7021d78663ad9db0b3acbd。
- 任务指纹：68902cf864b9600d4cedc6c1d9cbc5f15b304e489abb016c92527dae98884b47。
- 环境：Windows x64，Node20.19.4、Electron41.10.6、Vitest2.1.9、TypeScript5.9.3；RTX4070TiSUPER、驱动610.62。
- 最终源码、维护入口、日志、截图及真实报告摘要见[集成快照](2026-09-12-transcription-shared-resources.snapshot.json)。原始内容位于Git忽略的test-results/studio-t09及studio-t09-ui，不把模型、私有转录文本或用户绝对路径纳入版本化快照。

## 实际结果

应用主进程唯一的SpeechResourceService管理userData/speech-resources。两款模型、Silero VAD和兼容CUDA包共用同一份文件和安装状态；下载、导入、校验、安装、取消、删除与资源作业历史均归应用。两工具保留独立的业务队列、媒体与server会话、文档和能力对象。固定ASR算法副本没有修改；内置Whisper/FFmpeg及事务addon继续按各域现有清单验证。

中立资源引擎和类型不导入旧工具或Studio私有实现。来源审计精确记录29个源、31个输出与195处必要字节变换；6份历史回执单独复制到中立目录；11项当前接线和5个旧工作树维护豁免单独登记。旧120项冻结副本及历史baseline/fork保持原有来源。Git属性为新增精确输出保留LF，3份原本CRLF的legacy历史回执保留CRLF；实际core.autocrlf checkout反例通过。构建闭包测试令旧工具源码/资源目录不可用，共享服务与Studio两个入口仍可独立bundle；没有声称完整移除版应用包已验证。

迁移只处理两个固定历史根中清单对应的最终资源目录。严格检查完整树、无链接、尺寸、hash和对象身份后，同盘移动大型payload；仅按固定内容转换小manifest。先持久记录事务，再提交和验证最终目标，最后处理已验证的重复源。故障恢复不接受任意目录；损坏、未知或不兼容文件保留并显示问题。EXDEV不默默复制或删除。26个迁移测试覆盖五个已持久断点、去重、篡改、目录替换和权限/文件系统失败；尚未形成有效journal的未知事务保留并阻止初始化，不能将其写成所有崩溃窗口都自动恢复。

同步使用租约覆盖准入首个await，随后由排队、运行、清理及warm server占用接续保护；文件解析也持读租约。任一工具忙碌时禁止另一工具删除/安装对应资源，资源维护同时只允许一个变更。终态事件不提前释放实际finally清理锁。页面退出仅释放订阅，下载可由另一页面继续观察或取消。CUDA公开ID通过固定别名映射，每域复验同一共享包并签发本域proof，实际推理仍取得本次进程的设备证明。

两个资源页显示共享归属、进度、迁移问题和维护按钮状态；跨页删除/安装自动失效并刷新资源缓存。轻量状态轮询不重复hash或执行后端probe；资源终态变更同时清除已有及待处理后端预览缓存，迟到结果不能覆盖新状态。旧copy/move和Studio copy导入语义保留。Studio新增共享资源删除确认，明确影响两个工具；主进程仍独立拒绝busy操作，旧接口将中立错误转换为原有可信错误类。

## 真实已有资源迁移

先对实际FusionKit旧资源目录做只读清单和内容校验；当时无用户应用或转写进程。通过真实Electron app.setPath与requestSingleInstanceLock取得同一userData独占权后，运行生产迁移服务。维护入口只接受固定目录，逐层校验无链接，使用同一文件句柄hash和前后fstat，关闭句柄后复验dev/ino/size；23个payload的迁移前身份以wx+sync持久保存，允许失败后进入生产journal恢复再核验身份。

2026-09-12 20:32:12完成实际接管：

| 资源 | 结果 |
| --- | --- |
| large-v3-q5_0 | 从local-subtitle迁入共享目录，两工具ready |
| large-v3 | 从local-subtitle迁入共享目录，两工具ready |
| Silero VAD v6.2.0 GGML | 从local-subtitle迁入共享目录，两工具ready |
| Windows x64 CUDA12.4/v1.9.1兼容包 | 20个原生文件迁入共享目录，两域各自复验ready |

23个原生payload共5376141792字节，迁移前后dev/ino/size/hash一致，保留原文件对象；下载次数0、模型加载smoke次数0，migration issues为空、cleanupPending=false，两个入口均返回精确4项ready。维护进程完整清理后才写成功报告，随后退出。证据为user-resources-before.json、user-resource-payloads-before.json、user-resources-migration.json及migrate-installed-resources.ts/mjs；原始路径仅在本机证据中。

## 共享CPU/CUDA真实对照

最终real-shared-sMRxt5于20:28:54–20:30:37执行。固定输入为既有30秒A.wav、large-v3-q5_0、Silero VAD和固定CUDA ZIP，参数沿用T08默认VAD/acoustic_quiet_v1。隔离短目录仅准备一份legacy安装，调用生产迁移后验证payload身份不变，移除模拟旧最终资源目录，再让两工具消费同一共享路径。每域仅临时会话和原生进程独立；未伪造推理响应或设备证明。

| 链路 | 字幕数 | 耗时秒 | 实际新进程PID | 结果 |
| --- | ---: | ---: | ---: | --- |
| CPU旧工具 | 4 | 28.011 | 32148 | completed |
| CPU工作台 | 4 | 26.915 | 34252 | completed，文档重开成功 |
| CUDA旧工具 | 5 | 8.112 | 38112 | completed，生产设备证明verified |
| CUDA工作台 | 5 | 8.127 | 27864 | completed，生产设备证明verified，文档重开成功 |

耗时用于审计执行，不作为性能基准。相同设备下新旧完整canonical完全一致；两个schema2文档的preservation、映射、投影、digest及关闭后重开均通过。CPU和CUDA之间存在原有分句/文本差异，本轮不修改质量配置。A短样本用于共享迁移回归，不替代T08固定矩阵或人工质量接受。

两次CUDA真实proof分别绑定上述精确PID及各域runtimeGeneration，acceleratorResourceId同为speech-windows-x64-cuda-12.4-v1，packGeneration同为96eee2a1cf5b73ff4f6ac183ba498a31a03b1f6e8e3d3189782410bfdf370a82。原输入前后hash不变，观察器无错误。legacy-consumer、studio-consumer、dedicated-smoke、shared-resources四阶段全部joined，server disposed、全部观测PID退出、独占临时根移除。

首轮real-shared-Idlbo2中四次真实转写也完成，但统一退出失败，未计入通过。根因是冻结旧JobManager.shutdown将completed记录改为fenced，busy谓词只排除terminal/removed，成功关闭后仍返回占用。当前组合层只在完整消费者cleanup成功后停止使用其busy谓词；失败或超时继续保护。新增真实JobManager状态迁移及后续media清理失败反例；不修改冻结任务管理器或忽略所有fenced任务。Harness新增嵌套AggregateError/cause/stack及逐阶段退出证据。此经验已登记FK-PIT-0144。

首轮报告保持failed。确认测试进程已退出、24项安装文件身份一致且目录无链接后，单独删除该独占测试根，证据failed-run-cleanup.json；没有把后续人工清理冒充首轮join通过。

## 实际Electron界面验收

最终run-dh9UJ4使用根Vite renderer构建和实际main/preload桥接，1项完整交互通过，耗时19.19秒。仅共享服务构造中的微型资源catalog、受控下载传输和native加载smoke为测试替代；资源引擎、生产迁移、文件身份、两域adapter、IPC和renderer实际执行。此fixture故意不提供内置运行时，并保留一份损坏旧资源以验证提示；截图中的这些提示不是实际用户迁移结果。真实native/用户资源证据分别见上两节。

覆盖迁移inode保持、Studio开始下载后切换旧页观察/取消/完成、离页任务继续、双向删除后自动刷新、两侧busy按钮与真实主进程拒绝、共享删除影响说明、Esc返回焦点、1280×860浅色及786×540深色窄窗。根节点直接审阅最终02、04、05b截图，确认资源操作未被底部导航遮挡，窄窗完整按钮和滚动条可达；本轮也审阅01及05/06对应最终布局。7张截图及几何、fixture-trace、build-evidence留存，renderer-errors=[]，隔离app/profile均移除。

UI证据mainSource为c65f91722b3c0cfaa363f6860fcf7cf24e6aa235c69a4c14e474030abfc4ed5a；之后唯一相关生产跟进为上述消费者退出守卫，renderer/preload/UI源未变，已由实际四链关闭及最终根构建验证。没有将旧截图伪标为后续main源码执行证据。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-09-1 | 通过 | inline: shared-regression-final.log含128项引擎通过及1项Windows不适用跳过；engine/receipts/integration-audit-final.log精确来源检查通过，copy-audit-final.log120项通过 |
| V-TRANSCRIPTION-09-2 | 通过 | inline: migration.test.ts 26项、catalog-migration.test.ts 4项及实际user-resources-migration.json；保留损坏源和journal恢复负例，真实4资源/23payload无下载接管 |
| V-TRANSCRIPTION-09-3 | 通过 | inline: service13项、adapters/admission/private-sessions/window-bridge/smoke-startup/app-shutdown/consumer-shutdown回归；实际跨页作业和四域退出通过 |
| V-TRANSCRIPTION-09-4 | 通过 | inline: shared-ui-final.log，run-dh9UJ4的7图及几何/trace/build-evidence/renderer-errors/cleanup，最终截图人工审阅；四语言检查通过 |
| V-TRANSCRIPTION-09-5 | 通过 | inline: real-shared-comparison-final.log显式3项通过，其中1项串行4次真实ASR；real-shared-sMRxt5/report.json证明同资源身份、精确CUDA PID、两文档重开、源不变及完整退出；user-resources-migration.json证明实际用户资源ready |
| V-TRANSCRIPTION-09-6 | 通过 | inline: regression-bounded.log2598项、shared-regression-final.log232项、provenance-audit-final.log121项，存在重叠不累加；boundary-audit-final.log377文件0错误；两套TS/最终integration TS、i18n、根Vite/preload、spec-done及diff检查通过 |

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-09-1 | 通过 | V-TRANSCRIPTION-09-1, V-TRANSCRIPTION-09-2 |
| AC-TRANSCRIPTION-09-2 | 通过 | V-TRANSCRIPTION-09-2 |
| AC-TRANSCRIPTION-09-3 | 通过 | V-TRANSCRIPTION-09-3 |
| AC-TRANSCRIPTION-09-4 | 通过 | V-TRANSCRIPTION-09-1, V-TRANSCRIPTION-09-5 |
| AC-TRANSCRIPTION-09-5 | 通过 | V-TRANSCRIPTION-09-3, V-TRANSCRIPTION-09-4 |
| AC-TRANSCRIPTION-09-6 | 通过 | V-TRANSCRIPTION-09-1, V-TRANSCRIPTION-09-2, V-TRANSCRIPTION-09-3, V-TRANSCRIPTION-09-4, V-TRANSCRIPTION-09-5, V-TRANSCRIPTION-09-6 |

最初默认并发普通回归启动19个worker，旧mediaNormalizer两个时限断言失败且清理挂起。定位确切本轮Vitest父子进程后终止，仅该测试47项独立复验通过；限制2个worker后的相关127文件/2598项通过、12项跳过，耗时51.13秒。没有为此修改ASR实现。之后对实际修改的共享资源/接口/退出路径复验26文件232项通过、3项跳过（真实UI、真实ASR入口及Windows不适用用例）；UI和真实ASR分别显式执行通过。来源最终121项包含已有来源/回放、真实checkout、边界和部分共享catalog/cleaner检查，不与前述数量重复累加。

最终根Vite build --mode=test通过，主进程300模块，preload386模块及独立preload依赖检查通过；没有调用electron-builder。默认TS、构建侧TS及最终integration/user-migration专属TS通过。i18n四语言各2249键、2082调用/2101解析均通过，保留18条已有同源文案提示。源与证据快照只陈述各自验证版本，不把Windows证据扩展为macOS实测。

## 风险与未执行项

T09的代码、真实已有资源接管、共享转写及交互验证完成。测试及维护进程均已退出，专属临时根已清理，原始失败证据保留。用户真实模型现在由共享目录维护；不再需要在两个入口重复下载。用户整体验收仍为pending。打包演练依用户指令暂停；I3/I4、发布、签名/公证和其他质量优化不在本轮范围。
