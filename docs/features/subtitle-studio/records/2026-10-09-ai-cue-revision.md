# 字幕 AI 修订

用自然语言说明要改什么，由 AI 给出修订；用户预览差异、逐条取舍，确认后才写入。模型与 API 和 AI 翻译相同。两种范围：

- **所选字幕**：选中一条或多条（“第 2 句应该是……”“这几句里‘深度求锁’应为‘深度求索’”）。
- **整个文档**：不必逐行选中（“文中的‘法尔童’都应为‘法厄同’”“第 12 句应该是……”“把所有句末的句号去掉”）。AI 先判断怎样找到相关的行，应用在本地查找，再只修订找到的行。

## 交互

| 项 | 规则 |
| --- | --- |
| 入口 | 右键菜单与行内“⋯”菜单的“AI 修订…”（作用于当前选区；右键未选行时只作用于该行，与翻译、删除共用 `actionTargets` 规则）；操作栏的 ✦ 按钮常驻，有选区时修订所选，无选区时为“AI 修订整个文档…” |
| 可用性 | 与编辑一致：翻译进行中或页面忙时禁用 |
| 弹窗 | 范围（所选 N 条 / 整个文档）、修改要求输入框（自动聚焦，Ctrl+Enter 生成，占位示例随范围变化）、修订字段（原文 / 译文 / 原文和译文，仅有译文轨时显示）、模型选择 |
| 默认值 | 范围：有选区为“所选”，否则“整个文档”。字段：有当前译文时默认“原文和译文”，否则“原文”；会话内记住上次选择。模型：上次修订所选 → 本文档翻译草稿 → 任务模型分配 → 第一个配置 |
| 进度 | “正在分析修改要求并查找相关字幕…” → “正在检查 n / N 条字幕…”（超过 100 条时附进度条）；生成中“取消”变为“停止”，中止当前请求并保留表单 |
| 大范围确认 | 整个文档范围找到的行超过 200 条（通常是“逐条检查”）时，先显示定位结果与“约 K 次模型请求”，点“继续检查”才开始修订；修改要求、范围或字段改动后该确认失效 |
| 预览 | 整个文档范围先显示定位方式（查找的写法标签与命中数 / 定位到的句号 / 逐条检查全部）；每条一行：文档内编号、原文差异（删除红色删除线、新增绿色底）、译文差异或“译文沿用”/“译文将标为原文已变更”；复选框逐条取舍、全选/全不选；AI 说明（最多 3 句去重）；底部显示本次 tokens（含定位） |
| 应用 | “应用 N 条修订”作为**一次**编辑写入，不在当前页的行也一起写入、一起撤销；撤销/重做标签为“AI 修订 N 条字幕”；一次最多 1000 条（`CUE_EDIT_LIMIT`），超出时提示分次应用 |

差异按词（拉丁文字、数字）和单字（中日韩、标点）比较；两段文本几乎没有共同内容时（如整句重写）直接显示“旧文 → 新文”，避免碎片化高亮。

## 数据流

所有步骤都是独立、按调用方授权、可取消、**不写入文档**的操作，渲染进程负责串联与展示进度：

1. **定位**（仅整个文档范围）`locateCueRevision`：主进程把修改要求、可修改字段、行数和文档开头约 20 行样本发给模型，模型返回检索计划（见下）；应用在全文的原文与译文中本地查找，返回 `{ revision, plan, cueIds, total, usage }`。查找每 1000 行让出一次事件循环；需检查的行超过 5000 条时拒绝（`limit_exceeded`，提示写出更具体的写法或先选择范围）。
2. **修订** `reviseCues`：每次最多 100 条，渲染进程按文档顺序分次调用；主进程再按每批 40 条、最多 3 批并发请求模型。返回的每条提议带文档位置 `index` 与生成时的 `current` 原文/当前译文，因此预览与应用不依赖当前显示的分页。
3. **应用**：渲染进程用提议中的 `current` 文本构造 `editCues` 的 `revise` 操作提交；若文档版本已不同于生成时，提示重新生成，不覆盖期间的改动。

`maxOutputTokens` 取该文档翻译草稿的输出上限，否则按模型推断并限制在 8192 内。请求可通过 `cancelCueRevision` 中止，只能中止自己的请求；窗口导航、销毁或应用退出时一并中止，文档在请求期间被删除也会中止。

## 模型协议

**检索计划**（`buildCueLocateMessages` / `parseCueLocateResponse`）：

- `{"strategy":"terms","terms":[...]}`：请求涉及具体词、人名、术语时，列出请求提到的错误写法，以及同一个词可能的其他误写和语音识别错误（同音、近音、拆分/合并、大小写与空格变体），最多 20 个；只说了正确写法时，列出识别器可能产生的写法；正确写法所在的行也可能需要修改（例如只是译文错了）时一并列出。
- `{"strategy":"lines","lines":[12,40]}`：请求点名句号（从 1 起，与预览列表编号一致），超出范围的号码被丢弃。
- `{"strategy":"all"}`：标点、语法、风格、语气、每一行，或无法猜到错误写法时逐条检查。
- 计划为空或无效时回退为 `all`；无法识别的 `strategy` 或非 JSON → `translation_protocol_invalid`。

**本地查找**（`mentionsTerm`）：NFKC 与大小写折叠后包含即命中；中日韩词 ≥3 字、其他 ≥5 字时允许 1 个字符的差异（中日韩 ≥6 字、其他 ≥9 字允许 2 个），用于捕捉“法尔童/法而童”这类误识别；更短的词只做精确匹配以免误命中。先做字符集合预筛，再做近似子串编辑距离。误命中由修订步骤的模型判断，不会被改动。

**修订**（`buildCueRevisionMessages` / `parseCueRevisionResponse`）：用户消息为 JSON：`request`、`editableFields`、`targetLanguage?`、`items[{ id, source, target?, before?, after? }]`。`before`/`after` 是相邻行（原文与当前译文），只在相邻行本身不在同一批时附带，因此连续选区与全文零散命中都有上下文。系统提示要求：条目可能来自搜索，只在要求确实适用时修改；保持每条仍是一条时间固定的字幕；只返回改动的条目和字段；修改原文且可改译文时一并返回译文（仍正确则原样返回）；`note` 用请求的语言写一句说明；不得使用 `<` `>`；字幕文本只作数据。只向模型提供**当前**译文，过期译文不作为依据。

解析宽松处理单条问题、严格处理整体格式：

- 非 JSON 或缺少 `items` 数组 → `translation_protocol_invalid`；可接受 Markdown 代码块包裹。
- 未知或重复的 id、不允许修改的字段 → 忽略；与当前文本相同 → 视为未修改。
- 文本经 `normalizeCueText` 规整后若含 `< >`、控制字符或超长 → 丢弃该字段并计入 `rejected`，预览中提示。
- 修改了原文而模型未返回译文、且该条有当前译文并允许改译文 → 视为“译文沿用”（`keptTarget`）。
- `finish_reason=length` → `translation_output_limit`。

## `revise` 编辑操作

```ts
{ kind: 'revise', sources: Record<cueId, SubtitleText>, trackId?, targets?: Record<cueId, SubtitleText>, entries?: Record<cueId, TranslationEntry | null> }
```

- 先写原文（与单条原文编辑同一逻辑：`sourceRevision` 递增，为该文本翻译过的条目重新变为当前）。
- 再写 `targets`：文本与现有译文完全相同时只把它确认为新原文的当前译文，保留原来源和复核状态；否则写为 `origin: 'ai'`、`reviewStatus: 'reviewed'`（用户已在预览中确认）。
- `entries` 用于撤销：恢复精确条目；若条目的 `sourceHash` 与恢复后的原文一致，其 `sourceRevision` 对齐为当前。
- 逆操作同为 `revise`（旧原文 + 改动前的条目），因此撤销与重做都是普通操作。只修订原文时，其他译文按既有规则标为“原文已变更”，撤销后恢复有效。
- 修改原文会停止所有可恢复的暂停任务；只改译文则只停止该译文轨上的任务（与既有编辑一致）。

## 为何不是开放式 Agent 循环

全文通常放不进模型上下文，Agent 也只能“检索候选 → 分批检查 → 汇总确认”，与本流程相同；而用户配置的 OpenAI 兼容模型对工具调用支持参差，JSON 模式更普遍可靠。固定流程还能给出可预期的请求量（大范围先确认）和唯一的预览确认点。三个步骤按工具形态设计（定位、修订、以 `revise` 应用）。同日已接入全局悬浮 Agent：工作台页面向 Agent 提供 `studio_read_cues`、`studio_find_cues`（主进程只读 `findCues`，不调用模型）与 `studio_prepare_revision`（打开预填并自动生成的修订预览，Agent 已知写法时跳过规划请求），写入仍由用户在预览中确认；见 docs/features/home-agent-upgrade 的 I3。

## 文件

- 契约与协议：`src/subtitle-studio/cue-revision-contract.ts`；编辑操作：`src/subtitle-studio/cue-edit-contract.ts`
- 主进程：`electron/main/subtitle-studio/cue-revision-service.ts`、`cue-edit-service.ts`；IPC：`ipc-contract.ts`、`electron/main/subtitle-studio/index.ts`、preload API 与通道白名单
- 界面：`StudioCueRevision.tsx/.css`，入口在 `StudioCueMenu.tsx`、`StudioCueTable.tsx`，挂载在 `index.tsx`；差异：`src/services/subtitle-studio/text-diff.ts`
- `electron/main/subtitle-studio/index.ts` 属于共享资源集成审计范围，已按 FK-PIT-0186 在 `resources/speech-resources/provenance/current-integration-audits.v1.json` 记录本次复核

## 验证（Windows，2026-10-09）

- `test/subtitle-studio/cue-revision.test.ts`（13 项）：修订与检索计划载荷、计划解析与回退、精确与近似匹配（含两字词不做近似、`Python` 不误中 `Phaethon`）、宽松解析与拒绝计数、差异、相邻行上下文与“译文沿用”、按写法 / 句号 / 全部定位（跳过空行）、零散行各自的相邻上下文、90 条分 3 批并发合并、版本冲突 / 输出上限 / 取消、`revise` 写入及精确撤销重做、确认未改译文、无译文轨与非法文本拒绝。
- 真实 Electron `test/subtitle-studio/cue-revision-ui.test.ts`（本地受控模型服务，不调用付费 API）：
  - 所选范围：翻译后右键 3 条打开修订，默认“原文和译文”、聚焦输入框；“无需修改”结果不提供应用；生成 2 条预览并核对差异、AI 说明、tokens；取消勾选 1 条后应用 1 条，译文保持当前，撤销标签与 Ctrl+Z 恢复；800×600 深色窗口经操作栏修订并核对落盘条目为 `ai/reviewed` 且当前。
  - 整个文档：250 行文档无选区时操作栏打开整个文档范围（“所选”不可选）；“文中的‘法尔童’都应为‘法厄同’”只把命中的 3 行（第 5、120、240 句，含近似写法“法而童”，跨第 1、2、3 页）送去修订；预览显示查找写法与命中数；一次应用写入全部三页并核对落盘，撤销后三页一起恢复；“把所有句末的句号去掉”回退为逐条检查，先提示 250 条、约 7 次请求，确认后才发出修订请求。
  - 截图位于 `test-results/studio-cue-revision/`。
- 回归：既有 `cue-editing-ui` 真实 Electron 用例、`cue-edit`、IPC、通道白名单、边界、`test/subtitle-studio-provenance` 全部通过；`tsc --noEmit`、四语言完整性与引用检查、preload 检查通过。
