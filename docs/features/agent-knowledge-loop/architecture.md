# 总体设计

业务目标与批次见 [brd.md](brd.md)。本文记录跨批次的现状盘点、核心概念与各批方案；当前批次的可验收行为以 `modules/*/requirements.md` 为准。

## 现状盘点（基线 45a88e0）

| 领域 | 现状 | 代码位置 |
| --- | --- | --- |
| 资料数据 | FK-TK/1：对象 subjects、资料集 collections、证据 sources、条目 entries（term/context/rule/expression/memory）、风格 styles、方案 recipes。条目需 ≥1 条证据；「可信」= `state=ready` 且本地 approval 与当前 revision/摘要一致 | `src/translation-knowledge/schemas.ts`、`ipc-contract.ts` |
| 资料写入 | 主进程串行队列 + 乐观并发（generation）。`saveRecord` 一次只存一条记录（可附一条证据、可 `adopt`），每次写入整库校验；没有批量写入、没有搜索接口 | `electron/main/translation-knowledge/service.ts:254` |
| 资料使用 | 仅字幕工作台。翻译时按用户选择的方案/资料集、语言对、对象绑定、字面命中解析条目，注入请求；经典字幕翻译器不用资料 | `src/translation-knowledge/execution.ts`、`electron/main/subtitle-studio/knowledge-planner.ts` |
| 冲突检测 | 校验器对「同语言对 + 同原文/别名 + 不同译文」给出 `TERM_TRANSLATION_CONFLICT` 警告；翻译时同句重叠术语冲突给 `term_conflict` | `validation.ts:219`、`execution.ts:140` |
| 快捷记录 | 工作台右键「记住术语」→ `QuickTermDialog`：一次一条，直接启用 | `src/pages/TranslationKnowledge/QuickTermDialog.tsx` |
| Agent 资料工具 | 仅 `search_translation_knowledge`：只读，对条目标题+摘要、资料集名、方案名做单子串匹配 | `src/agent/modern-tools.ts:353` |
| Agent 写入确认 | `registerPreparedAction` + 卡片确认；`auto_execute` 会自动确认。AI 修订另有「只在页面预览中由用户应用」的先例 | `src/agent/prepared-actions.ts`、`AgentPreparedActions.tsx` |
| 页面上下文 | 字幕工作台与经典页注册了快照与页面工具；翻译资料页没有 | `src/agent/page-context.ts` |
| AI 修订 | 选中行/全文 → 定位 → 分块修订 → 预览 → 应用（可撤销）。不读取资料；每个请求只返回一句 note，没有「可沉淀译法」 | `StudioCueRevision.tsx`、`src/subtitle-studio/cue-revision-contract.ts`、`electron/main/subtitle-studio/cue-revision-service.ts` |
| UI 事件回报 | 卡片确认/拒绝等以 `[FusionKit UI event]` 回报 Agent 并触发跟进；修订是否被应用不会回报 | `src/agent/ui-events.ts`、`orchestrator.ts:288` |
| 联网 | 无任何网页检索/读取能力；任务模型请求在主进程用 axios（支持应用代理） | `electron/main/ai/model-runtime-client.ts`、`electron/main/proxy.ts` |

## 核心概念：资料变更提案

所有批次共用同一套「提案 → 核对 → 原子保存」链路，避免每个入口各写一套保存逻辑。

```
来源（Agent 对话 / 修订提示 / 一致性检查 / 联网查证）
   │  KnowledgeProposal：对象、资料集、条目的新建/修改/归档，带依据 basis 与证据
   ▼
构造与预检（渲染进程，纯函数）  src/translation-knowledge/proposal.ts
   │  解析引用 → 生成完整记录 → 与当前库合并后跑 validatePackage
   │  → 每项给出 status：new / update / archive / exists（跳过）/ invalid，及冲突警告
   ▼
可信界面核对：Agent 变更卡片（I1） / 批量记入对话框（I2、I3）
   │  用户可切换「保存后直接启用」，可取消
   ▼
原子保存  window.translationKnowledge.saveRecords（主进程一次事务、一次 generation）
   │  失败则全部不写；成功返回新快照与回执
   ▼
回执：卡片/通知显示结果、可跳转到资料集；Agent 收到 UI 事件后简短回报
```

### 依据与可信度

| basis | 场景 | 证据 source.kind / support | 默认 |
| --- | --- | --- | --- |
| `user_stated` | 用户在对话中明确说出译法/约定 | `user_note`，摘录用户原话（≤300 字）/ direct | 保存并启用 |
| `user_revision` | 来自用户亲自应用的修订（I2）或一致性检查中选定的标准写法（I3） | `user_note`，摘录修订说明与原句 / direct | 保存并启用 |
| `document` | 从字幕原文/现有译文归纳，用户未明确表态 | `ai_proposal`，摘录字幕行 / inferred | 存为待审核 |
| `agent_inferred` | 模型自身知识推断 | `ai_proposal` / inferred | 存为待审核 |
| `web` | 联网查证（I4） | `web`，含 url、标题、访问时间 / direct | 存为待审核 |

「保存并启用」= 写入 `state=ready` 并记一次 `human` 批准，与 `QuickTermDialog` 的语义一致：用户在界面上看到了将要保存的确切内容并确认。只要提案中含非用户来源的条目，开关默认关闭；用户可手动打开（视为人工核对）。强制（required）术语/要求与核心背景沿用审核策略：卡片上单独标注，启用时逐条批准而非批量采纳。

### 写入边界

- 允许：新建对象（作品/人物/领域）、新建资料集、新建与修改 term/rule/context、归档条目（可在资料页恢复）。
- 不允许：永久删除、修改方案/风格、修改证据、导入/撤销导入、执行维护清理。
- 修改与归档按条目 revision 检查；提案准备后库被其他操作改动时，保存前按最新库重新预检，受影响项变为冲突并整体失败，不做部分保存。
- Agent 不得在卡片确认前声称「已保存」；确认结果以 UI 事件回报后才能确认完成。

## I1 Agent 检索与维护资料

模块需求：R-AGENT-01..04、R-KNOWLEDGE-01..02。

| 层 | 契约 | 代码落点 |
| --- | --- | --- |
| 批量保存 | `saveRecords({ generation, items: [{ group, record, source?, adopt? }] ≤200 })`：逐项沿用 `saveRecord` 语义，在同一事务内执行，整库校验一次；任一项失败整体回滚；完全相同的重放返回 unchanged | `service.ts`、`ipc.ts`、`index.ts`、preload `translation-knowledge-api.ts`、`ipc-contract.ts` |
| 提案构造 | `buildKnowledgeProposal(input, snapshot)` → `{ items, saveRequest, warnings, counts }`；纯函数，渲染进程与测试共用 | `src/translation-knowledge/proposal.ts` |
| 检索 | `search_translation_knowledge` 增强（多词、对象名/别名、资料集说明、术语别名/备注、按对象/语言对筛选）；新增 `list_translation_knowledge_catalog`（对象、资料集含条目数与语言对、方案） | `src/agent/knowledge-tools.ts`（从 modern-tools 拆出资料相关工具） |
| 变更提案工具 | `prepare_knowledge_changes`：校验 → 构造提案 → 注册准备动作（`requiresConfirmation`，任何模式不自动确认）→ 返回 prepared 与逐项摘要 | 同上；`prepared-actions.ts` 增加 `knowledge` 详情与确认选项 |
| 变更卡片 | 卡片内列出逐项变更、冲突/跳过原因、「保存后直接启用」开关；确认后显示回执与「在翻译资料中查看」 | `src/pages/HomeAgent/components/AgentKnowledgeChanges.tsx`，`AgentPreparedActions.tsx` 分支 |
| 资料页上下文 | 翻译资料页注册快照：当前视图、所选资料集、可见条目摘要（≤20）、批量选择；接收导航状态 `{ collectionId, entryId }` 定位 | `src/pages/TranslationKnowledge/agent-context.ts`、`index.tsx` |
| Agent 指引 | 记录/修改资料的步骤：查目录 → 选资料集（无则提议新建对象+资料集）→ 从字幕取原文 → 准备提案 → 等确认事件；语言对取文档/资料集，中文用 zh-Hans/zh-Hant | `orchestrator.ts` 系统提示、`agent-context.ts`（工作台说明补一句） |

关键取舍：

- **为什么新增批量接口而不是循环调用 `saveRecord`：** 一次提案常是「对象 + 资料集 + 若干条目」的依赖组合，循环保存中途失败会留下孤立的资料集或半套条目，且每步都要处理 generation 变化。主进程已有整库事务与校验，批量化成本低、语义最清楚。`BulkTermPaste` 等现有逐条入口不在本批改动。
- **为什么卡片总要确认：** 资料没有通用撤销，且会影响之后所有翻译；与「AI 修订只在预览中由用户应用」保持一致。确认只需一次点击，自动执行模式下也只多一步。
- **新条目默认不加对象门槛：** Agent 创建的条目 `requiredSubjects` 为空，`aboutSubjectIds` 记录所属作品；只要资料集被选用就生效。作品隔离靠资料集（如「绝区零 · 人物与称谓」），避免用户还要在翻译时绑定对象才命中。
- **term 的匹配默认 `literal_phrase` + 不区分大小写**，与资料包制作规范一致（日文连写不适合 whole_term）。
- **检索仍在渲染进程过滤**：沿用现有 `read()` 快照，新增匹配字段与分词即可；结果有界，不把证据摘录交给模型。

UI 基准见 [module-agent 设计](modules/module-agent/design.md)。

## I2 修订 ↔ 资料（规划）

- **修订参考资料**：`reviseCues` 请求可携带当前文档翻译草稿中的 `KnowledgeSelection`（`translationDraftMemory`）；主进程按块 `resolveEnvironment` 后把资料并入修订载荷（复用 `knowledge-planner` 的编译）。修订对话框显示「参考资料：方案名 / N 个资料集」或「未选用资料」。
- **可沉淀译法识别**：修订响应增加可选 `knowledge: [{ source, target, note }]`（每请求 ≤5）。提示词只在修订确立了可复用约定（专有名词、称谓、反复术语、用户说明里的规定）时输出。主进程过滤：原文须字面出现在本块原文中、译文须出现在修订后译文中；跨块去重；与库中已启用的同译法条目相同则丢弃，库中同原文不同译法标为「与现有不同」。
- **工作台询问**：应用修订后，原有「已修订 N 条 · 撤销」通知追加「发现 N 条可记入翻译资料的译法 · 查看」；打开 `KnowledgeCaptureDialog`（把 QuickTermDialog 推广为多行：勾选、可编辑原文/译文、选择或新建资料集、启用开关），保存走 I1 的提案构造与 `saveRecords`。忽略后本次修订不再提示。
- **Agent 跟进**：修订由 Agent 发起时，`studio_prepare_revision` 结果附 `knowledgeHints`；新增 UI 事件 `revision_applied`（应用条数 + 提示摘要）回报 Agent，Agent 询问一次是否记入并在用户同意后给出 I1 变更卡片。

## I3 术语一致性检查（规划）

- **入口**：工作台工具栏「一致性检查」（当前文档）；文档列表多选「检查术语一致性」（≤20 个文档、合计 ≤5000 条）；Agent 页面工具 `studio_check_consistency`（打开检查并返回分组摘要）。
- **检查流程**（主进程 `consistency-service.ts`，复用修订服务的取消/计费/错误映射）：
  1. 资料核对（不调用模型）：所选资料集中已启用术语，原文命中但译文未出现规定译法的行。
  2. 抽取（模型，按块 ~120 行）：返回反复出现的名称/术语及其各种译法、疑似同一名称的不同原文写法（听写错误）。
  3. 合并（确定性）：NFKC + 大小写折叠后按原文分组，回扫全部文档统计每种写法的出处；有 ≥2 种写法、或与资料不一致、或存在原文变体时成为一个问题组。推荐写法：已启用资料 > 多数写法。
- **结果对话框**：按问题组列出写法与出处数量、推荐写法；用户选定或输入标准写法，展开可见逐行差异；「统一所选」对每个文档生成一次 `revise` 编辑（字面替换，不再调用模型）。当前文档可用工作台撤销；其他文档在回执中提供「撤销本次统一」（保存各文档的逆操作）。勾选「记入翻译资料」的组在应用后打开批量记入对话框。
- 待定：Q-02（跨文档撤销保留多久、是否允许修改原文）。

## I4 联网查证（规划）

- **主进程服务** `web-lookup`：`search({ query, source? })`、`read({ url })`，经固定 preload API 暴露；请求走应用代理设置；只允许 http/https 公网地址（拒绝 localhost/内网，防 SSRF），响应 ≤2 MiB，正文抽取后 ≤8000 字符，超时 15s。
- **来源**（Q-01 待定，推荐方案）：默认无需密钥的 MediaWiki API（中/日/英维基百科，用户可添加萌娘百科、B 站游戏 wiki 等 MediaWiki 站点）；可选填入密钥的通用搜索（Tavily / Brave / 自建 SearXNG）。
- **设置与隐私**：设置页「允许 Agent 联网查询」默认关闭；关闭时工具返回 `web_lookup_disabled`，Agent 提示开启入口。只发送查询词与用户/搜索给出的 URL，不发送资料库或字幕全文。
- **Agent 工具**：`web_search`、`web_read`；提案中联网条目 basis=`web`，证据含 url/标题/访问时间与简短自写摘要，默认待审核。

## 风险与验证策略

- 单元测试覆盖服务事务、提案构造、工具边界（mock `window.translationKnowledge`）；主进程服务测试使用临时目录真实读写。
- 用 `test/agent-dock.electron.test.ts` 同款本地 SSE 脚本模型复现背景对话：Agent 调用工具 → 卡片 → 确认 → 资料库可见，证明真实 IPC 与渲染链路；不调用付费 API。
- 真实模型是否遵循指引无法由自动化证明，交付时如实说明，由用户试用验收。
- 不新增依赖。
