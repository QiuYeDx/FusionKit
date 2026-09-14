# 字幕翻译知识开发记录

设计基线：[V3](../FusionKit_AI_Translation_Design_V3.md)。用户于 2026-09-14 明确要求创建功能分支并开始推进开发，授权按已讨论设计连续实施；没有部署、真实数据迁移或远程发布操作。

分支：`codex/feat-subtitle-ai-knowledge`；起点：`f20ab93`。协调与集成：主任务。沿用现有设计作为权威需求，不复制另一份字段规范。

## 已完成增量 P0.1：协议与资料文件往返

目标：用户能通过应用界面创建/导入资料，查看和审核，备份全部当前资料或分享选中资料集；外部 Agent 可用同一协议的便携校验器和 Skill 生成文件。尚不把知识加入翻译请求。

| 任务 | 写入范围/负责人 | 状态 |
| --- | --- | --- |
| T01 FK-TK/1、类型/语义校验、Schema、CLI、示例与 Skill | `src/translation-knowledge/`（排除 IPC）、`scripts/translation-knowledge/`、`resources/translation-knowledge/`、`skills/fusionkit-translation-knowledge/`；协议 Agent | 已完成 |
| T02 仓库、原子发布、审核、导入差异/幂等、备份/分享 | `electron/main/translation-knowledge/`（排除 index/ipc）；仓库 Agent | 已完成 |
| T03 三视图管理页、结构化编辑、导入/导出、四语种 | `src/pages/TranslationKnowledge/`、四份 `knowledge.json`；界面 Agent | 已完成 |
| T04 IPC、原生文件边界、注册与入口、集成验收 | `ipc-contract.ts`、`electron/main/translation-knowledge/index.ts` / `ipc.ts`、preload、应用入口/路由/i18n 注册；主任务 | 已完成 |

对应测试目录 `test/translation-knowledge/` 按 protocol/repository/ui-model/ipc/electron 前缀隔离写集；依赖/lockfile/共享入口仅主任务可改。共享工作区，禁止并行 agent 独立 commit/切换分支。契约以 `src/translation-knowledge/ipc-contract.ts` 及 T01 schema 为准，变更先通知消费者。

### 验收

- V3 AC-02/03/04/05/06/07/08/09 中与本增量有关的协议、身份、信任、引用与事务场景；不将跨平台模拟故障冒充真实 Windows 验收。
- 真正应用链路：原生选文件 → 差异预览 → 保存候选 → 明确采纳 → 导出备份 → 新临时仓库重新导入；验证五类型及引用，不自动采纳候选。
- 原生导出仅写用户选定文件，新文件默认避免覆盖。导入失败保留原数据；并发编辑让旧计划失效；已提交计划重试返回收据。
- IPC 固定方法与 preload 私有 capability，拒绝其他 frame/owner、旧 generic bridge 的知识 namespace 与伪造路径。
- 真实 Electron 检查空状态/非空资料、编辑/审核、导入错误、窄窗口、深浅主题，观察和修复布局。四语言 key 与 source usage 检查。
- TS、针对性 Vitest、根 Vite 三段构建及 preload 检查；若改应用 composition 会触发来源审计，保留冻结转写副本并按现有独立审计机制更新。

### UI 设计依据

遵循 `fusionkit-ui-design` 和 `qiuye-ui-quality`。参照字幕工作台列表/共享 ToolPanel 与 ToolDetailLayout；资料页使用浅层对象/资料集筛选、自然换行的条目列表、受控可滚动详情/编辑/导入弹窗。共享 form/list 边距，避免页头统计挤掉正文。宽窄变化保持同一业务控制器。状态区分内容生命周期与本机采纳，主流程不暴露 JSON 编辑或内部 ID。

### 总体增量路线

- P0.2：撤销整次导入、永久清除与影响分析、选择方案连同依赖导出、原生拖入知识文件；本机实现与验证已完成，见下文。完整 P0 的平台与恢复验收仍单独跟踪。
- P1：资料作用范围、检索/编译、两个翻译入口、试译与冻结恢复；包括工作台依赖边界与旧工具移除演练。
- P2：字幕确认/积累、参考译文与表达检索、撤销确认传播。
- P3：AI 提取和外部校对稿对齐、质量评测驱动的复杂检索。

## 验证记录

开始时工作区干净，当前 Node `v20.19.5`，锁文件 `6.0`；使用已安装的 Node 脚本，不运行依赖安装或升级 pnpm。

本轮完成 P0.1 开发与本机自动化验收；不等于用户已验收，也不等于完整 P0 或翻译质量链路完成。实现入口：

- `src/translation-knowledge/`：共享 Zod 字段模型、严格 JSON 解析、语义校验、JCS 摘要与固定 IPC 契约。
- `electron/main/translation-knowledge/`：独立本地仓库、导入计划与持久收据、修订/信任、分享/备份和原生文件边界。存储保证与限制见该目录 README。
- `src/pages/TranslationKnowledge/`：资料 / 方案与风格 / 待审核三视图，以及对象、资料集、五类条目和方案的结构化编辑。入口位于工具列表和两个字幕工具。
- `skills/fusionkit-translation-knowledge/`：可独立分发的 Skill、协议参考、示例、Schema 与便携 Node 校验器。尚未安装到用户个人 Skill 目录。

### 2026-09-14 本机验证

| 检查 | 命令或步骤 | 结果 |
| --- | --- | --- |
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 领域与业务测试 | `node node_modules/vitest/vitest.mjs run test/translation-knowledge --maxWorkers=1 --minWorkers=1` | 55 项通过；默认跳过显式启用的 Electron 用例 |
| 原生集成 | `FUSIONKIT_KNOWLEDGE_E2E=1 node node_modules/vitest/vitest.mjs run test/translation-knowledge/electron.test.ts --maxWorkers=1 --minWorkers=1` | 1 条完整场景通过；实际 Electron 41.10.6，临时用户目录，原生对话框返回测试路径，真实文件/IPC/业务服务 |
| 三段构建 | `node node_modules/vite/bin/vite.js build --mode=test` | renderer / main / preload 通过；保留已有大 bundle 与混合静态/动态导入提示 |
| preload | `node scripts/check-preload-bundle.mjs` | 通过 |
| 四语言 | `node scripts/check-i18n.mjs`、`node scripts/check-i18n-usage.mjs` | 通过；330 个 knowledge key 四语言齐全；原有 21 个同文案提示不涉及本增量 |
| 协议产物 | `node scripts/translation-knowledge/build-artifacts.mjs --check` | 3 个生成产物与应用协议一致 |
| 工作台边界 | `node scripts/subtitle-studio/check-boundaries.mjs` | 448 个文件，0 错误 |
| 冻结来源/副本 | `node scripts/subtitle-studio-provenance/copy.mjs --check`、`node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check` | 通过；120 个冻结副本不变，执行器 1 文件/26 依赖校验通过 |
| diff | `git diff --check` | 通过；package.json / pnpm-lock.yaml 未修改 |

领域测试分布：协议 17、真实临时目录仓库 24、IPC/原生文件边界 8、界面逻辑 6。覆盖重复键/未知字段、UUID/修订/引用、同名不同译法、依赖复制与重映射、未知扩展及包级说明往返、精确内容审核、重复提交与重启收据、发布阶段故障、坏库保留、无变化保存、外部 frame/namespace 拒绝、原生对话框退出与不覆盖已有文件。Windows 与断电场景没有在真实目标环境验证。

Electron 场景导入包含五类条目的完整示例，确认没有自动采纳；单条采纳、手工新增后备份 6 条资料，再用另一个临时仓库恢复并确认状态/引用保留、信任不迁移。错误 JSON 导入后条目数保持不变。深浅主题、1280×860 和 820×700、中文和英文、两个字幕入口均完成渲染与真实点击检查。

截图位于被 Git 忽略的 `test-results/translation-knowledge/`，包括空态、导入预览、来源详情、编辑、备份、错误、窄窗与英文状态。主任务实际查看了截图；据此修复了窄窗侧栏占满首屏、工作台入口被 Tab 遮挡、英文导出按钮空间不足的问题。页面及弹窗沿用共享组件，局部调整没有改动全站布局。

独立 Agent 仅使用随包 Skill 和虚构用户要求，生成《星港漫游》初始包与更改 shuttle 译名的更新包；两次 CLI 均为 valid=true、0 错误、0 警告。保留 9 个原有 UUID，仅实际修改的包与术语升修订，新增用户说明来源；没有联网声明、虚构确认字幕或人物口吻扩散。另已将校验器复制出仓库独立运行，验证无需 npm 安装。结构合法不等于实际翻译质量通过，后者属于 P1/P3 评测。

### P0.1 提交

设计文档提交为 `f20ab93`，P0.1 代码按用户要求提交为 `8a5fe82`；均未推送。后续开发继续使用本分支，最新进展、验收和限制见下方 P0.2 记录。

P0.1 验证没有启动 Vite 开发服务；Electron 用例在 afterAll 关闭自己的实例并清理临时用户目录。

## 已完成增量 P0.2：影响可见的维护与分享

用户于 2026-09-14 明确要求先提交后继续开发；P0.1 已提交为 `8a5fe82`，提交后工作区干净。本增量继续沿用 V3 §8、§9、§10.3、AC-03/06/09/23；尚不接入翻译请求。

| 任务 | 写入范围/负责人 | 状态 |
| --- | --- | --- |
| T05 导入补偿、归档/恢复、影响分析及永久清除 | `electron/main/translation-knowledge/repository.ts` / `service.ts` / 新维护模块、`test/translation-knowledge/maintenance.test.ts`；仓库 Agent | 已完成 |
| T06 方案依赖分享与来源预览选择 | `electron/main/translation-knowledge/export-selection.ts`、`test/translation-knowledge/export-selection.test.ts`；协议 Agent | 已完成 |
| T07 维护/历史记录/导出预览/拖入交互 | `src/pages/TranslationKnowledge/`、四语言 knowledge 文案、UI model 测试；界面 Agent | 已完成 |
| T08 统一契约、原生桥接、固定导出字节与集成 | 共享 maintenance/export/ipc 契约、主进程 index/ipc、新 export-plans 模块、preload、IPC/Electron 测试、本记录；主任务 | 已完成 |

### 行为和事务决策

- 维护统一为主进程影响预览和确认提交，绑定 owner、generation、目标内容和有效期。归档保留历史，取消归档不恢复旧采纳。显示受影响条目、来源、风格及方案；当前任务追踪尚未接入，不能显示未经查询的零任务影响。
- 导入记录保存实际 before/after 变更证据。撤销生成补偿修订/归档；目标后来编辑、审核或新增引用则整笔阻止并列出冲突。既有 P0.1 导入没有足够证据时明确不可撤销。其他后续编辑不回滚，旧导入收据重试不复活撤销资料。
- 永久清除是独立的高级操作，仅允许已归档记录和无保留引用的来源；预览不得静默扩大目标。由于当前每个历史 generation 保存整库，本版清除会明确要求一并清理全部本地资料库历史快照与撤销正文，并列出数量及失去撤销能力的导入。其他当前资料保留。此限制符合 V3 的影响确认要求，后续可优化为更细粒度历史存储；不是静默删除历史。只在隔离测试库执行此功能验收。
- 清除先持久化净化数据和精确文件清理清单，再切换 current，最后删除历史；发布前失败保留旧库，发布后失败保留待清理状态并允许重启续做，不能回退到含已清除正文的版本。清理中阻止新写入。用户的外部备份及存储介质底层残留不属于清除范围。
- 分享显式选择资料集/方案，显示方案增加的读取集、风格规则和来源数量；学习写入目标只带目录元数据。候选/停用与参考译文分别显式选入；不可满足的方案依赖阻止导出。来源剔除采用整条排除，不改原实体身份；完整备份不筛选。
- 导出预览提供全部实际来源摘录和记忆片段。主进程保存预览对应固定字节、digest与generation，确认保存使用同一份字节。拖入仅经 preload 的真实 File 路径转换，公开 API 不接受任意路径。

### 界面设计与验收

沿用已验收的资料页三视图和共享 KnowledgeDialog；维护/历史记录入口放在资料页操作区，不额外占据主要列表首屏。条目详情、对象/资料集、方案的归档/恢复先进入同一个影响弹窗；永久清除单独展示历史影响及显式确认。失败保留预览，过期计划要求重新查看。导出采用“选择内容 → 查看将带出的资料与摘录 → 保存”，选项变化使旧预览失效。拖入显示局部反馈，不覆盖原列表数据；窄窗继续保持同一控制器。

必要验证：真实目录的补偿/幂等/旧格式读取/清理阶段故障与重启恢复；选方案的依赖、语言、记忆与来源排除反例；IPC所有者/过期字节计划与伪造拖入拒绝；真实Electron导入→撤销→归档恢复→影响检查→分享预览和导出→隔离库清除，中文/英文窄窗与深浅主题截图。验证后填入结果，不把本增量等同于实际翻译质量评测。


### 2026-09-14 P0.2 验证结果

| 检查 | 结果 |
| --- | --- |
| 全量知识模块测试 | 103 项通过：协议 17、仓库 24、维护 20、真实进程终止 4、导出选择 14、固定导出计划 4、IPC 10、界面模型 10；Electron 单独启用 |
| 最终构建上的 Electron | 1 条完整场景通过，约 24 秒；临时用户目录、真实 OS File/IPC/文件与服务，无真实用户资料 |
| TypeScript / 三段 Vite 构建 / preload 检查 | 全部通过；沿用已安装 Node 工具，保留已有构建提示 |
| 四语言完整性与使用点 | 全部通过；414 个 knowledge key，2,440 个翻译调用均可解析；21 个既有同文案提示无新增 |
| FK-TK 便携产物 | 3 个生成产物检查通过，文件协议未改变 |
| 工作台边界与冻结副本 | 448 文件、0 边界错误；120 个冻结副本和执行器 1 文件/26 依赖检查通过 |
| 差异及进程 | diff 检查通过；未修改依赖或 pnpm-lock；未启动 Vite 服务，测试 Electron 和崩溃子进程已全部退出 |

Electron 场景覆盖原生选择导入、五类资料审核/编辑、预览后备份、独立仓库恢复、拒绝伪造 File、真实文件拖入、撤销导入保留后续无关编辑和旧采纳、恢复后重新审核、归档、显式确认全部历史清理、保留其他当前资料、选择方案自动带入依赖、展示实际来源摘录、默认排除参考译文、剔除必要来源阻止导出及重新选回后成功保存。还检查了错误文件不影响原库、两个字幕入口、中文/英文、1280×860 与 820×700、深浅主题和窄窗弹窗的横向溢出/底部边界。

真实子进程使用 `process.exit(77)` 跳过 catch/finally，覆盖半写清理日志、在 UTF-8 多字节中断的 generation、完整日志尚未切换 current、current 已切换但尚未清理。独立审查发现的半写日志阻断旧库问题已修复：先写独占 pending 文件、flush，再原子发布完整日志。写入与读取使用相同的 16 MiB 日志上限。重启可保持旧库或继续已提交清理；清理按最多 128 个实际删除文件/约 1.5 秒分批进行。同步异常、符号链接、文件被替换、来源保留、撤销幂等和旧格式读取另有真实临时目录回归。

主任务和独立界面 Agent 实际读图并修复：归档/恢复/撤销请求误带永久清除确认字段、历史清除后误称早期记录、备份被误标为主动选集、清除说明重复、来源署名与操作间距。统一改用共享 ScrollableDialog 的固定头尾与内容滚动。截图保存在 Git 忽略目录 `test-results/translation-knowledge/`，新增维护历史、撤销/恢复/归档、清除确认、方案依赖导出及深色窄窗历史/导出；撤销截图明确等待预览标题，避免保存等待态。

### P0.2 交接基线（已进入下方 P1.1）

P0.2 已按用户后续要求提交为 `422fa7b`，未推送。下一阶段从 P1 的任务选用与确定性检索/编译开始：先冻结资料作用范围、冲突处理、调用契约及验收样例，再接入两个字幕工具、试译和冻结快照。P0.2 提交时管理页和文件往返可用，翻译请求尚未读取这些资料。P1.1 的试译接入进展见下文；实际翻译质量仍需后续评测。

继续保持以下边界：本地单进程仓库；无云端依赖；完整备份覆盖当前实体而非本机采纳/完整历史；方案分享不携带无关库级来源声明，备份保留；相同 namespace 的不同根扩展仍明确拒绝导入，元数据冲突编辑待后续。永久清除本版需要明确确认清理全部本地历史，保留其他当前资料、包级说明和另行保留的来源，不能保证独立文本副本或外部备份一并删除。任务影响追踪、完整历史恢复 UI、原生 Windows 和真实断电耐久仍未验收。原生导出依赖支持硬链接的文件系统，FAT32/exFAT 可先导出本机再复制。


## 已完成增量 P1.1：工作台资料检查与独立试译

用户再次明确要求提交后继续开发；沿用 V3 §5–6、§13 第一个纵向切片和 AC-05/11–15/18/19/24。P0.2 提交后工作区干净。实现授权来自本任务连续用户指令，无真实数据迁移、远程发布或付费验收调用。

当前实现范围：字幕工作台单文件的资料选择、逐句范围检查、按完整请求预算编译，以及独立试译对照。支持背景/术语/规则；表达和参考译文明确提示尚未参与。本次来源语言由用户明确指定，不作自动识别或混合语种保证；目标语言明确为BCP47（简繁分开）。方案的角色只提供建议，不能自动确认人物说话范围；当前主题/人物和条件确认绑定本次选中的cue，默认开头最多20句，可选当前页具体句子。冲突可通过本次禁用条目或调整逐句范围解决。

正式翻译的旧 strict 配置保持不接收增强字段；正式任务、批量、自动与独立翻译器尚未启用资料增强。该分期来自实查：工作台批量目前只保存config并在start时重规划；checkpoint v1缺知识正文/实际请求，清理task还会删掉唯一任务快照。旧入口wire cue ID逐片重置，checkpoint v2缺调度模式且成功即清理，预算也尚未采用最终HTTP体。正式接入须另做冻结存储和全入口矩阵，不能只拼接prompt宣称P1完成。

| 任务 | 写集与负责人 | 状态 |
| --- | --- | --- |
| T09 中立执行契约、可信范围/冲突/编译 | `src/translation-knowledge/execution-contract.ts` / `execution.ts`；主任务 | 已完成 |
| T10 固定Unicode匹配和反例 | `src/translation-knowledge/matching.ts` / Unicode数据、matching/execution测试；匹配Agent | 已完成 |
| T11 工作台试译生命周期和真实请求预算 | 新 `electron/main/subtitle-studio/knowledge-trial.ts` / `test/subtitle-studio/knowledge-trial.test.ts`；工作台Agent | 已完成 |
| T12 应用注入、IPC、工作台UI和集成 | 试译契约、主入口/preload/工作台index、StudioKnowledgeTrial/StudioTranslation、四语言、边界审计、Electron验证和本记录；主任务 | 已完成 |

设计基准：在现有单文件翻译配置中提供次级“资料检查与试译”入口，沿用模型与预算，不替换正式开始按钮。独立ScrollableDialog固定头尾，12px内容padding，选语言→选资料/方案→确认范围→检查→调用模型；高级角色/条件按需要展开，内容逐句和资料来源可展开。原译对照与实际usage留在当前会话，不写正式轨、不确认、不积累；关闭取消尚未完成调用并清理会话。长条目/错误可换行，820×700、1280×860、深浅主题、中英文真实Electron验证。预览变更使旧结果失效，异步结果以草稿身份隔离，失败保留输入。

必要验收：没有资料仍能试译；未经准确摘要采纳不得进入请求；多主体AND、仅提及/未知人物不串范围；条件仅确认的cue生效；同形/重叠强制冲突阻断；可选冲突不随排序随机取值；准确简繁/方向；完整Unicode匹配；必需条目不被预算截断，最终HTTP序列化估算与实际一致；旧协议输出仍严格校验，缺强制术语只提示；owner/TTL/新草稿/取消/源文变更/删除/退出清理；真实试译请求捕获和结果不修改正式文档。真实模型质量与正式恢复继续待后续，不把本地固定响应验收作为翻译提升证据。

### P1.1 关键实现约定

- `execution-contract.ts` 保存本次任务的选择与逐句确认，FK-TK/1 文件仍不包含字幕 cue ID。本轮 UI 每句每种角色可选择一个对象；执行层支持多对象 AND，但任意多主题的批量绑定界面留待后续。语言要求规范 BCP47，中文必须明确 Hans/Hant。
- 采纳要求 entry 的 revision 与规范内容摘要同时一致；背景、术语和规则只能在满足主体、角色、语言及额外条件的句子中使用。方案人物不自动成为说话者。背景采用已选资料范围，不进行语义检索；可选术语优先，其余按固定实体 ID 次序保留。规则同维度且文本不同采用保守冲突判断，不声称能够自动判断语义兼容。
- `matching.ts` 固定 Unicode 16.0 NFC、完整大小写折叠和 L/M/N/Pc 边界，保留重叠命中及规范化原文的 UTF-16 范围。数据来源、哈希与离线生成器随源码提供；Unicode License V3 同时进入 `public/licenses/` 并随 renderer 产物分发。
- 本轮检查上限由 `KNOWLEDGE_EXECUTION_LIMITS` 统一定义：2,000 条资料、术语与规则合计 500 条、每术语含原词最多 128 个变体、5,000 个去重命中、累计 8 MiB 匹配与目标规范化扫描、100 万次冲突比较。另限 20 句、单句 64 KiB UTF-8、单预览 8 MiB。任何计算上限触发均阻止整次试译，不把部分检查当成完整结果；用户可缩短片段或减少资料。
- `KnowledgeTrialService` 由应用主入口注入只读资料快照；Studio 不导入旧字幕翻译实现或知识仓库。首次检查绑定界面所见 knowledgeGeneration，变化时拒绝旧确认；界面刷新资料、清除额外条件确认及临时禁用，再让用户重新检查。正常运行使用主进程已冻结的请求，不重新读取后来编辑的资料。
- 使用最终 HTTP 请求的序列化路径估算输入，包含固定系统约束、原文、任务要求、必要资料与可选资料，并预留输出。超预算先减可选资料，再减相邻原文，最后缩小批次；必要资料仍无法容纳则阻断。前一批试译不注入下一批，避免计划后动态追加内容。父表单要求作为默认本次要求，显式空字符串允许覆盖清空。
- 只有固定 plan/run/cancel IPC 可操作试译，所有者与文档授权均校验；主进程不向模型发送本地 UUID、文件名或来源摘录。逐条资料正文以请求内字幕 ID 限定作用范围。输出继续使用 Studio 严格逐句协议，缺少强制术语仅提示复核，不自动改写或采纳。
- 试译结束、失败或取消均返回实际调用次数及可获得的 token 用量；未知用量保留未知。关闭、文档变更、所有者失效和应用退出都取消并等待已开始的调用结束。没有正式译文轨、审核、学习或恢复快照写入。
- 边界审查仅增加 11 个确实共用的纯协议/执行文件，不放行整个目录；冻结 ASR 来源与副本不改。应用组合变化仅更新当前组合审计的准确文件摘要及说明。

### 后续 P1.2 接入顺序

先设计持久化的知识/请求冻结快照及任务影响索引，确定编辑资料、暂停恢复、清除任务与保留译文时的行为，再接入工作台正式单文件、批量与自动翻译；随后适配独立翻译器。两条入口共享中立执行模块，各自保留任务与持久化边界。表达/参考译文检索、全局偏好应用、混合语言判定、译文确认与学习另行细化，不由本轮试译模拟实现。真实模型质量需要用户选定模型与授权语料的对照评测，本地响应验证只证明应用流程和请求范围。


### 2026-09-14 P1.1 验证结果

| 检查 | 结果 |
| --- | --- |
| 领域及受影响回归 | `node node_modules/vitest/vitest.mjs run test/translation-knowledge test/subtitle-studio/knowledge-trial.test.ts test/subtitle-studio/ipc.test.ts test/subtitle-studio/translation-service.test.ts test/subtitle-studio/translation-checkpoint.test.ts test/subtitle-studio/translation-recovery.test.ts test/subtitle-studio/automatic-translation.test.ts test/subtitle-studio/batch-service.test.ts test/subtitle-studio/boundaries.test.ts --maxWorkers=4 --minWorkers=1`：336 项通过；4 项按环境跳过（两个 Electron 场景及两个 Windows 专用用例） |
| 新执行与 IPC 定向复验 | execution 60、Unicode matching 34、trial service 16、Studio IPC 26，共 136 项通过；2 项 Windows 条件跳过 |
| 最终构建上的 Electron | `FUSIONKIT_KNOWLEDGE_E2E=1 node node_modules/vitest/vitest.mjs run test/translation-knowledge/trial-electron.test.ts --maxWorkers=1 --minWorkers=1`：1 条完整场景通过，约 16 秒 |
| TypeScript / 三段构建 / preload | `tsc --noEmit`、`vite build --mode=test`、`check-preload-bundle.mjs` 全部通过；沿用已有 bundle 大小与混合导入提示 |
| 语言完整性与实际使用 | `check-i18n.mjs`、`check-i18n-usage.mjs` 通过；468 个 knowledge key 四语言齐全，2,481 个调用均可解析；21 项既有同文案提示无新增 |
| 文件协议与来源 | `build-artifacts.mjs --check` 的 3 个便携产物一致；`copy.mjs --check` 的 120 个冻结副本、执行器 1 文件/26 依赖检查通过；Unicode 原始许可证与 dist 分发副本逐字节相同 |
| 依赖边界 | `check-boundaries.mjs`：463 个文件、0 错误；边界反例测试通过 |
| 工作区 | `git diff --check` 通过；没有修改 package.json、pnpm-lock.yaml 或冻结 ASR 副本 |

验证环境为 macOS、Node 20.19.5（Unicode 16.0 / ICU 77.1）、Electron 41.10.6、已安装的 Vitest 2.1.9。未调用 pnpm、未安装依赖。Electron 只使用临时 profile、虚构知识包、原生选择文件与真实应用 IPC/业务服务；模型 HTTP 连接本机测试服务器，不调用付费模型。

最终 Electron 场景完成：导入不自动采纳→逐条审核→导入两句字幕→继承当前翻译要求→选择方案但不自动确认人物→逐句主题/说话者/被提及对象→仅第一句确认条件→查看第二句排除原因→调用模型→对照和实际用量。捕获请求验证术语及说话规则只进入第一句，来源摘录、文件名、本地 UUID 和未支持类型不发送；完整对比正式文档、译文轨、任务及资料库均无试译写入。另覆盖协议错误不留下旧成功结果、停止调用、取消期间关闭重开、旧 generation 拒绝后自动刷新再检查。

截图位于 Git 忽略的 `test-results/translation-knowledge-trial/`：`preview-light.png`、`result-light.png`、`result-dark-narrow.png`、`form-english-narrow.png`。主任务及界面 Agent 实际审图，按项目 UI/避坑 Skill 修复逐句提示不可定位、关闭重开忙状态残留、额外条件确认跨资料版本沿用；最终截图重新检查。820×700 和 1280×860、深浅主题与中英文场景均验证内部滚动容器无横向溢出，头尾按钮可用。

P0.2 已提交为 `422fa7b`；P1.1 已按用户要求提交为 `4853222`，未推送；继续在 `codex/feat-subtitle-ai-knowledge` 开发。没有启动 Vite 开发服务；Electron 和本地 HTTP 服务器通过 afterAll 关闭并验证退出，临时目录清理完成。正式双入口接入、持久化恢复与实际模型翻译质量未冒充通过，下一增量见上方 P1.2 顺序。


## 已完成增量 P1.2a：正式翻译执行记录与冻结恢复输入

用户再次要求“提交一下代码，然后继续推进后续的开发工作”；已先提交 P1.1 为 `4853222`。本增量沿用 V3 §6.5、AC-16 的恢复与追溯目标，先闭合正式翻译基础链路。知识完整资源版本、资料到任务的影响索引、永久清除协调及正式选用在后续增量接入，本次执行记录不冒充知识快照。

| 任务 | 写集 / 负责人 | 状态 |
| --- | --- | --- |
| T13 私有执行记录、领域引用及生命周期 | 新 execution-record-contract、domain/persistence-contract、repository/bilingual 必要适配与测试；存储 Agent | 已完成 |
| T14 正式任务冻结与恢复 | translation-service/recovery/contract、主进程执行记录 helper 与手动/批量/自动测试；运行 Agent | 已完成 |
| T15 执行记录界面 | StudioExecutionRecord、StudioTranslationStatus、局部样式；界面 Agent | 已完成 |
| T16 固定分页 IPC 与集成验收 | ipc-contract、preload、主入口、四语言、IPC/Electron 测试、组合审计及本记录；主任务 | 已完成 |

实现约定：译文轨只保存小型版本化引用；文档私有表保存完整冻结计划、各批次基础提示词以及发送前保存的实际请求。创建任务和执行记录同一事务提交；每批首次发送前将实际动态上下文、请求字节与 inFlight/attempts 一起提交。重试及恢复不重读当前模型配置、不重新投影原文或生成系统提示词；序列化适配器若无法再生成相同 HTTP 字节，明确阻止恢复。密钥、代理、signal 只在调用时注入，不写执行记录。32 MiB 聚合记录上限采用显式拒绝，不能静默截断。

旧 checkpoint v1 保持旧恢复路径，不编造历史请求；新手动、批量及自动 Studio 翻译统一创建 v2 任务。清理任务仍保留译文轨及执行记录；显式移除译文轨同时移除其记录。记录缺失、不支持或摘要不一致时，文档及已有译文仍可读取，恢复明确失败；不能因记录错误回退到较早的文档 generation。记录通过固定只读 IPC 每次读取一批，不在普通文档分页中传输整张私有表。

界面基准：沿用工作台紧凑状态栏和 ScrollableDialog，入口绑定当前 AI 译文轨，清理任务后仍可打开；旧轨明确说明未保存执行记录。固定头尾、12px 内容留白，概览模型/语言/保存时间/要求，正文按批次展示实际原文与上下文，上一批译文明确是未人工确认的 AI 输出。请求已保存不等于供应商已接收；原始 HTTP 字节仅在技术详情中展开。长正文自然换行，分页首尾、快速切换、关闭重开、错误与运行中刷新均需验证。

必要验收：新旧任务兼容、三个入口创建记录；实际发送字节与记录一致；中断/重试/恢复复用输入，未发送批次提示词也不漂移；源文/轨/模型变化和摘要/协议损坏阻止调用；首次发送前持久化失败无调用，发布后错误可对账；任务删除保留记录、轨删除清理记录；记录缺失不选择旧 generation；IPC 所有者、严格参数、私有字段和分页边界；真实 Electron 翻译→查看→中断重启恢复→清理任务后查看，深浅主题及窄窗截图。模型响应使用本地 fixture，验证流程和请求一致性，不宣称真实翻译质量提升已完成评测。


### P1.2a 兼容与存储边界

执行记录没有进入 FK-TK/1 知识导出协议；该协议的三个便携产物保持一致。记录当前随工作台文档 generation 保存，删除最后一个译文轨引用会清理当前记录表，previous generation 及用户外部备份不属于磁盘级永久清除。知识条目到任务的引用索引和清除协调仍须独立实现。

“执行记录错误不回退”指外层文档提交校验成功后的记录缺失、引用/摘要失配、未知版本或结构错误：这些错误只影响追溯/恢复，不撤销当前文档。外层 JSON 字节或整代校验和损坏仍采用既有 current/previous 整份文档恢复机制，本增量未重新设计物理损坏的数据抢救。真正断电、Windows 原生运行和大规模长片性能尚未验收。

策略固定为 `studio-translation/2;request-body/1`；未来变更须保留旧策略实现或明确拒绝继续，不能自动改写。执行记录上限为每文档聚合 32 MiB，文档总上限沿用 128 MiB。全量请求/预算校验只在准入和恢复执行一次，逐批运行校验当前批次；完整记录结构、摘要及文档仍有现有整份快照读写成本。自动任务若无法构造或容纳执行记录，会保存明确失败占位任务和源字幕，避免待处理意图阻塞初始化。

本轮新增 `translation_record_unavailable` 专用错误及四语言提示；本地记录不兼容不会使用“模型返回格式错误”文案，也不触发供应商重试。未开始的批次仍使用准入时的完整模板，动态前批 AI 译文只在发送前加入并原子保存；查看器以“已保存请求”描述该状态，不将它当作服务商收到或完成的证明。


### 2026-09-14 P1.2a 验证结果

| 检查 | 结果 |
| --- | --- |
| 相关模块回归 | `node node_modules/vitest/vitest.mjs run test/translation-knowledge test/subtitle-studio/execution-record.test.ts test/subtitle-studio/repository.test.ts test/subtitle-studio/bilingual-service.test.ts test/subtitle-studio/knowledge-trial.test.ts test/subtitle-studio/ipc.test.ts test/subtitle-studio/translation-service.test.ts test/subtitle-studio/translation-checkpoint.test.ts test/subtitle-studio/translation-recovery.test.ts test/subtitle-studio/automatic-translation.test.ts test/subtitle-studio/batch-service.test.ts test/subtitle-studio/boundaries.test.ts --maxWorkers=4 --minWorkers=1`：424 项通过，4 项环境跳过（两项 Electron 场景和两项 Windows 专用用例），约 16 秒 |
| 最终构建真实 Electron | `FUSIONKIT_STUDIO_E2E=1 node node_modules/vitest/vitest.mjs run test/subtitle-studio/translation-recovery-ui.test.ts --maxWorkers=1 --minWorkers=1`：1 条完整场景通过，约 48 秒 |
| TypeScript / 三段构建 / preload | `tsc --noEmit`、`vite build --mode=test`、`check-preload-bundle.mjs` 通过；保留既有 bundle 大小和混合导入提示 |
| 四语言与使用点 | `check-i18n.mjs`、`check-i18n-usage.mjs` 通过；2,507 个调用均可解析，既有 21 条同文案提示无新增 |
| FK-TK 文件协议 / 边界 / 来源 | 3 个便携生成产物一致；工作台 469 文件、0 边界错误；120 个冻结副本及执行器 1 文件/26 依赖检查通过 |
| 差异和环境 | `git diff --check` 通过；未改 package.json、pnpm-lock 或冻结 ASR 副本；使用已安装工具，无依赖安装或 pnpm 调用 |

新增契约/追溯测试 22 项覆盖两个 HTTP 格式、完整模板/精确请求正文、禁止运行时凭据写入、标记结构、32 MiB UTF-8 聚合限制、不可改写既有请求、清理任务保留记录、最后译文轨引用清理、缺失/未知版本/结构损坏/摘要失配仍选择当前有效文档。运行测试还覆盖三入口、8 类恢复损坏反例、供应商适配器序列化变化、当前 planner/projection 改变后旧模板仍复用、发送前事务故障不调用及发布后故障对账；自动记录上限失败不会阻塞源文和初始化。

最终 Electron 使用 macOS、Node 20.19.5、Electron 41.10.6、Vitest 2.1.9；隔离临时 profile、本地 HTTP fixture。先完成第一批、挂起第二批，查看已保存实际请求和第三批尚未发送状态；强制终止自身 Electron 后重启，原模型缺失/变化时阻止继续，密钥轮换可恢复。捕获第二批恢复前后 HTTP 字节完全一致，第三批保存的请求与实际发送相同。取消/迟到响应和供应商等待旧场景继续通过；清理任务再重启后记录与译文轨仍可查看。

主任务实际审阅浅色上下文、深色窄窗、清理任务后记录、英文窄窗和展开 HTTP 正文；界面 Agent 独立审阅前三类，无需样式修补。截图保存在忽略目录 `test-results/subtitle-studio-recovery/`：`execution-context-light.png`、`execution-dark-narrow.png`、`execution-after-task-cleanup.png`、`execution-english-narrow.png`、`execution-http-body-narrow.png`。验证覆盖 1280×860、786×540、820×700；等待全局 loading 退出并检查真实滚动区域、头尾操作和横向边界。中途英文窄窗测试曾点击已隐藏的桌面列表，已改为选好文档后切换窗口尺寸，最终完整场景重新通过；没有把脚本错误当成应用故障。

按项目避坑流程新增 FK-PIT-0156，记录“私有执行记录语义失败不能让当前有效文档回退”与未开始批次模板冻结、验证成本分层的规则。所有本轮 Electron/HTTP/Vitest 进程已退出，进程表只见用户其他项目原有 Vite，未处理该实例。

P1.1 已提交为 `4853222`，本轮 P1.2a 新增尚未再次提交或推送，保留在 `codex/feat-subtitle-ai-knowledge`。下一增量先完善完整知识版本快照、资料任务引用索引与清除协调，再把正式工作台单文件/批量/自动任务接入资料选用，随后适配独立字幕翻译器；本轮未启用正式知识增强，也未进行真实模型翻译质量对照评测。
