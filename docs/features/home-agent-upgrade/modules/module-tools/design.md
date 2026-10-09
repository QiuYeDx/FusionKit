# HomeAgent 正式工具接入设计

## I4 设计：经典页面上下文与设置跟随
依据 R-TOOLS-04、R-TOOLS-05。

**设置跟随**（`src/agent/tool-page-settings.ts`）：各工具页设置读取器（字幕翻译 `useSubtitleTranslatorConfigStore.preferences`、转换/提取 store 偏好、名称翻译 `nameTranslatorConfig`、工作台 `translationDraftMemory.last()` 与转写控制器配置）及 `resolveSetting(name, user, page, fallback, applied)`。相关 schema 去掉配置字段的 `.default()`，改为可选并在说明中写明“省略即采用工具页当前设置”；执行器按“用户 → 工具页 → 内置默认”解析，结果附 `appliedSettings: { 字段: { value, source } }`。冲突策略：用户未指定时取页面值（含覆盖）并标 tool_page；模型指定覆盖仍走原“本轮用户明确要求”校验。输出位置：字幕翻译页的目录授权不可复用，未指定时为原文件旁并在结果说明；转换/提取页选择了自定义输出且已有目录时沿用该目录。名称翻译在 `createAgentNamePlan` 增加可选 `format`（nameMode/bilingualOrder/bilingualStyle/customTemplate），未指定 `nameFormat` 时由页面配置生成模板与计划设置。

**经典页面上下文**（`src/agent/classic-page-contexts.ts` + `src/pages/AgentDock/ClassicPageContexts.tsx`）：由 App 内与 AgentDock 并列的组件按当前路由注册，所有状态来自全局 store/服务，不改经典页面源文件。每页：快照（设置、各状态任务数与前 10 个任务）、两条建议、页面说明；字幕翻译/转换/提取/名称翻译提供 `*_update_settings`（严格 schema、只写枚举字段、返回前后值）。本地转写快照读取 `useLocalSubtitleTranscriberStore` 偏好与草稿、环境服务与运行服务状态。


## I3 字幕工作台页面工具设计
依据 R-TOOLS-03。工作台页面（`SubtitleStudio/index.tsx`）在有 `subtitleStudio` 桥时注册上下文，构造逻辑放在 `SubtitleStudio/agent-context.ts`，便于单测。

**快照**由当前 `page`、`track`、预览选区（`StudioCueTable` 新增 `onSelectionChange` 回报编号，页面持有）与编辑受阻状态投影；编号统一为文档内 1 起序号（`page.offset + index + 1`），与预览列表一致。

**主进程 `findCues`**（只读，`cue-revision-contract.ts` 新增请求 schema，`CueRevisionService.find`）：`{ documentId, revision, trackId?, terms?: string[≤20] | lines?: number[≤200], limit≤50 }` → `{ revision, total, cueIds(≤5000), matches: [{ cueId, index, source, target? }] }`。使用与定位相同的 `mentionsTerm`；校验 owner 文档授权与 revision；超过 5000 返回 `limit_exceeded`。IPC 白名单与 preload 同步，`electron/main/subtitle-studio/index.ts` 的审计按 FK-PIT-0186 刷新。

**修订预览预设**：`CueRevisionRequestState` 增加 `preset?: { instructions, scope, fields?, search?: { terms } | { lines } }` 与 `onSettled?(outcome)`。预设打开时填入表单并自动生成；`search` 存在时以 `findCues` 结果替代 locate 的模型规划（`plan` 记为 terms/lines，`usage` 为 0）。`outcome` 为 `{ status: 'ready', checked, proposals, notes, plan? } | { status: 'needs_confirmation', count } | { status: 'failed', error } | { status: 'cancelled' }`，每次预设只回调一次；用户之后应用与否由预览自身处理。

**页面工具**（`studio_*`，均先 `check()` 会话与当前文档 id 未变）：
- `studio_read_cues({ from, count≤50 })`：按需读取所在分页（`readDocumentPage`，每页 100 条），文本各截 300 字。
- `studio_find_cues({ terms? | lines?, limit≤50 })`：调用 `findCues`。
- `studio_prepare_revision({ instructions, scope, fields?, terms? | lines? })`：校验无文档/受阻/空选区/预览已打开，再打开预设预览并等待 `onSettled`；`abortSignal` 触发时返回 `agent_cancelled`，预览保留。返回结果附 `nextAction: "The user reviews and applies the revisions in the Subtitle Studio preview. Nothing has been written."`。

页面说明（instructions）告诉模型：用编号指代字幕；修改字幕用 `studio_prepare_revision`，不要声称已经修改；若用户提到具体错误写法，传 `terms`（含可能的近似误写）以省去一次规划；翻译、导出等仍用固定工具。

验证：agent-context 快照/工具单测（mock subtitleStudio 与预览桥）；`findCues` 主进程单测；真实 Electron 链路由 T-WORKSPACE-06 覆盖。


## I2 批量回执和准确范围设计
依据 ../../records/review-i2-plan.md 与 R-TOOLS-02。`PreparedActionReceipt` 使用 phase(preparation/submission)、total、successCount、failureCount 和最多50条 items；条目为 id/name/status(ready/queued/failed)/error?/taskId?。准备结果放 data.receipt 与 action.preparationReceipt，提交结果放 result.receipt；失败 data 也写入 action.result。失败不自动重试，回执不承载执行权限。

知识分页保留既有字段，增加 pagination(offset/limit/entries/collections/recipes)，三类均返回 total/hasMore/nextOffset。转写 controller.enqueue 接受可选 expectedDraftIds，在 expireDrafts 后、构造请求前要求全部且仅目标草稿 ready，否则零入队；不传参数保留工作台行为。现代工具与动作管理由 tools 单写，UI 只消费此契约。

提交的 transport reject / submission_unknown 不能证明零入队。此类保留准备回执并明确“提交结果未知”，不伪造 submission 成败统计，不自动重试；仅确定返回值或提交前拒绝具有逐项提交结果。这是既有未知副作用边界的落实。

## 现状与约束

现有九个 Agent 工具只覆盖经典字幕翻译、转换、提取及名称翻译/恢复。正式范围由工具页栏目定义，不由 TOOL_META.status 推断。工作台和资料库已有受保护 preload API。经典转写仅从真实 File 捕获授权；工作台有固定 selectTranscriptionMedia 选择器，两类 token 不可互换。

## 方案与取舍

### 能力目录与工具适配

`capability-catalog.ts` 导出 `AGENT_CAPABILITIES`，每项包含 `toolKey, titleKey, descriptionKey, route, operations`；key 为六项正式 ToolKey。`modern-tools.ts` 导出 `modernAgentTools`，由集成负责人在 tools.ts 组合；不改共享 registry、orchestrator 或 UI。

| 能力 | 复用接口 | 边界 |
| --- | --- | --- |
| 正式工具发现 | 静态目录 | 六项正式工具、真实路由和允许操作 |
| 工作台文档查询 | subtitleStudio.listDocuments | 有界分页，只返回摘要 |
| 工作台任务查询 | listTranslationTasks、listTranscriptionTasks | 状态、进度与任务 ID，有界结果 |
| 原生字幕导入 | importSubtitles({encoding}) | 返回逐项成功/失败或取消，不启动翻译 |
| 工作台翻译准备/执行 | planTranslationBatch → createTranslationBatch | 固定文档 revision，模型配置和凭据内取；提交后 overview.trackStarted(taskIds) |
| 工作台转写 | getStudioTranscriptionController 的 refresh/selectMedia/setConfig/enqueue | 复用前置检查、能力撤销和未知提交防重；禁止旧草稿混入 |
| 经典转写状态 | localSubtitleApi.probeRuntime/listManagedResources/getSessionSnapshot | 有界只读环境与任务 |
| 经典转写交接 | useLocalSubtitleTranscriberStore 的有限 preferences/draft setter | 不动文件能力；返回真实入口供页面选文件 |
| 资料查询 | translationKnowledge.read 后本地过滤投影 | 计数、审核状态、有界摘要，不送整库给模型 |

参数复用已有配置 Schema。API key、endpoint、文件 token 只从可信本地状态进入执行闭包，不进入模型参数或结果。错误结构化，任意异常原文不直接透传。资料库不开放 saveRecord/reviewEntries/maintenance；导入冲突和采纳继续走资料页面。

各现代工具的 execute 接收 SDK options.abortSignal，进入时捕获 sessionId；每次原生选择、配置变更、动作注册、plan/create/enqueue 等副作用之前检查未取消且会话未变化。已有固定 IPC 不支持 abort 时等待返回，随后只清理本次能力，不继续下一个副作用；已经提交的任务保留实际结果，不以取消聊天伪称后端取消。

### 准备动作契约

`prepared-actions.ts` 导出非持久化 Zustand `usePreparedActionsStore`：`{actions, confirmAction(id), dismissAction(id)}`，以及内部调用的注册函数。action 包含 `id, sessionId, title, summary, toolKey, status` 和可选 `error, result`，状态为 ready/running/completed/failed/dismissed。执行/清理回调存模块私有 Map，展示状态不含凭据、原生路径或能力。

摘要另提供可选 `summaryKey/summaryValues`，分别使用 `home:prepared_translation_summary`（count,total,language,tokens,files）和 `home:prepared_transcription_summary`（count,model,language,files）。files 来自最多五个实际 displayName，截断后供 UI 动态本地化；summary 保留安全文字后备。completed 表示准备动作已提交，后台任务仍以返回的 queued/running 等真实状态显示。

注册捕获当前 session.id。仅 auto_execute 调用确认，其余模式保留 ready，绝不提前调用会启动任务的 create/enqueue。确认在第一个 await 前校验 session 与 ready 状态、同步改 running 并取走回调；重复点击不重复提交。成功 completed，明确失败或异常 failed，失败不留重试回调。会话变化 dismiss 旧 ready 并清理能力，running 的任务保留真实结果，不伪称取消。

取消 ready 先认领并移除回调再清理。转写仅移除动作拥有的草稿，撤销失败由既有 controller 重试。保留有界终态展示项；丢弃 ready 必须同时清理回调/能力。UI 按 sessionId 过滤展示并调用公开方法，不维护第二份执行状态。

实际普通批量翻译计划的生命周期来源是 `electron/main/subtitle-studio/batch-service.ts`：无公开 cancel/release API，只保留有界 metadata，不持有输入文件能力或 API key；同 owner 新建同类计划会替换旧计划，十五分钟后不可执行，owner 释放时删除。Agent 在调用新计划之前 dismiss 本模块旧 ready 翻译动作，确保新计划成功但回执被取消/丢失时，旧卡片不会继续宣称可执行。停止后不注册新的执行闭包，不为清 metadata 新增 main 权限。

### 前置条件与交接

转写准备开始时发现旧草稿则拒绝，避免覆盖。准备捕获准确草稿 ID 集和配置；确认时若页面新增草稿、修改配置或能力失效则拒绝。取消选择不建空动作。经典转写仅更新有限参数，不碰 draftInputFiles/draftOutputDirectory。链接使用既有路由，不生成尚未支持的 tab/document query。

本模块没有布局修改；动作摘要与确认/取消 UI 由 workspace 模块负责，渲染证据由 workspace/integration 记录。

## 代码落点

- `src/agent/capability-catalog.ts`、`src/agent/capability-catalog.test.ts`
- `src/agent/modern-tools.ts`、`src/agent/modern-tools.test.ts`
- `src/agent/prepared-actions.ts`、`src/agent/prepared-actions.test.ts`

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-TOOLS-04 | 路由驱动的经典页面上下文注册组件、store 投影快照、页面设置更新工具 |
| R-TOOLS-05 | 可选参数 + 工具页设置读取器、用户→工具页→默认解析、appliedSettings 回执、覆盖与输出位置例外 |
| R-TOOLS-03 | 工作台快照投影、主进程只读 findCues、修订预览预设与一次性 onSettled、只作用于当前文档的 studio_* 页面工具、任何模式不应用修订 |
| R-TOOLS-02 | preparation/submission逐项receipt、失败data保留、expectedDraftIds admission校验、三类独立分页 |
| R-TOOLS-01 | 正式目录、固定 API 适配、会话绑定动作、controller 复用、有界结果投影 |

## 验证与风险

单测覆盖正式范围、严格参数、picker 取消/失败、敏感字段不返回、分页/摘要上限、缺 API 与空结果区别；延迟 Promise 验证重复确认只执行一次、跨会话失效、dismiss 清理和失败后不可重提。转写覆盖旧草稿、配置改变、未知提交不重试。mock 只证明适配层；集成负责人在隔离 Electron 验证原生选择器、准备动作显示与取消、无配置错误。未经运行不声称真实模型翻译/本地推理通过，不调用付费模型、不下载模型、不修改真实资料。
