# I2 设计：生产来源冻结与独立副本

## 现状与约束

当前生产基线是 `3a0f50ed15c1b63451402cecf27240182235e567`，不再机械使用 9 月 8 日设计查阅快照。I1 门禁修复仅调整第三方 UI 包审计与回归测试，不修改旧转写源码。120文件转写副本和独立runtime已建立；T04新增输出独立的派生executor、内部文档生产者及schema2媒体文档，兼容现有翻译/预览/导出。T05已接任务准入/应用组合，T06已接转写工作区；完整原生资源和真实ASR仍待后续验证。

## 方案与取舍

以 Git 提交中的跟踪文件为权威来源，用独立维护工具生成 `resources/subtitle-studio/provenance/transcription-baseline.json`。只读取 Git blob/工作树字节，不通过 import 执行旧版服务。输出稳定排序、不加入当前时间或本机绝对路径；清单包含来源提交、文件内容身份、来源分类、拟议目标、依赖边和人工审计边界。

生成器与它的测试放在 `scripts/subtitle-studio-provenance/`、`test/subtitle-studio-provenance/`。这些是读取旧实现的维护工具，不属于新版业务依赖图；新版运行时代码、构建和业务测试不得 import 它们。原有 `scripts/subtitle-studio/check-boundaries.mjs` 继续保护业务根，不能为了清单生成而放行旧业务依赖。

初始清单覆盖旧主进程转写目录、领域/IPC 类型、用户配置、资源 manifest/许可/原生源码、运行时/whisper 验证脚本和相关测试。沿本地相对路径与 `@/` 递归解析，补齐目录外 fixture 和 helper。分类区分拟议复制、复制后替换、通用基础设施、组合层证据和明确排除；拟议路径不是已复制路径，不能提前填写副本 hash。

主进程 `index.ts`、旧 UI/Store、构建入口只冻结必要组合证据。对旧翻译交接链的依赖标为待替换边界，不据此把整套旧翻译应用复制进新版。实验 benchmark 仅当现有测试/脚本实际依赖时纳入来源，其余不当作已采用的算法。

默认值与资源由源文件和 manifest 双重定位；工作树漂移检查与历史提交重建分别提供结果。检查模式不重写基线；更新基线必须显式生成并审查 diff。支持可丢弃 Git fixture 的负例，不在真实用户仓库篡改旧生产文件。

人工审计还覆盖31处模块级Symbol/WeakMap/WeakSet身份；复制后品牌注册表必须独立，不能用类型强转复用旧proof。默认值不仅冻结配置对象，还审查sanitize中的停顿策略强制VAD约束、旧任务缺策略保留fixed语义，以及实际任务快照到executor的路径。唯一生产非字面原生装载是overwrite-native-backend中经校验路径的createRequire调用，不能因为AST没有普通import就遗漏addon来源。

来源冻结时识别的接入边界：旧transcript上限200,000 segments，而I1文档为100,000 cues且来源只有SRT/LRC。T04明确保持文档容量、整体拒绝超限，完整保存已有词时间/说话人/置信度，不经SRT往返。初始机械复制保留输出闭包用于等价验证，T04另建派生executor，在最终后处理、task清理和batch释放后提交文档；T02原副本不改。

## 代码落点

- `scripts/subtitle-studio-provenance/`：固定选择/映射策略、Git/AST 清单生成与校验。
- `resources/subtitle-studio/provenance/transcription-baseline.json`：当前基线事实，生成产物。
- `test/subtitle-studio-provenance/`：重建一致性、漂移、缺失/未知依赖、目的路径冲突和篡改反例。
- 本模块任务与 records：人工闭包审查、验证证据及下一阶段边界。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-TRANSCRIPTION-09 | 应用级唯一资源服务、固定目录可恢复迁移、同步准入租约与跨域忙碌聚合、私有运行校验适配器、统一资源作业及两页状态/删除管理 |
| R-TRANSCRIPTION-08 | 固定六样本/两设备真实矩阵、独立生产资源安装、精确PID设备证明、canonical差异与持久文档重开、固定重复控制和有界清理 |
| R-TRANSCRIPTION-06 | 会话级转写controller、有界草稿和撤销重试、资源与参数准备、任务轮询及文档发现、共享工作区UI与真实Electron隔离验收 |
| R-TRANSCRIPTION-07 | 独立Windows资源stager与固定来源配方、生产addon构建/真实Electron事务验证、显式短音频和同配置旧新CPU对照 |
| R-TRANSCRIPTION-05 | 输出独立的有界准入与FIFO队列、资源及租约身份复核、T04文档生产者组合、固定IPC和owner撤销、双运行时关闭与LF精确来源检验 |
| R-TRANSCRIPTION-01 | 固定 Git 来源、内容摘要、传递依赖及资源/默认值审计、只读校验和负例 |
| R-TRANSCRIPTION-02 | T02精确机械复制策略与fork来源记录、隔离临时树配对回放、真实品牌交叉拒绝、实际业务边界门禁 |
| R-TRANSCRIPTION-04 | 媒体文档schema与完整transcript保留、100k承接边界、独立派生输出executor、绑定操作的guarded sink和可恢复提交、现有文档消费兼容 |
| R-TRANSCRIPTION-03 | 独立runtime工厂与copy-only facade、新版native构建/来源清单、完整双资源builder组合校验、macOS原生实物验证与分平台证据 |

## 验证与风险

在当前提交真实生成与重建校验，另用隔离临时仓库注入漂移/遗漏。独立审查来源分类、相对与 alias 依赖、C++/脚本运行时字符串、fixture 和拟议目的路径；跑 I1 边界/模块回归，保证维护工具没有改变业务依赖。无产品 UI 变更，不启动 Electron 或模型推理。

现有双资源打包问题保留：旧 validator 和 beforePack 都假定单项 extraResources，mac.signIgnore 也有严格形状；下一阶段新建组合配置/hook，不缩小配置骗过旧检查。原生 addon 中的旧事务/临时文件前缀需独立改名及验证；源码 hash 相同仅证明来源，没有证明新命名空间或转写等价。

## 维护命令

在仓库根使用已安装Node和TypeScript，不执行包管理器或下载。默认命令只检查，显式`--write`才更新清单；更新后审查Git diff。来源提交改变时使用完整`--source-commit`，同时审查选择策略、默认值与新依赖，不能把重新生成当作审批或验证。

```sh
node scripts/subtitle-studio-provenance/generate.mjs --write resources/subtitle-studio/provenance/transcription-baseline.json
node scripts/subtitle-studio-provenance/generate.mjs --check
node scripts/subtitle-studio-provenance/generate.mjs --check-worktree
node scripts/subtitle-studio-provenance/copy.mjs --check
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance
```

`--check`按固定历史Git对象重建后比较整个清单；`--check-worktree`另核对当前登记源码，源新增/删除/内容漂移时报告失败。当前工作树有新版实现不等于旧来源漂移；只按已登记旧来源和选择范围核对，不扫描真实userData或未跟踪原生staging。


## T02 机械复制与等价验证

复制分为源码/契约回放和后续真实原生组装两步。本阶段从正式基线的main组装边重建84文件生产闭包，补9份许可证、必要确定性测试/配置测试/helper/历史fixture；扩展cue/overlap/separator回归仍只消费新副本。未采用PoC、旧前端/IPC组装、native构建/签名脚本暂不复制，逐项登记deferred或reference，后续T03就近展开。

维护工具新增copy入口与独立策略，不修改T01基线。根据source/target两端映射重算AST模块引用和相对URL；身份与字符串资源使用精确源文件、旧值和预期次数的补丁，JSON按具体字段修改。不全局替换标识符，不改变源算法或默认值。生产路径为electron/main/subtitle-studio/transcription/native，类型/config为src/subtitle-studio/transcription，资源为resources/subtitle-studio/transcription。旧类名可保留；独立模块注册表才是品牌隔离依据。

主进程资源解析、manifest loader、IPC前缀以及必要输出/临时身份同步到新命名空间。9份licenses/source-offer保留原字节和固定逻辑prefix，模型/VAD/CUDA上游hash不变。声明的预期native字节不是已构建证明，不生成runtime-ready回执；T03重建native addon与签名后才更新实物hash和注册入口。新版模型导入只能copy，不能把复制下来的move分支直接暴露给用户。

正常副本回归位于test/subtitle-studio/transcription，旧动态源文件读取改读新版domain/IPC，fixture重算新licenses根。配对测试单独放test/subtitle-studio-provenance：从固定Git提取旧源码与harness到隔离临时树，重写别名使其不能回落到工作树v1；另一树使用实际新副本。使用已安装esbuild和Node，不启动Vite/Electron/模型服务。提取只保留声明，不能把旧测试注册进当前runner；保留实际源文件URL以确保fixture只读对应独立树。

配对比较捕获exportArtifacts前的完整transcript、请求、窗口和回退/cleanup，允许差异仅为明确的应用身份和本机测试路径。不能全局字符串替换输出抹平语义差异。品牌反例使用真实normalizer的注入runner和真实验证器；旧executor测试harness关闭过部分brand验证，不能以它单独证明安全隔离。

T02阶段产品入口与统一文档契约保持I1；document sink、200k/100k容量、word/speaker/confidence保存现已由T04细化实现，新转写UI仍待后续接入。

T02复制工具沿用T01历史重建，但工作树核对用有10秒超时的Git直接文件输入，避免本机观察到的同步stdin管道停滞；仍核对279登记范围、新增/删除、符号链接、clean filter和Git换行归一化。原T01生成器与基线不改。业务门禁补全node:module源hash审计、原生单点装载审计与资源JSON检查，历史证据仅按准确路径/hash豁免。

## T03 独立资源与原生构建

在T02 native目录外新增runtime工厂，内部构造独立authorizations/leases、session、model manager、media normalizer、supervisor及必要任务生命周期。仅接受应用环境和userData根，强制新子目录；不接受旧runtime实例或任意managed资源目录。构造保持惰性，初始化显式幂等并保留失败，shutdown统一收敛并完整清理。公开facade提供资源快照、校验、显式copy导入和owner释放，不暴露原manager及其move接口；测试输入绕过类型系统时仍拒绝额外mode等字段。

保留原session lifecycle的阶段顺序及错误重试。未接document sink前不注册旧式job IPC/页面，不初始化覆盖addon作为启动必要条件；新版addon通过独立真实smoke验证，后续文档导出组合再决定采用。资源缺失是可观察状态，不假装ready或回退PATH。测试使用独立临时根和小型合成资源，真实复制校验正例以及源删后新版仍可用；不会下载大模型。

在native/subtitle-studio-overwrite和scripts/subtitle-studio/transcription下复制必要C++、build/staging/verify闭包；从固定Git记录独立native/tooling provenance，T02的120副本及fork不变。共享runtime-manifest/staging-contract脚本由打包负责人单写，native复制工具只核对其独立来源。更新项目根相对深度、新C++路径、组件/事务/journal/回执/签名标识，保留协议、操作语义和上游许可字节。新增明确的build忽略目录，实物输出放本轮隔离test-results。

应用组合层新增electron-builder.subtitle-studio.json及scripts/packaging/subtitle-studio-before-pack.cjs。完整配置明确列旧资源和新资源，验证最终extraResources/mac.signIgnore/平台矩阵与beforePack标识，再分别调用资源级验证器；旧贡献允许应用组合层引用旧模块，新贡献只能引用新版模块。不能调用旧beforePack并伪造单项config。提供新版单贡献验证测试以证明移除旧贡献不影响新校验闭包；默认package/build入口不切换。

当前macOS arm64具备xcrun、匹配Node headers、codesign及Electron41.10.6。使用新版源码真实编译生产和必要故障注入测试addon，正式生产实物不含测试接口；ad-hoc嵌套签名后生成内容寻址manifest，在新鲜Electron RUN_AS_NODE子进程验证加载、事务及恢复并核验签名/hash。Windows只验证当前能执行的契约与源码，平台实跑和完整签名应用包放在后续平台验收，记录不得混淆。

本机只读预检确认没有可用Developer ID身份；现有旧ASR staging虽有合法字节，但缺新版可重建的FFmpeg/Whisper输入与回执，不能改路径后冒充新版完整ready。T03组合hook应在缺新版资源时真实阻止打包，当前用隔离资源fixture验证正确路径及破坏反例，真实原生证明只覆盖新addon。未来完整应用签名需独立组合sign/verify入口：外签忽略两套已冻结native根，外签前后比对hash，macOS26对osx-sign1.0.5使用系统codesign严格复核；不直接复用旧只忽略一根的sign脚本。

## T04 转录文档生产者

旧schema1字幕文档保持兼容；新增schema2媒体文档，以media origin、transcription timing及transcription preservation区分原字幕文件。原始canonical transcript只存允许字段，不存路径/token/PID。cue使用新UUID及segmentId映射，文字/时间精确复制；完整词证据留在结构化preservation并校验关联。保留100000 cues、128MiB snapshot；超限原子失败，源transcript的200000上限不改。源没有媒体hash，不伪造；transcript hash只标识转录内容。

新派生executor在native目录外生成，记录T02源hash与精确patch，保留ASR过程，去掉输出目录/文件策略，只返回最终transcript。内部文档生产者消费已准入的执行上下文，先完成task和batch清理再调用sink；未来任务管理器负责真实准入/队列/重启，不在本轮造旧artifact。T02原文件继续按原copy checker复验。

sink绑定main创建的operation/document身份与有效性guard，内存合并同操作并发，严格拒绝结果漂移；repository提供可核对的文档创建提交结果，发布前失败可重试、发布后故障不能自动删除或换UUID。owner撤销与signal在发起current指针rename前最后检查；rename已发出后可能完成发布，receipt优先于迟到取消。发布后目录同步失败返回committed及durability=uncertain，不伪报无结果。已有删除墓碑阻止重放复活；内存中的幂等状态不代表重启任务自动恢复。

现有consumer按媒体分支读取：分页不假造raw节点、原字幕文件导出和双语拆分拒绝媒体；SRT/LRC投影和翻译复用现有逻辑，投影报告元信息损失。只做必要默认导出格式/能力兼容，不新增转写UI；既有视觉结构与操作顺序作为参照，本轮没有布局、动效或新页面设计。

root独占规格、最终集成测试和记录；workspace_progress独占domain/adapter与文档consumer兼容；baseline_checks独占派生executor、其来源工具/清单和回放测试；broader_roadmap独占repository创建语义与document-sink及对应测试。agent先确认导出接口，跨写集仅消息协调。

T04渲染验收采用现有字幕工作台1280×860浅色布局，媒体105条含长正文与旧SRT各一份：正文100条分页、下一页5条、媒体无伪编码/原文件下载、导出默认SRT且损失确认可见、旧字幕菜单保持可下载；按项目UI技能审阅隔离Electron截图，无新CSS/组件/动效。

## T05 准入、队列与应用组合（R-TRANSCRIPTION-05）

新增 `src/subtitle-studio/transcription/task-contract.ts` 定义有界请求及安全摘要；不修改 T02 冻结 DTO。新增 `transcription/task-service.ts`，依赖私有 inputs/leases/media/models/backendResolver、派生 executor 和同一 DocumentRepository。每次最多20文件，配置不含 output/postAction；准入在异步工作前领取 FIFO 序号，严格解析请求、resolveDraft、模型/VAD及运行时验证，取得真实 backend proof 后冻结配置、原子 reserveBatch 并绑定已探测音轨。失败回滚全部 input reservation，不发布半批。重复源/并发请求受有界任务数约束，串行调度和续租不依赖 renderer 在线轮询。

执行前复核有效 owner、租约和资源身份；每任务独立 producer/sink 与 batch pin，清理结束才入库。完成保存 documentId/durability；迟到取消不能覆盖已提交结果。公开状态排除私有路径和原始错误。队列提供 enqueue/list/cancel/remove/waitForIdle 与资源忙检查；失败清理保留锁，终态删除不能丢失待清理句柄。当前无持久任务记录或推理重试；文档本身继续由既有仓库持久化。

runtime 保持惰性构造，第三个 main-only repository 参数选择启用文档队列，旧资源测试不需仓库。服务只用当前工厂创建的依赖；资源管理 busy predicate 同时覆盖任务的准入与队列/执行。关闭先同步 fence/abort，再等待任务准入和执行收敛，之后依阶段清理 models/media/server/registry，完整成功后才清除清理锁和 canonical 根锁。关闭 Promise 必须在 abort 回调前缓存，失败保留重试。owner 释放先 fence，异步清理结果由应用组合保留并在退出重试。

Studio 注册层延迟创建 runtime 并传入现有 repository；原生选择器返回 token 与已消毒 probe，模型导入固定 copy，资源安装只接受固定资源 ID。新增固定 preload 方法和严格 schema，复用现有 capability envelope；在 documentId 通用分支前分派转写操作。ownerSessionId 取 main 发出的 capability，禁止 renderer 自报。先使用显式查询资源/任务快照，不新增事件总线。重复注册、主 frame 导航、destroyed 同步撤销旧 owner。独立应用 shutdown 组合等待旧版及 Studio，两者失败均尝试，更新和退出共用该组合。没有转写页面；仅为新增错误码补齐现有错误映射和四语言文案，本任务没有 UI 布局验收；构建真实 preload 并验证固定通道与拒绝反例。

root 独占规格、runtime、集成验证和证据；admission_design 独占 task-service/task-contract 及测试；ipc_design 独占 Studio IPC/preload/main 生命周期及测试；windows_baseline 独占 LF 属性和回归。冻结副本仅在 CRLF→LF 后逐字节等于 HEAD 时修复本机字节，不改摘要规则或清单。实际验证使用隔离仓库/合成媒体和推理协议、真实生产者和文档仓库；缺新版实物时拒绝真实 ASR，记录不可宣称端到端设备验收。

T05集成审查补充：并发启动的模型/VAD/runtime/媒体验证即使其中之一先失败，也必须等待所有已经启动的验证完成；按owner追踪续租，取消等待不遗失原续租Promise。已释放owner的干净终态记录及时回收，清理失败记录继续保留资源锁。来源检查对reference-only应用组合采用独立的准确内容审计，冻结副本与T01/T02清单保持原样。

## T06 转写工作区（R-TRANSCRIPTION-06）

现有工作台为视觉基线，已在隔离Electron导入24行字幕并审阅1280×860浅色截图（test-results/studio-t06-ui/reference-documents.png）。保持中性工作区、工具青色图标、12px面板留白、16px列距及现有字级；新增文档/转写ClipPathTabs rounded/smooth/sm放在同一标题区域，文档内部原文Tab不混用。转写使用独立ToolDetailLayout类，桌面320px配置列+主区，窄窗口媒体和队列在前，设置可直达并后置，避免沿用文档固定阅读器高度。

主区依次为共享水平媒体选择面、待转写列表（名称/时长/音轨/移除）、开始操作及任务队列；靠角控件保持12px横纵等距。配置采用ToolConfigPanel/ToolField/ToolSwitchRow，高级参数默认折叠，资源集中在ScrollableDialog；长文件名复用StudioFileName，状态与动作有可访问名称，进度数值不持续轰炸live region。使用生产默认auto/auto/transcribe/VAD/acoustic_quiet_v1及beam5/temperature0/silence500/cue7000/84/42，不引入旧输出选项。

renderer独立singleton controller首次进入转写时惰性启动，通过useSyncExternalStore订阅；SPA离开保留草稿、任务和待撤销注册表，只有活跃任务/资源作业或当前视图需要时有界轮询。文件token/sourceKey去重、过期拒绝、音轨明确且有界；移除先登记撤销再隐藏，ok:false与异常都可重试直到过期。重新探测新增固定probeTranscriptionMedia({fileToken})，main绑定owner并清洗结果，拒绝任意路径。提交同步单飞并捕获不可变快照，明确成功后清除对应草稿并撤销草稿能力；结果未知保留阻止重复提交的状态供用户核对。通过单飞读取与mutation generation避免迟到快照回滚本地写入。

资源UI展示真实缺失/校验/导入/下载状态，调用动作均来自用户按钮；运行时缺失与模型缺失分别说明。任务摘要只消费安全DTO，取消持续显示至终态，cleanupPending阻止移除，durability未知提示保留文档并核对。查看完成文档先使用既有listDocuments在默认筛选中分页发现目标，获得合法read授权后选择；取消或过期发现不能误打开别的文档。文档区域的既有任务控制器保持挂载，视图切换不改变其身份。

root独占规格/入口/四语言/新增probe IPC和集成验证；admission_design独占src/services/subtitle-studio/transcription-controller.ts及其单测；ipc_design独占StudioTranscription.tsx/css；windows_baseline独占转写UI测试及隔离main runtime夹具。测试依赖esbuild仅用于从实际main构建隔离测试入口，保留真实renderer/preload/注册/IPC/仓库，仅按精确路径替换新版runtime，不写生产bundle或用户数据。先约定controller接口再并行，跨写集消息协调。最终截图亲自检查空/繁忙/完成/失败、两主题及实际窄窗口、长名Tooltip/键盘焦点、资源dialog和滚动容器；不把合成资源视为真实ASR。

## T07 Windows 独立实物与 CPU 短样本（R-TRANSCRIPTION-07）

Windows合同选用官方Whisper v1.9.1 CPU release及固定BtbN FFmpeg n8.1.2，FFmpeg/Whisper本体无需MSVC重编译。显式读取仓库历史上游缓存和FFmpeg审计回执，严格复核每个实际文件与固定合同；新版stager复制全部15个二进制到build/subtitle-studio-resources/transcription，校验许可/来源并生成独立manifest。使用已有无覆盖发布/探针语义；新资源制作脚本和Windows addon脚本分别新增T07派生recipe和provenance，借用已有纯维护计划生成器但不改T03配方或已有精确副本。

Windows addon使用独立新版C++源、与构建host版本匹配的headers、兼容Electron的import library及delay-load hook，沿既有portable LLVM-MinGW配方记录工具版本/参数/hash。N-API8兼容性须在实际Electron41.10.6证明，不能仅凭Node构建成功推断。生产与故障测试构建分开，最终生产addon经既有新版内容寻址stager和真实Electron host验证；旧前缀不能被当新版事务授权。只在本轮隔离文件中验证事务/恢复，保留原输入及旧staginghash，输出目录不覆盖已有非同一产物。

真实ASR使用有来源记录的仓库短音频、相同固定模型/backend/language/beam/VAD/window配置。旧链路从冻结生产入口执行并写隔离输出；新版使用真实runtime/tasks/producer/repository，不替换ASR、媒体或backend返回值。显式复制模型/VAD到各自独立managed根，输出保留完整转录及schema2文档并重开核对。按样本时长设置有界等待，超时取消并join清理；对比文本、关键时间、重复/遗漏和耗时，任何差异如实保留。当前不新加UI，已有T06渲染证据不被当真实推理证据。

root独占规格、总集成/边界和最终证据；admission_design独占T07 Windows runtime staging闭包及其recipe/provenance/测试；windows_baseline独占新增Windows addon构建/实物验证闭包及其recipe/provenance/测试；ipc_design独占真实短样本对照harness及测试。各自先公布文件集合，原T02/T03目标禁止改写，跨写集先消息协调；新脚本只引用新namespace，历史文件名/许可内容作为来源证据保留不代表运行依赖。

T07审阅修正：新版Windows构建清理须等待所有自有工作目录清理并保留主错误、加入Windows有界删除重试；故障测试构建拒绝透传production receiptPath。恢复子进程只额外保留明确的ELECTRON_RUN_AS_NODE=1，实证实际Electron的宿主差异。真实比较两侧使用生产允许的120000ms启动上限，单侧总工作10分钟有界，失败仍执行关闭并核对进程；不改变生产构造器边界。

## T08 默认 VAD 与设备矩阵（R-TRANSCRIPTION-08）

新增维护侧real-default-comparison-harness/test，不抽取或改写T07快照文件。固定A/B/C各30秒、B-noise18秒、independent175.993秒和原始float32/stereo/48k full216秒；输入hash在执行前后核对，full走实际规范化。每设备先旧后新顺序运行，同配置q5/ja/transcribe/VAD=true/acoustic_quiet_v1、beam5/temperature0/silence500/cue7000/84/42；CPU与CUDA总共24次，再固定追加CUDA A每侧一次。禁止并发GPU推理。使用独立服务状态，不能在同一污染的VAD/nonVAD进程间交错；模型资源根可复用但每次重新验证品牌和输入身份。

模型经真实copy-import；固定VAD可从原提交URL下载到test-results输入缓存，CUDA使用已核对677887125字节官方完整ZIP。维护fixture构建独立新旧资源管理器，低层downloadResource只搬运固定实际字节，其余校验/解压/探针/提交流程保持生产实现。runtime资源注入并不透传acceleratorOptions，因此在同一隔离managed根先使用该侧实际accelerator manager安装并shutdown，再由正式runtime重新解析，禁止制造ready文件。结束使用真实删除接口验证移除，不影响原缓存/旧开发staging。

旧链路显式接production backend attestor、executor和backendResolver的resolveManagedAccelerator闭包及cudaAttestationAvailable；新版直接用现有runtime组合。观察真实verifyBackend返回和启动PID，不覆盖原生结论，WDDM允许已有5秒单探针/10秒宽限。每项任务15分钟预算与finally清理45秒，资源10分钟，整体90分钟；先检查构造器数值合同，超时仍等待owned清理并记录未退出进程。

保留每侧canonical转录、真实进程与请求/窗口诊断、全量差异和新文档schema2重开结果；只生成有界文字差异摘要，不做近似去重或猜测文本真值。历史CUDA/full-large-v3质量标注用于定位已知风险，不作为CPU/CUDA q5逐字预期。长样本必须实际触发分块观察；VAD时间轴使用映射segment、禁token_timestamps。A固定重复控制每侧CUDA一次，其差异按真实非确定性报告。未解决新回归不能更新为通过；原先接受的两处seam重复及分隔不足不在本轮精修。

root独占规格、集成、实际串行推理调度和最终报告；ipc_design独占real-default-comparison-harness.ts/.test.ts；windows_baseline独占real-default-resource-fixture.ts及单测；admission_design独占real-default-comparison-analysis.ts及单测并只读审阅质量证据。维护文件可引用新旧生产入口，产品边界不放宽；先互相确认类型接口再实现，冻结T07/T02副本和旧生产代码不改。本轮没有UI或前端服务。

T08观察约定：维护测试串行安装可恢复的call-through观察器，记录各域MediaNormalizer的readQuietCandidates/materializeWindow/resolveWindow及真实server/backend attestor调用；保留原始this、实参、返回值和异常，finally恢复。只读观察不注入窗口或推理结果，不修改生产源码；观察器失败应使测试失败。

T08审查补充：固定的是任务主配置，既有executor的separator no-VAD辅助识别与temperature恢复仍按原条件执行，须从真实调用证据区分主请求/恢复/辅助请求，不能强制所有内部请求为VAD=true/temperature=0。VAD主请求的segment映射与no-VAD辅助时间证据分别审查，不把它们混成同一时间轴。无语音结果也须列入完整配对状态表，缺少canonical比较不代表无差异。成功文档的完整canonical/cue映射属于正确性门禁；ASR文本差异属于人工审查，不混同二者。

清理的对外等待预算与底层操作锁分别维护：超时明确未join，原操作实际settled前不得新建清理或开启下一样本；未join场景不得卸载资源。观察器退出也有界并恢复原方法。已加入受控Promise负例验证超时后的单飞保持，实跑正常结束仍须核对真实PID退出。

Windows实物预检修正：首轮旧版CUDA安装在mkdtemp时ENAMETOOLONG，真实长目录253字符失败、短目录206字符成功；空间/URL并非原因。报告、文档和输入缓存仍在test-results，物理managed资源改用本轮mkdtemp创建的系统临时短根及l/s子根，保留各自生产命名空间。准备前计算完整receipt/ZIP/最长artifact路径预算，超过245字符即拒绝；不得改生产UUID、弱化校验或使用路径链接。只记录并清理本轮实际持有身份的临时根，真实卸载后先核验没有文件/链接，再移除空目录；不扫描或删除其他系统临时内容。

## T09 应用级共享资源与已有安装接管（R-TRANSCRIPTION-09）

用户明确要求完整实施共享资源并暂停打包演练。`speech-resources` 是应用独立基础设施：中立引擎从99d0647的固定资源校验/下载/ZIP/磁盘保护/取消/清理逻辑抽取，另记精确来源和必要变换；不导入任何工具的业务或类型。既有ASR算法副本和T01–T08历史证据保持原样。主进程只初始化一个资源服务，两个工具通过主进程facade消费同一模型、VAD和兼容CUDA包。

唯一可写根为 `userData/speech-resources`，清单固定兼容模型、VAD和CUDA内容hash；旧/Studio CUDA公开ID为canonical中立ID的受控别名。内置FFmpeg/Whisper/事务addon和每域临时会话仍独立。每域CUDA adapter只解析共享包并由本域原校验器重新签发品牌proof，不能转型复制旧proof；实际server继续取得本进程设备证明。资源smoke使用专属验证supervisor，避免干扰用户转写会话。

迁移先于任何资源startup cleaner：仅检查 `local-subtitle` 和 `subtitle-studio/transcription` 固定catalog子目录，校验完整树/无链接/字节数/hash/对象身份，同盘原子移动大型payload，按固定contents重写小回执。journal记录固定catalog指纹/源序号/对象身份及阶段，不接受任意恢复路径。最终目标验证通过后才清理同内容旧副本；未知/损坏/不兼容文件保留并报告，跨卷不静默复制或删除。已持久记录的断点可恢复，未形成有效journal的未知事务安全保留并阻止初始化。不得先删除最后有效副本，也不把已下载资源重新走网络。

资源维护由应用拥有，一次只接受一个安装/导入/删除变更。两个授权页面读取同一资源作业并可取消；离开页面只退订，不取消下载，也不关闭应用级服务。保留旧copy/move真实导入语义，Studio仅copy。全局任务历史有界；terminal事件不代表finally清理已结束，只有底层操作及清理join成功才释放变更锁，失败保留锁并允许恢复重试。

每域准入在首个await前同步取得模型/VAD/选定CUDA使用租约；完成准入后由排队/运行/取消清理及warm server忙碌状态接续保护，失败在清理join后释放。解析验证本身也持读租约。忙碌聚合任一消费者异常按busy处理，变更与读取不可交错；资源列表可以在安装中读取进度，其他已就绪资源仍被保护。应用关闭先同步fence新操作并取消应用资源作业，再join两个业务域，再关闭专属验证supervisor，最后关闭共享服务；任一清理失败保留所有权并可重试。冻结旧任务管理器在shutdown后保留fenced记录，不能据此永久占用资源：只有完整消费者清理成功后才停止使用其busy谓词，失败和超时保持占用。专属smoke会话首次创建前单飞清理自己的遗留会话目录，shutdown等待该清理完成；不触碰资源迁移源或共享资源staging。

沿用两个工具现有资源dialog、共享布局组件和密度，不重设计工作区。页面明确模型/VAD/CUDA由两工具共用，实时显示全局作业；仅revision的受信事件使两页catalog缓存失效，CUDA终态变化同时使后端预览失效并按需重探测，不能每次进度都启动probe。工作台增加固定删除API与确认，文案说明删除影响两工具，busy时禁用维护按钮；主进程始终独立检查。迁移问题只返回安全问题码/资源ID，不暴露旧文件绝对路径，提供刷新/重试和保留文件的可理解说明。四语言、键盘、长名、1280×860浅色及786×540深色做实际Electron验收。

单写分工：windows先完成中立引擎/清单与来源map，再负责renderer/preload/资源UI/locale；admission负责固定迁移和catalog-migration；ipc负责应用组合与两域主进程adapter；root负责共享服务/租约、规格、来源边界审计和最终集成。真实ASR仅由root串行启动。验证V09覆盖引擎、迁移断点、全局所有权/并发、真实Electron交互、无网络的既有真实资源接管及两工具CPU/CUDA短音频转写、移除模拟旧根后工作台仍可用和文档重开；不重复未修改ASR的完整26链矩阵，不打包。
