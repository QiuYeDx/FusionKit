# 外部 Agent 接入：工具面 设计

I1 部分见「宿主」至「工具实现」；I2 部分见「I2：信任与确认」及其后各节。

## 现状与约束

- 内置 Agent 工具（`src/agent/tools.ts`、`modern-tools.ts`、`knowledge-tools.ts` 等）通过 `run()` → `sessionOfSignal()` 绑定 Agent 会话，授权依据是「用户亲手输入的消息」（`user-intent-authority.ts` 的 `userMentionedPath`），写入经 `registerPreparedAction` 生成会话内确认卡片，并受全局 `executionMode` 支配。
- 这些语义不适用于外部调用：外部调用没有用户亲手输入的消息，也不属于某个 Agent 会话。
- 字幕工作台渲染端 API `window.subtitleStudio`（`src/subtitle-studio/ipc-contract.ts` 的 `SubtitleStudioApi`）已覆盖列表、分页读取、按路径导入、编辑、导出、任务列表；主进程变更会通过 `subscribe` 事件推给已打开的工作台页面，界面自动刷新。

## 方案与取舍

### 取舍：独立实现，复用底层 API 与纯函数（A-01）

外部工具在 `src/agent/external/` 中独立实现，直接调用 `window.subtitleStudio` 等渲染端 API，并复用可共享的纯函数（如 `documentSummary`，从 `modern-tools.ts` 导出），不调用内置 Agent 的 `execute*`/`run()`。

理由：内置工具的授权（用户输入过的路径）、会话绑定与确认卡片是 HomeAgent 的产品语义，硬套到外部调用要么放松内置 Agent 的安全约束，要么让外部调用处处失败。独立实现让两边各自的授权模型都清楚，且不改变内置 Agent 的行为。

### 工具目录 `src/agent/external/catalog.ts`

`EXTERNAL_TOOLS` 只依赖 zod 与纯契约模块。I1 两个工具：

| 工具 | access | 输入 |
| --- | --- | --- |
| `get_fusionkit_status` | read | `{}` |
| `list_studio_documents` | read | `query`（≤200）、`format`（all/srt/lrc/vtt/ass/ssa/sbv/media）、`status`（all/untranslated/translated/active/attention）、`offset`、`limit`（1–50，默认 20） |

说明文字面向外部模型（英文），讲清返回内容与下一步用法。

### 宿主 `src/agent/external/host.ts`

- `installExternalAgentHost(registry = EXTERNAL_TOOL_IMPLEMENTATIONS)`：订阅 `window.externalAgent.onCall` / `onCancel` / `onStatus`，调用 `ready()`；返回卸载函数。由 `src/pages/AgentDock/ExternalAgentHost.tsx`（无界面组件，挂在 `App.tsx`）在挂载时安装。
- 每个调用：`AbortController` 登记到 `callId`；目录无此工具 → `unknown_tool`；`inputSchema.safeParse` 失败 → `invalid_arguments`（附问题）；执行实现 `(input, ctx) => Promise<ToolOutcome>`，`ctx = { sessionId, client, signal }`。
- 异常 → `tool_failed`，`detail.reason` 为脱敏（逐个替换已配置的 Agent/任务模型 API Key 为 `[redacted]`）并截断到 600 字符的信息；`signal.aborted` 或 AbortError → `cancelled`；`ToolError(code, detail?)` → 对应错误码。
- 结束后 `respond({ callId, result })`，并把 `{ tool, ok, error?, at }` 写入活动存储。

### 活动存储 `src/agent/external/store.ts`

`useExternalAgentStore`（zustand，无持久化）：`status: ExternalAgentStatus | null`、`activity: Record<sessionId, ActivityEntry[]>`（每会话最多 50 条，会话从状态中消失时删除其记录）。I3 的连接指示读取它。

### 工具实现 `src/agent/external/tools/`

- `status.ts`：版本 `import.meta.env.VITE_APP_VERSION`；界面语言 `i18n.resolvedLanguage`；当前路由 `usePageContextStore.getState().pathname`；信任档位取自状态；模型：`useModelStore.getState().getAgentProfile()/getTaskProfile()` → `{ configured: boolean, name?: profile.name, model?: profile.modelKey }`（不含 apiKey/baseUrl）；工作台：`listDocuments({ offset: 0, pageSize: 1 })` 的 total 与 `unavailableDocuments`，`listTranslationTasks({ offset: 0, pageSize: 1 })` 的 counts，`listTranscriptionTasks({})` 中进行中的数量。工作台 API 不可用时该部分为 `{ available: false }`，不让整个工具失败。
- `studio-documents.ts`：同内置 `list_studio_documents` 的查询与 `documentSummary` 映射，返回 `{ total, offset, nextOffset, items, unavailableCount }`。

## 代码落点

- `src/agent/external/{catalog,host,store,errors}.ts`、`src/agent/external/tools/{index,studio,status,studio-documents}.ts`（新）
- `src/agent/modern-tools.ts`（导出 `documentSummary`，不改行为）
- `src/pages/AgentDock/ExternalAgentHost.tsx`（新）、`src/App.tsx`（挂载）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-TOOLS-01 | host 安装与就绪、分派、二次校验、错误归一与脱敏、取消、活动存储 |
| R-TOOLS-02 | catalog 两个工具、status.ts、studio-documents.ts |
| R-TOOLS-03 | 分类与放行组、主进程只读判定、approval.ts、confirmations 延后执行、确认对话框、requestAttention |
| R-TOOLS-04 | tools/document.ts、withDocumentAccess |
| R-TOOLS-05 | tools/importing.ts |
| R-TOOLS-06 | Studio 领域 agent 字段、createAgentTranslationTrack、agent 编辑操作、执行记录入口、tools/translation.ts |
| R-TOOLS-07 | tools/export.ts（planExport → exportDocument） |
| R-TOOLS-08 | tools/transcription.ts（转写控制器） |
| R-TOOLS-09 | knowledge-tools 纯函数抽取、tools/knowledge.ts、资料变更确认 |
| R-TOOLS-10 | tools/tasks.ts、tools/navigation.ts |

## 验证与风险

- 单元（vitest + 假 `window.externalAgent` / `window.subtitleStudio`）：分派、未知工具、参数错误、异常脱敏截断、取消、活动上限；status 不含 Key/地址；列表分页映射。
- Electron 端到端（与 module-bridge 共用 `test/external-agent.electron.test.ts`）：导入真实字幕夹具后，外部客户端 `list_studio_documents` 的结果与工作台一致；`get_fusionkit_status` 序列化结果中不出现预置的合成 API Key 与接口地址。
- 风险：工作台页面未打开时 `window.subtitleStudio` 仍可用（preload 全局注册），但文档访问受 `owner.documents` 约束——列表只返回本窗口可见的文档，以端到端实测为准。


## I2：信任与确认

### 分类与放行组

`catalog.ts` 每个工具声明 `access`（read / write / destructive）、可选 `confirm: "always"`（翻译资料变更）与写入类的 `group`（放行组）：

| 放行组 | 工具 | 对话框中的类名 |
| --- | --- | --- |
| `studio_import` | import_studio_subtitles | 导入字幕 |
| `studio_translation` | create_studio_translation_track、write_studio_translations | 编辑字幕译文 |
| `studio_export` | export_studio_document（indexed） | 导出字幕 |
| `studio_transcription` | start_studio_transcription | 本地转写 |

export 的 overwrite 在调用时升级为 destructive（工具实现按参数判定，`describeExternalTools` 把该工具标为 destructiveHint=false 但说明中写明 overwrite 需确认；MCP 标注只能静态给出）。

### 判定顺序

1. 主进程（`electron/main/external-agent/index.ts` 的 callTool 包装）：trust=read_only 且 access≠read → `read_only`（AC-TOOLS-03-1）。
2. 渲染进程 `approval.ts` 的 `approve(ctx, request)`：read → 放行；只读档（主进程漏判的兜底）→ `read_only`；`confirm: "always"` 或 destructive → 必问；write：auto → 放行，confirm_writes → 有本连接放行组记录则放行，否则问。

### 确认与延后执行

`useExternalConfirmationsStore`（zustand，无持久化）：`requests: ConfirmationRequest[]`（id、sessionId、client、group?、kind: write/always、titleKey、values、items（≤8 条展示行）、warningKey?、status: pending/running/completed/failed/declined/expired、createdAt、result?）、`grants: Record<sessionId, group[]>`。

工具实现把变更封装为 `confirmed(ctx, request, execute)`：
- 无需确认 → 直接 `execute()`。
- 需要确认 → 入队并等待决定，最多 45 秒（`CONFIRMATION_WAIT_MS`）：允许 → `execute()` 并返回其结果；拒绝 → `declined_by_user`；超时 → `confirmation_pending { confirmationId }`，请求保留，用户之后允许时由宿主以独立的 AbortController 执行并把结果写回请求。
- `get_confirmation_result { confirmationId }`（read）：等待最多 45 秒至终态，返回结果 / `declined_by_user` / `confirmation_expired` / 仍为 `confirmation_pending`。确认 ID 只对发起它的会话有效。
- 未决请求 10 分钟过期；会话从状态中消失时其未决请求作废；终态请求保留最近 20 条供查询。

### 确认对话框（UI 设计基准）

- 用户与流程：用户在终端或编辑器里和外部 Agent 对话，FusionKit 窗口可能在任意页面、可能未聚焦。请求到达 → 任务栏闪烁（`externalAgent.requestAttention()` → 主进程 `win.flashFrame(true)`，窗口聚焦时不闪；不调用 focus）→ 用户切回 FusionKit 看到对话框 → 允许/拒绝。失败恢复：拒绝即结束；关闭对话框（Esc/×）等同拒绝。
- 视觉参照：字幕工作台删除确认（`src/pages/Tools/Subtitle/SubtitleStudio/index.tsx` 的 `studio-delete-*` 对话框）：`ScrollableDialog animateSize`、Header 标题 + 描述、Content 列表行、Footer 右对齐按钮、默认焦点在取消；`src/components/qiuye-ui/scrollable-dialog.tsx` 默认宽度 `sm:max-w-md`。
- 布局：Header：标题「{客户端} 请求{类名}」，右侧在有排队时显示「还有 N 个请求」（muted 小字，不做徽章）；描述：一句由 FusionKit 生成的操作摘要（对象与数量）。Content：对象列表（文档名或路径，路径 `break-all` 自然换行，最多 8 行，多余显示「另有 N 项」）；destructive 时在列表上方用 `Alert variant="destructive"` 写明「会覆盖同名文件」；翻译资料变更列出每条（类别 · 原文 → 译文）。Footer：左侧（仅写入类、非 always）`Checkbox`「本次连接内允许此类操作」；右侧 `Button variant="outline"`「拒绝」（默认焦点）+ `Button`「允许」（destructive 时 `variant="destructive"`）。窄窗（<640px）Footer 两行：复选框在上，按钮行在下右对齐。
- 组件：`ScrollableDialog`/`ScrollableDialogHeader`/`ScrollableDialogContent`/`ScrollableDialogFooter`、`DialogTitle`/`DialogDescription`、`Alert`、`Checkbox`+`Label`、`Button`。文案走 `setting:external_agent.confirm.*`（zh / zh-Hant / en / ja）。
- 状态：pending（可操作）；running（允许后按钮禁用、允许按钮显示加载图标，完成后对话框切到下一个或关闭）；队列为空时对话框关闭。
- 验收样本：短名称 `Episode 01.srt`；长路径（Windows 深层目录 + 长文件名 120 字符）；8 项以上列表；destructive 覆盖；资料变更 3 条术语；排队 3 个请求。视口 1280×860 与 900×700，浅色与深色主题，中文与英文。

## I2：Studio 新增写入能力（主进程）

- 领域：`src/subtitle-studio/domain.ts` 的译文轨道增加可选 `agent: { name }`（1–100 字符），表示由外部 Agent 所建；旧文档无此字段，读取兼容。
- IPC：`requestSchemas.createAgentTranslationTrack = { documentId, revision, language (1–35), name?: translationTrackNameSchema, agent: { name } }`，通道 `subtitle-studio:create-agent-translation-track`，加入公共通道列表与 preload API；主进程在通用文档访问校验之后由 `TranslationTrackService.createAgentTrack` 处理：轨道满 100 → `limit_exceeded`；新轨道 `{ id, language, name: name ?? agent.name, revision: 1, origin: "ai", agent, entries: {} }`；返回 `{ summary, trackId }`。
- 编辑操作：`cue-edit-contract.ts` 新增 `{ kind: "agent", trackId, targets: textsSchema }`：只允许 `track.agent` 存在的轨道（否则 `invalid_input`，由工具层先行判定给出 `track_not_writable`）；每句写 `{ sourceRevision, sourceHash, text, origin: "ai", reviewStatus: "unreviewed" }`；撤销为 `entries` 操作；轨道 revision 递增并照常退役可续翻任务。
- 执行记录入口：`hasExecutionRecordEntry` 对 `track.agent` 且无 `executionRef` 的轨道返回 false。
- 撤销：外部写入成功后由工具把返回的逆操作记入会话撤销历史 `cueHistory`（标签 `agent`）；`CueHistory.subscribe` 通知已打开的工作台页面刷新撤销按钮（写入可能在页面重载之后才记入）。
- 确认对话框条目为 `{ text, detail?, tag? }`：路径显示末段名并以完整路径为副文本；资料条目带种类标签、资料集为副文本（渲染审查后的调整，见 records/i2/ui-review.md）。

## I2：工具实现要点

- 文档访问 `withDocumentAccess(documentId, run)`：先执行；遇 `access_denied` 时按 100 条一页遍历 `listDocuments` 直到找到该文档（授予本窗口访问）再重试；找不到 → `document_not_found`。
- 文本：`normalizeCueText` 后用 `cueTextProblem` 校验，转为 `{ plain, spans: [{ text, marks: [] }] }`。
- 导出选项：与工作台导出对话框默认一致（utf-8、无 BOM、LF、incomplete=source-fallback、order=source-first、格式 `defaultExportFormat`），非 LRC 格式缺结束时间时 `missingEnd: next-start 2000ms`；先 `planExport`，阻断 → `export_blocked`，需确认的有损项作为 acceptedLosses 一并提交。
- 转写：复用 `getStudioTranscriptionController()` 的 `refresh / selectMediaFromPaths / enqueue`，本批关闭自动翻译、`autoExport: null`，结束（成功或失败）后恢复原自动翻译设置并清理本次草稿。
- 翻译资料：从 `knowledge-tools.ts` 抽出并导出纯函数 `searchKnowledgeLibrary`、`knowledgeCatalog`、`saveKnowledgeProposal`、`briefProposal`，内置 Agent 改为调用同一函数（行为不变）。
- 页面：`open_fusionkit_page` 复用 `navigation-tools.ts` 的 `executeOpenAppPage`（固定页面表）。
- 说明文本 `instructions.ts` 补充：写入可能需要用户在 FusionKit 窗口确认、`confirmation_pending` 的处理、翻译工作流（读→建轨→分批写→导出）。

## I2 代码落点

- `src/agent/external/{catalog,instructions,approval,confirmations}.ts`、`src/agent/external/tools/{document,translation,importing,export,transcription,knowledge,navigation,tasks}.ts`
- `src/pages/AgentDock/ExternalAgentConfirmDialog.tsx`（挂在 `ExternalAgentHost` 内）
- `src/subtitle-studio/{domain,cue-edit-contract,ipc-contract}.ts`、`electron/main/subtitle-studio/{index,cue-edit-service,translation-track-service}.ts`、`electron/preload/{subtitle-studio-api,subtitle-studio-channel-policy}.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/StudioExecutionRecord.tsx`
- `src/agent/knowledge-tools.ts`（抽函数）、`electron/main/external-agent/index.ts`（只读判定、requestAttention）、`src/agent/external/contract.ts`
- `src/locales/{zh,zh-Hant,en,ja}/setting.json`

## I2 验证与风险

- 单元：approval 判定表（三档 × 三类 × 放行组）；confirmations 等待/超时/延后执行/过期/会话作废；各工具的参数映射与错误码；Studio `agent` 编辑操作与建轨（主进程服务测试）。
- Electron 端到端（`test/external-agent-tools.electron.test.ts`）：不配置任何模型，外部客户端完成 导入→读取→建轨→分批写→导出双语，确认对话框真实点击（允许 + 本次连接放行、拒绝、只读拒绝、overwrite 必问）；工作台界面可见轨道与 AI 未审校标记、撤销一步撤回；资料变更确认后入库。
- 渲染审查：确认对话框按上述样本截图审阅（`test-results/external-agent/*.png`），修复后复验。
- 风险：Studio 领域 schema 变更须确认持久化读写与导出不受影响（运行工作台相关测试）；`subtitle-studio/index.ts` 为审计文件，改后重登记。
