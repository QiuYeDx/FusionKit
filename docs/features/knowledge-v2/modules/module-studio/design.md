# studio 设计

总体方案与逐文件清单见 [architecture §3、§7.4–7.6](../../architecture.md#74-字幕工作台契约-srcsubtitle-studio)。

## 现状与约束

**资料链路**
1. 渲染层 `StudioMaterialsFields` 产出 `KnowledgeSelection`（含 recipeId、bindings、confirmations）和 `documentTopicIds`。
2. `translation-session.ts` 按场景投影。
3. 主进程 `knowledge-translation.ts`、`knowledge-batch-translation.ts`、`knowledge-trial.ts` 调用 `resolveEnvironment`，并冻结 `FrozenKnowledgeSnapshot`。
4. 冻结结果写入执行记录。

**转写后自动翻译**：转写前冻结资料，存入文档快照的 `automaticTranslation`；转写完成后，`automaticPlan` 用冻结的数据执行。

**旧数据**：不兼容。含旧冻结资料的记录或文档按作废处理，见 architecture §3。

## 方案与取舍

### 1. I1：主进程与契约（R-STUDIO-01）

- **选择结构**：所有请求契约（`knowledge-translation-contract`、`knowledge-batch-contract`、`knowledge-trial-contract`、`consistency-contract`、`cue-revision-contract`）引用新的 `knowledgeSelectionSchema`（strict），旧字段因此成为未知键而被拒绝。删除 `documentTopicIdsSchema`。
- **knowledge-translation.ts**：
  - 删除 `scopedSelection`，选择直接传递；
  - `scanCost` 只按 `selection.collectionIds` 计算；
  - 删除 `knowledgeGate`、`knowledgeResourceReferences` 和 `KnowledgeTaskGate` 参数。
- **knowledge-batch-translation.ts**、**knowledge-trial.ts**：同上；试译不再接收 bindings 和 confirmations。
- **knowledge-planner.ts**：
  - 发给模型的条目为 `{ kind, required, payload, matches }`，删除 `condition` 和 `title`；
  - 系统提示删掉关于「条件」的句子，保留「必须术语 / 重要说明」的表述。
- **执行记录**：
  - 单一策略常量 `KNOWLEDGE_TRANSLATION_POLICY_VERSION`，值改为 `studio-knowledge-translation/2;request-body/1`，以免误把旧记录当成新记录；
  - `validateExecutionRecord` 只接受这个值和 v2 快照，其他值走现有的「记录不可用」路径；
  - 删除 bindings / confirmations 的 cue 范围检查。
- **execution-view.ts**：输出 `knowledge = { digest, generation, collections: [{id, name}], items: 条目摘要 }`，删除 `recipeName`、`documentTopics` 和非空断言。
- **自动翻译**：
  - `automatic-translation-contract.ts` 的 `knowledge` 字段引用 v2 `frozenAutomaticKnowledgeSchema`；
  - `automaticPlan` 删除旧策略分支；
  - `automatic-knowledge-report(-contract)`：种子为 `{ selection }`，材料摘要为 `{ collections: [{id, name}] }`，问题码只用新的。
- **document-repository.ts**：删除 L353-407 的资料引用扫描，以及服务中依赖它的 `unknownDocuments`。
- **consistency-service.ts**：`knowledgeTerms` = 库中 `selection.collectionIds` 范围内、`enabled` 的术语，再排除 `disabledEntryIds`。
- **cue-revision-service.ts**：`materials` 用新选择结构调用 `resolveEnvironment`；`chunkMaterials` 的载荷与 planner 一致。
- **preferences-contract.ts**：`automaticKnowledgePreferencesSchema = { enabled, sourceLanguage, collectionIds, disabledEntryIds, instructions?, context? }`；`readTranscriptionPreferences` 不变。

### 2. I2：渲染层（R-STUDIO-02..05）

只写影响布局与交互的要点；I2 开始前补齐设计基准（参照、样本、状态）。

- **选择器** `StudioMaterialsFields`：
  - 参照：现有的 Popover 选择器（`studio-materials-picker` 及其 CSS）和 `StudioScrollFade`。
  - 面板结构，自上而下：
    1. 「预设」行：下拉、「存为预设」、管理菜单；
    2. 「最近使用」标签行：最多 5 个，点击即应用；
    3. 搜索；
    4. 资料集复选列表：方向不一致的置灰，并显示其方向；
    5. 底部：「管理资料」链接和「完成」按钮。
  - 面板外的摘要区：资料集标签，加上「来自预设 X」的提示；资料集一改动，这条提示就消失。
- **设计基准（T-STUDIO-04，2026-10-12 补）**：
  - **参照**：现有选择器截图 `test-results/translation-knowledge-materials-layout/picker-selected-zh-light-wide.png`。保留 Popover 卡片外观（宽 460、圆角、头部「选择资料 · 已选 N 个」、底部工具条与「完成选择」主按钮）、`studio-materials-*` 的间距和字号（12/11px），以及 `StudioScrollFade`。
  - **面板结构**（自上而下）：
    1. 「预设」区：若干可点击的预设行，每行包含名称、方向和资料集数量，以及「⋯」菜单（重命名 / 删除）；区块末尾是「存为预设」按钮。保存和重命名在区块内行内展开输入框，删除在行内二次确认，不叠加嵌套对话框。
    2. 「最近使用」区：最多 5 个紧凑行，显示资料集名并以「·」连接，点击即应用。
    3. 资料集区：标题、搜索，再加复选行。方向不同的行禁用，并在元信息中显示其方向和「方向不同」。
  - **状态**：加载中、读取失败（重新读取）、空库（去新建）、搜索无结果、预设为空（只显示「存为预设」）、无最近使用（不显示该区）、应用的预设含已删除资料集（面板顶部给出提示）。
  - **卡片外的摘要区**：资料集标签可移除，不再有锁定标记；「原文语言」行保留，选中第一个资料集时自动带入它的源语言，修改源语言会移除方向不同的已选资料集；去掉「适用范围」折叠区，「更多」折叠区保留内容说明与本次排除。
  - **样本**：资料集名 60 字以上、3 个方向不同的资料集、6 个预设、5 组最近使用；中 / 英，亮 / 暗；对话框宽 1280 与 900。
- **选择器重排（2026-10-12，用户反馈）**：真实资料库有 23 个资料集、15 个预设，原单列平铺（预设 → 最近 → 资料集，每行两行字并常驻编辑 / 删除）难以查看和选择；锚定在按钮上的 Popover 也只能用按钮上方的剩余高度。改为：
  - 居中面板（Radix Dialog，宽 520、高 min(640px, 100vh − 48px) 固定），头部「选择资料 · 已选 N 个」，其下固定「资料集 N / 预设 N」两个标签（`ClipPathTabs` rounded sm）和资料集搜索，只有列表滚动；底部工具条不变。
  - 资料集按名称前缀分组（「X · 主题」，前缀末尾的编号只作排序，如「共通 01」归入「共通」）；6 个以内或没有共同前缀时不分组。组头有整组复选（部分选中显示横线）、「已选 x/n」和折叠；行为单行：复选、去掉前缀的名称、条数，方向只在资料集方向不一时逐行显示，全部同向时在列表顶部说明一次；与本次方向不同的给出「方向不同」并禁用，全部不同时在顶部提醒先确认目标语言。
  - 预设标签：顶部说明与「存为预设」，预设同样按前缀分组为单行（名称、资料集数），重命名 / 删除收进「⋯」菜单；「最近使用」在其下。套用预设或最近组合后回到资料集标签，直接看到勾选结果。
- **预设管理**：在选择器内重命名（行内输入框），删除在行内二次确认。写入调用 `saveRecords` / `deleteRecords`，然后广播 `KNOWLEDGE_CHANGED_EVENT`。
- **最近使用**：`preferences.ts` 新增 `recentKnowledgeSets: { collectionIds: string[]; languagePair; usedAt }[]`，开始翻译或试译成功时记录一组。
- **试译** `StudioKnowledgeTrial`：删除角色选择和条件确认，只保留问题列表和参与资料的摘要。
- **自动翻译** `StudioAutomaticKnowledge`：复用选择器的紧凑模式。
- **记入**：
  - `QuickTermDialog`：删除来源实体和 adopt；新建资料集时显示方向选择，默认取当前文档方向。
  - `KnowledgeCaptureDialog`：删除 adopt 开关和对应说明。
  - `capture.ts`：改为调用新的提案接口。
- **执行记录**：`StudioExecutionKnowledge` 显示所用资料集和条目。

## 代码落点

- I1：architecture §7.4、§7.5 中的全部文件。
- I2：architecture §7.6 中的全部文件。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-STUDIO-01 | §1 全部 |
| R-STUDIO-02 | §2 选择器、预设、最近使用 |
| R-STUDIO-03 | §2 试译、自动翻译 |
| R-STUDIO-04 | §2 记入 |
| R-STUDIO-05 | §1 execution-view、§2 执行记录 |

## 验证与风险

- **I1**：按新结构重写 `test/subtitle-studio/` 中与资料相关的单元和集成测试，覆盖 knowledge-translation、batch、trial、automatic-*、consistency-*、cue-revision-*、execution-*、transcription-*、ipc、translation-session。删除只测试闸门、引用扫描、旧策略的用例。
- **I2**：在静默窗口中运行 Electron e2e，覆盖勾选资料集、存取和删除预设、试译、正式翻译、记入。按 frontend-quality 截图审查选择器：中英文、亮暗主题、窄宽视口。
- **风险**：契约中散落的资料相关字段可能漏改。对策：I1 结束时用 TSC-I1 检查，并 grep 确认 `bindings`、`confirmations`、`documentTopicIds`、`recipeId` 在工作台契约和主进程中没有残留。
