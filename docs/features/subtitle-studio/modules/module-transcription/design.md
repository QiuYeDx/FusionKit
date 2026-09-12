# I2 设计：生产来源冻结与独立副本

## 现状与约束

当前生产基线是 `3a0f50ed15c1b63451402cecf27240182235e567`，不再机械使用 9 月 8 日设计查阅快照。I1 门禁修复仅调整第三方 UI 包审计与回归测试，不修改旧转写源码。120文件转写副本和独立runtime已建立；T04新增输出独立的派生executor、内部文档生产者及schema2媒体文档，兼容现有翻译/预览/导出。转写任务准入、应用组合及产品入口尚待接入。

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
