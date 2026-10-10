# studio 设计

只详细设计当前增量（I2）。整体链路见 [总体设计](../../architecture.md)。

## 现状与约束

- 修订契约与提示词：`src/subtitle-studio/cue-revision-contract.ts`；主进程 `electron/main/subtitle-studio/cue-revision-service.ts` 分块（40 条）并发请求，`parseCueRevisionResponse` 宽松解析；结果只有每请求一句 note。
- 修订对话框：`src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx`，已读取 `translationDraftMemory`（只用了模型与输出上限）；应用经 `onApply(op, count)` → `index.tsx` 的 `applyCueEdit`，可撤销。
- 资料解析：`resolveEnvironment` / `selectBatchKnowledge` / `compileKnowledge`（`src/translation-knowledge/execution.ts`），翻译请求的载荷投影 `compiledKnowledgePayload`（`knowledge-planner.ts`）。工作台服务已注入 `readKnowledge`（`electron/main/subtitle-studio/index.ts:40-50`），修订服务尚未获得。
- 工作台提示条：`index.tsx` 的 `.studio-notice` 系列（删除撤销、导出完成等）。

## 方案与取舍

### 请求与载荷（T-STUDIO-01）

- `reviseCues` 请求增加可选 `knowledge: KnowledgeSelection`（沿用 `knowledgeSelectionSchema`）。只有 `revisesTarget(fields)`、有译文轨、选择含方案或资料集且源语言非空时，渲染进程才发送。
- `CueRevisionService` 构造参数增加 `readKnowledge?: () => Promise<LibrarySnapshot>`（index.ts 注入同一个 `readForExecution`）。`revise` 中：有 `knowledge` 时读快照，`resolveEnvironment(snapshot, selection, cues)`（cues 为本次全部条目，text=原文，sourceLanguage=选择源语言）；每块 `compileKnowledge(selectBatchKnowledge(env, chunkCueIds))`，按 `compiledKnowledgePayload` 同样的投影放入载荷 `translationKnowledge`（applicableItemIds 映射为块内 `c1…`），`translationRequirements` 为选择的说明。读取或解析抛错时记为无资料继续。
- 系统提示追加一句：有 translationKnowledge 时修订译文须遵循其中适用条目，必需条目为约束。

### 可沉淀译法（T-STUDIO-01）

- 当 `revisesTarget(fields)` 且有译文轨时，系统提示追加：可选返回 `"knowledge":[{"source","target","note"}]`（≤5），仅限修订确立的可复用约定（专有名词、称谓、反复术语、请求中规定的写法），`source` 须逐字取自条目原文，`target` 为对应译文写法；一次性措辞不要列出。
- `parseCueRevisionResponse` 读取 `knowledge` 数组：两段文本 trim 后 1..200 字、`cueTextProblem` 为空；结果新增 `hints`。
- 服务端校验：原文须字面（NFKC+大小写折叠的包含）出现在块内至少一条原文；译文须出现在该块修订后或当前译文中；关联字幕 = 块内原文含该原文、且修订后/当前译文含该译文的条目。跨块按（折叠原文, 折叠译文）去重合并关联字幕，最多 10 条。`CueRevisionResult.knowledgeHints?: { source; target; note?; cueIds }[]`。

### 对话框与提示条（T-STUDIO-02）

- `StudioCueRevision`：读取草稿 `selection`，满足条件时随请求发送；对话框参数区下方显示一行 `text-xs text-muted-foreground`「参考资料：方案名 / 资料集名（多个时“名1、名2 等 N 个”）」，名称从资料库快照取（读取失败不显示）。
- 预览有 `knowledgeHints` 时，在 AI 说明下方加一行同款弱文本：「应用后可将 N 条译法记入翻译资料」。
- 应用时只保留关联字幕中至少一条被勾选应用的提示，随 `onApply` 一并回传；`index.tsx` 在应用成功后读取资料库，过滤掉「同语言对、同原文、同译文、未归档」已存在的条目，剩余非空则设置 `knowledgeHint` 提示条状态（含文档 id、修订后的文档 revision、提示、语言对、建议资料集）。
- 提示条复用 `.studio-notice`：`BookOpen` 图标（`text-muted-foreground`）+ 文本「AI 修订中有 N 条译法可以记入翻译资料，以后翻译时保持一致。」+ `Button size="sm" variant="ghost"`「记入翻译资料」+ 关闭图标按钮。切换文档、撤销（文档 revision 变化且不等于记录值）或关闭时清除。
- 语言对：源语言取草稿选择源语言，其次上次翻译草稿；目标语言取译文轨语言并规范为 zh-Hans/zh-Hant。建议资料集：草稿选择中的第一个资料集，其次方案读取的第一个资料集。

### UI 设计基准

依据 `fusionkit-ui-design`：提示条与现有删除/导出提示同一视觉（同 `.studio-notice` 高度、图标尺寸、ghost 按钮），不新增颜色；修订对话框中的两行均为既有正文下方的弱文本，不新增卡片或分区。验收样本：中文长资料集名（截断由既有布局换行）、浅/深色、1280×860。对话框见 R-KNOWLEDGE-04 设计。

### 一致性检查（I3）

**契约** `src/subtitle-studio/consistency-contract.ts`：

- 请求 `checkConsistency { requestId, documents: [{ documentId, revision, trackId? }] (1..20), focus? (≤500), knowledge?: KnowledgeSelection, model, apiKey, maxOutputTokens }`；`cancelConsistency { requestId }`。上限常量：20 个文档、5000 条字幕、每请求 120 行、每块最多 30 个名称。
- 抽取提示词：输入 `{ focus?, targetLanguage?, lines: [{ id: "l1", source, target? }] }`，要求返回 `{"terms":[{"source","targets":[…],"sourceVariants":[…]}]}`：反复出现的专有名词/术语（人名、地名、组织、称谓、作品内术语），列出本块中出现的每种译法与疑似同一名称的其他原文写法（听写错误）；不列普通词汇。
- 纯函数 `parseConsistencyResponse`（宽松：跳过非法项）、`buildConsistencyGroups(lines, terms, knowledgeTerms)`：按 NFKC+小写折叠合并同一原文的候选；回扫全部行：原文含该原文（或任一原文变体）的行为出处，译文中最先命中的候选译法（长者优先）为该行写法；有 ≥2 种写法、或存在原文变体出处、或资料规定译法与出处写法不一致时成为一组。资料术语额外独立检查：原文命中而译文不含规定译法的行。推荐写法：资料规定译法 > 出处最多（并列取更长）。组按出处数降序，最多 50 组，每种写法最多保留 200 处出处。

**服务** `electron/main/subtitle-studio/consistency-service.ts`：复用 `CueRevisionService` 的运行模式（请求 id 注册、可取消、`sendModelRuntimeText` JSON 模式、用量累计、错误映射），读取各文档（`repository.read`），只取当前译文；资料按选择解析出已启用术语（不按块投影）。结果 `{ groups, checkedLines, documents: [{ documentId, revision, name, trackId? }], usage }`。IPC 渠道 `subtitle-studio:check-consistency` / `cancel-consistency`，按 `owner.documents` 校验文档归属，preload 与渠道白名单同步。

**界面** `StudioConsistencyCheck.tsx`（`ScrollableDialog`，与 AI 修订对话框同一结构与 CSS 变量）：

- 表单：范围说明（当前文档 N 条 / 所选 K 个文档共 N 条）、重点输入（单行）、模型选择、参考资料行（同修订）、「开始检查」/停止。
- 结果：摘要「发现 N 组写法不统一（检查 M 条）」；每组一张 `studio-consistency-group` 行块：勾选「统一此组」、原文（原文变体组显示各原文写法）、写法选择（`ToolRadioButtonGroup` 风格的小按钮：写法 + 出处数，推荐写法带「推荐」/「资料」标记；最后一项「自定义」展开输入）、「同时修正原文」（仅原文变体组）、「记入翻译资料」、折叠的出处列表（文档名 · #序号 · 差异预览）。
- 底部：「统一 N 组（修改 M 条字幕）」。统一后对话框显示回执：「已统一 N 组，修改 M 条字幕（K 个文档）」与「撤销本次统一」「完成」；有跳过的文档逐个说明；有勾选记入的组时回执中显示提示与「记入翻译资料」按钮（渲染审查后由自动弹出改为按钮，避免在检查窗口上叠加对话框）。
- 统一的编辑由纯函数 `consistency-apply.ts` 生成：每个文档一个 `revise` 操作（`editedText`），当前文档经 `applyCueEdit` 进入撤销历史，其他文档直接 `editCues` 并保存 `result.undo`；撤销按保存的逆操作以新版本执行。
- 入口：字幕预览工具栏 AI 修订按钮旁的「一致性检查」图标按钮（`ScanText`）；文档列表批量菜单与右键菜单「检查术语一致性」。

## 代码落点

- `src/subtitle-studio/cue-revision-contract.ts`、`electron/main/subtitle-studio/cue-revision-service.ts`、`electron/main/subtitle-studio/index.ts`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx`、`index.tsx`、`studio.css`（如需）
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`test/subtitle-studio/cue-revision.test.ts`、`test/subtitle-studio/cue-revision-knowledge-ui.test.ts`（新，Electron）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-STUDIO-01 | 请求 `knowledge`、服务注入 `readKnowledge`、块级资料投影、对话框参考资料行 |
| R-STUDIO-02 | 提示词扩展、解析与服务端校验去重、`knowledgeHints`、预览提示行 |
| R-STUDIO-03 | 应用后过滤已存在、提示条、打开批量记入对话框 |
| R-STUDIO-04 | 一致性契约与提示词、合并回数纯函数、主进程服务与 IPC、检查对话框结果区 |
| R-STUDIO-05 | `consistency-apply.ts` 生成编辑、当前文档撤销历史与回执撤销、记入资料 |

## 验证与风险

- 单元：载荷含/不含资料、只关联命中条目、提示校验与去重、只修订原文时不要求提示（mock sendText 捕获消息）。
- Electron：受控 chat-completions 服务返回修订与 knowledge，验证预览提示行、应用后提示条、打开对话框保存并在资料库可见、关闭与撤销后提示消失；截图审阅浅/深色。
- 风险：模型可能过度列出约定——以字面校验、上限和「已存在不提示」控制；真实模型效果需用户试用。
