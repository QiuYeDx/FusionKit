# 字幕翻译知识开发记录

设计基线：[V3](../FusionKit_AI_Translation_Design_V3.md)。用户于 2026-09-14 明确要求创建功能分支并开始推进开发，授权按已讨论设计连续实施；没有部署、真实数据迁移或远程发布操作。

分支：`codex/feat-subtitle-ai-knowledge`；起点：`f20ab93`。协调与集成：主任务。沿用现有设计作为权威需求，不复制另一份字段规范。

## 当前增量 P0.1：协议与资料文件往返

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

### 后续增量（未实施，不阻塞本轮基础闭环）

- P0.2：撤销整次导入、永久清除与完整影响分析、选择方案连同依赖导出、原生拖入知识文件；补齐 P0 全部维护 AC 后才能称 P0 全阶段验收。
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

### 后续接手

从本分支工作区继续。设计文档此前已提交为 `f20ab93`；用户于 2026-09-14 确认先提交本轮 P0.1，再继续 P0.2；本记录随 P0.1 代码一起提交，未推送。先按上方后续增量补 P0.2，再展开 P1 的实际任务选用、检索/编译和冻结快照；不能仅因存在管理页面就宣称翻译请求已经使用这些资料。

需要保留的实现限制：仅本地单进程仓库；没有云端依赖；完整备份包含所有当前实体但不包含本机采纳和完整历史；选集分享暂不携带方案/风格/偏好模板；根扩展同 namespace 不同内容会明确拒绝导入，暂不提供元数据冲突编辑。原生导出暂依赖支持硬链接的文件系统，FAT32/exFAT 等位置会给出明确提示，可先导出到本机再复制到备份盘。原生 Windows、断电耐久与更丰富恢复界面待后续验收。

本轮没有启动 Vite 开发服务；Electron 用例每次在 afterAll 关闭自己的实例并清理临时用户目录，最终进程检查未发现遗留的本轮实例。
