# 批量文件/文件夹名称翻译工具 Final Design

> 日期：2026-05-19  
> 范围：新增「批量名称翻译」工具，并让 HomeAgent 能通过自然语言安全驱动该工具。  
> 关键词：文件名翻译、文件夹名翻译、批量重命名、路径层级、HomeAgent 工具调用、预览确认。

---

## 1. 背景

FusionKit 当前已有字幕翻译、格式转换、语言提取三类稳定工具，并且 HomeAgent 已形成「对话优先 + 扁平工具 Schema + scanId 分批」的工具调用架构。`src/pages/Tools/index.tsx` 中已经有 `rename` 工具箱占位，但尚未实现。

本需求要新增一种工具：批量翻译文件或文件夹的名称。它和现有字幕翻译最大的不同是：

1. 它修改的是文件系统实体名称，而不是生成一个新输出文件。
2. 文件夹重命名会改变其子路径，深层目录存在顺序、冲突、回滚、范围确认等风险。
3. HomeAgent 中用户常常只给一个路径，语义可能指向：
   - 翻译这个文件本身的文件名。
   - 翻译这个文件所在目录下的很多文件名。
   - 翻译这个文件路径中的若干级文件夹名。
   - 翻译目标文件夹本身的文件夹名。
   - 翻译目标文件夹下的文件、文件夹，甚至递归到深层。

因此，本工具的核心不是「调用翻译模型改名字」这么简单，而是建立一套可解释、可预览、可确认的路径意图解析与安全执行契约。

---

## 2. 目标与非目标

### 2.1 目标

1. 新增手动工具页：用户可选择文件/文件夹，配置范围，生成名称翻译预览，并确认应用。
2. 新增 HomeAgent 工具能力：用户可通过对话请求翻译文件名/文件夹名，Agent 能正确区分「名称翻译」与「字幕内容翻译」。
3. 支持文件与文件夹混合目标，支持直接子项、递归子项、路径片段等范围表达。
4. 所有真实重命名前必须生成 dry-run 计划，提供原名称、新名称、目标路径、冲突、跳过原因和风险提示。
5. 默认保守：不递归、不改上级路径、不覆盖已有文件、不改扩展名、不改隐藏/系统目录。
6. 支持批量执行、冲突处理、进度展示、失败记录和尽力回滚。
7. 支持大批量目标的 scanId/planId 机制，避免把完整文件清单塞回 LLM 上下文。

### 2.2 非目标

1. 不翻译文件内容。字幕内容翻译继续使用 `queue_subtitle_translate`。
2. 不做跨磁盘移动、复制、整理目录结构。
3. 不默认重命名系统目录、用户 Home 目录、根目录、`.git`、`node_modules` 等高风险目录。
4. 不提供真正事务型文件系统保证。`fs.rename` 只能保证单次同目录 rename 的原子性，批量操作需要 journal 做恢复辅助。
5. 不在 Agent 自动执行模式下绕过预览确认。名称翻译属于高风险文件系统变更，必须先预览。

---

## 3. 当前系统状态

### 3.1 HomeAgent 现状

相关文件：

- `src/agent/orchestrator.ts`
  - 构建 HomeAgent system prompt。
  - 通过 AI SDK `streamText` 驱动工具调用循环。
  - 当前只描述字幕三件套能力。
- `src/agent/tools.ts`
  - 注册 `scan_subtitle_files`、`queue_subtitle_translate`、`queue_subtitle_convert`、`queue_subtitle_extract` 四个工具。
- `src/agent/tool-schemas.ts`
  - 使用 Zod 定义扁平工具入参。
- `src/agent/tool-executor.ts`
  - 执行扫描、入队、执行模式衔接。
- `src/agent/queue-batch.ts`
  - 维护 scanId，支持大扫描结果分批入队。
- `src/store/agent/useAgentStore.ts`
  - 管理消息、工具调用、执行模式、待确认执行等状态。

现有架构经验应继续保留：

1. 工具 Schema 尽量扁平，降低 LLM 参数生成难度。
2. 大结果用 id 引用，不直接把完整列表放进上下文。
3. 对话优先，只有明确任务意图才调用工具。
4. 缺少关键信息时追问，不臆想路径或操作范围。

### 3.2 文件系统 IPC 现状

相关文件：

- `electron/main/fs/ipc.ts`
  - `scan-directory`
  - `read-file-head`
  - `get-file-metadata`
  - `check-path-exists`
  - 会话导入导出相关 IPC

现有 IPC 偏向字幕文件扫描和读取，不具备通用目录树扫描、重命名计划、冲突校验、rename journal、回滚等能力。

### 3.3 工具页现状

相关文件：

- `src/pages/Tools/index.tsx`
  - `rename` 分组仍为 Coming Soon。
- `src/pages/Tools/_shared/toolMeta.ts`
  - `rename` 已存在 metadata，但状态为 `soon`，无路由。
- `src/constants/router.ts`
  - 未登记 rename 工具路由。
- `src/locales/*/tools.json`
  - rename 仅有占位文案。

---

## 4. 核心概念

### 4.1 名称单元

名称翻译只处理路径中的某一个 `basename`：

```text
/Users/me/Downloads/日本語 映画/第01話.srt
                         └─────── 文件夹名称单元
                                  └──── 文件名称单元
```

默认规则：

1. 文件：只翻译文件 stem，保留扩展名。
   - `第01話.srt` -> `Episode 01.srt`
2. 文件夹：翻译整个文件夹 basename。
   - `日本語 映画` -> `Japanese Movie`
3. 隐藏文件的前导点默认保留。
   - `.env.example` 默认跳过，除非用户显式包含隐藏文件。
4. 扩展名默认保留大小写。
5. 数字、季集编号、分辨率、字幕组 tag、括号内容默认保留或仅翻译其中自然语言部分。

### 4.2 Anchor Root

每个用户显式提供的路径都称为 `anchorRoot`。默认操作不得逃出 `anchorRoot` 的边界。

示例：

```text
用户提供：/Users/me/Videos/日剧/第一季
anchorRoot：/Users/me/Videos/日剧/第一季
```

默认最多影响：

1. `第一季` 本身。
2. `第一季` 的直接子项。
3. 用户显式要求递归时，影响 `第一季` 内部后代。

不得默认影响：

1. `/Users/me/Videos`
2. `/Users/me/Videos/日剧`
3. `/Users/me`

如果用户说「把整条路径都翻译」，必须追问或要求用户指定从哪一级开始，例如「从 `日剧` 开始」。

### 4.3 Scope

名称翻译范围统一抽象为 `scope`：

| Scope | 含义 | 典型用户表达 |
| --- | --- | --- |
| `self` | 只翻译用户给出的路径本身 basename | 翻译这个文件名、翻译这个文件夹名 |
| `children` | 翻译目录直接子项 | 翻译这个文件夹里的文件名 |
| `descendants` | 翻译目录内后代项 | 递归翻译、包括子文件夹、所有层级 |
| `path_segments` | 翻译某条路径中的若干级目录名/文件名 | 连同路径里的文件夹、从第 X 级到第 Y 级 |

### 4.4 Target Kind

`targetKind` 控制要改哪些实体：

| targetKind | 含义 |
| --- | --- |
| `files` | 只翻译文件名 |
| `directories` | 只翻译文件夹名 |
| `both` | 文件和文件夹都翻译 |

### 4.5 Plan

所有名称翻译都先生成 `NameTranslationPlan`。Plan 是真实 rename 前的唯一执行依据。

Plan 包含：

1. 解析后的目标集合。
2. 每个目标的翻译结果。
3. 冲突与风险。
4. 可应用状态。
5. 应用时需要的 rename 顺序和 journal 信息。

---

## 5. 用户可见行为

### 5.1 手动工具页

新增工具页建议路径：

```text
/tools/rename/name-translator
```

入口：

1. 工具页 `重命名工具箱` 下新增 `文件名/文件夹名翻译`。
2. 支持拖拽文件/文件夹。
3. 支持系统选择器多选文件和文件夹。

基本流程：

```text
选择路径 -> 配置范围/语言/样式 -> 生成预览 -> 用户检查/编辑 -> 应用重命名 -> 查看结果/失败项/回滚入口
```

页面主要区域：

1. 路径选择区
   - 已选文件/文件夹列表。
   - 显示路径类型、子项数量、风险标签。
2. 范围配置区
   - Scope：仅所选名称 / 直接子项 / 递归子项 / 路径片段。
   - Target Kind：文件 / 文件夹 / 文件和文件夹。
   - 递归深度：不递归、指定深度、无限递归。
3. 翻译配置区
   - 源语言：自动识别 / 指定语言。
   - 目标语言：中文、英文、日文等。
   - 命名风格：保留原风格、空格分词、短横线、下划线、Title Case、lowercase。
   - 保留扩展名、保留编号/tag、跳过隐藏项。
4. 预览表
   - 原路径。
   - 原名称。
   - 新名称。
   - 目标路径。
   - 状态：可应用、无变化、冲突、非法字符、过长、无权限、已跳过。
   - 支持单项编辑新名称、跳过、恢复建议。
5. 应用区
   - 只有无阻塞冲突时可点击「应用」。
   - 高风险项需要二次确认。
   - 应用后展示成功/失败统计、journal 路径和可回滚项。

### 5.2 HomeAgent 行为

HomeAgent 必须把「翻译文件名/文件夹名」与「翻译字幕内容」区分开。

| 用户表达 | 应使用 |
| --- | --- |
| 翻译这个字幕 / 把字幕翻成中文 | 字幕内容翻译工具 |
| 翻译这些文件名 / 文件名改成中文 | 名称翻译工具 |
| 把这个目录里的文件夹名翻成英文 | 名称翻译工具 |
| 重命名成英文 / 批量改名 | 名称翻译工具 |
| 转成 srt / 格式转换 | 字幕格式转换工具 |

HomeAgent 名称翻译必须遵循：

1. 缺少路径时追问。
2. 路径存在但 scope 不明确时，优先生成保守预览或追问。
3. 真实重命名前必须让用户看到 plan。
4. 即使当前执行模式是 `auto_execute`，也只能自动生成预览，不能直接 apply。
5. 用户在后续对话中明确确认该 plan 后，才能调用 apply。

---

## 6. 路径意图解析契约

这是本功能最关键的设计。所有 Agent prompt、工具 schema、UI 默认值都必须遵守同一套规则。

### 6.1 默认规则总表

| 用户给出的路径类型 | 用户表达 | 默认解析 | 是否追问 |
| --- | --- | --- | --- |
| 文件 | 翻译这个文件名 | `scope=self`, `targetKind=files` | 否 |
| 文件 | 翻译这个文件所在文件夹里的文件名 | `scope=children`, `anchorRoot=parent(file)`, `targetKind=files` | 否 |
| 文件 | 连路径一起翻译 / 整条路径翻译 | `scope=path_segments` | 是，需确认起止层级 |
| 文件夹 | 翻译这个文件夹名 | `scope=self`, `targetKind=directories` | 否 |
| 文件夹 | 翻译这个文件夹里的文件名 | `scope=children`, `targetKind=files` | 否 |
| 文件夹 | 翻译这个文件夹里的文件和文件夹名 | `scope=children`, `targetKind=both` | 否 |
| 文件夹 | 递归翻译 / 包括子文件夹 | `scope=descendants`, `targetKind` 按表达推断 | 否 |
| 文件夹 | 翻译这个路径 | 语义不明确 | 是 |
| 多路径 | 翻译这些文件名 | 每个文件 `self`；目录按 `children files` 处理 | 目录存在时生成预览并提示 |

### 6.2 文件路径的特殊规则

用户给了一个文件路径时，默认目标是「这个文件的文件名」。

示例：

```text
把 /Users/me/Downloads/第01話.srt 的文件名翻成英文
```

解析：

```json
{
  "roots": ["/Users/me/Downloads/第01話.srt"],
  "scope": "self",
  "targetKind": "files",
  "includeRoot": true
}
```

如果用户说「所在文件夹里的文件名」，anchorRoot 变成该文件的父目录：

```text
把 /Users/me/Downloads/第01話.srt 所在文件夹里的文件名都翻成英文
```

解析：

```json
{
  "roots": ["/Users/me/Downloads"],
  "scope": "children",
  "targetKind": "files",
  "includeRoot": false
}
```

如果用户说「连路径里的文件夹也翻译」，必须确认层级：

```text
把 /Users/me/Downloads/日剧/第一季/第01話.srt 连路径一起翻成英文
```

不可默认从 `/Users` 开始翻译。Agent 应追问：

```text
你希望从哪一级文件夹开始翻译？例如只翻译「日剧/第一季/第01話.srt」，还是也包含 Downloads？
```

### 6.3 文件夹路径的特殊规则

用户给了一个文件夹路径时，如果明确说「文件夹名」，默认只改该文件夹本身。

```text
把 /Users/me/Downloads/日剧 这个文件夹名翻成英文
```

解析：

```json
{
  "roots": ["/Users/me/Downloads/日剧"],
  "scope": "self",
  "targetKind": "directories",
  "includeRoot": true
}
```

如果说「里面的文件名」，默认只处理直接子文件。

```text
把 /Users/me/Downloads/日剧 里面的文件名翻成英文
```

解析：

```json
{
  "roots": ["/Users/me/Downloads/日剧"],
  "scope": "children",
  "targetKind": "files",
  "includeRoot": false,
  "recursive": false
}
```

只有出现这些词时才递归：

- 递归
- 包括子文件夹
- 所有层级
- 深层目录
- 子目录也处理
- recursively
- include subfolders

### 6.4 `path_segments` 层级规则

`path_segments` 是最高风险范围，必须显式知道起止边界。

字段设计：

```ts
interface PathSegmentRange {
  startPath: string;
  endPath: string;
  includeEndFileName: boolean;
}
```

规则：

1. `startPath` 必须是用户给出的路径本身或其祖先目录。
2. 不允许默认选择 `/`、磁盘根、用户 Home 目录。
3. 如果 `startPath` 不明确，工具返回 `clarificationRequired`。
4. Plan 预览中必须按路径层级分组展示。
5. 应用时必须考虑父目录变更对子路径的影响。

### 6.5 歧义处理

以下情况必须追问或只生成不可应用 plan：

1. 用户只说「翻译这个路径」，没有说明改文件名、文件夹名还是内容。
2. 用户给目录路径但说「翻译它」，无法判断是目录本身还是内部子项。
3. 用户说「整条路径」但没有指定从哪一级开始。
4. 用户要求递归但目标目录包含过多项目，超过默认上限。
5. 用户要求覆盖已有文件名。名称翻译工具默认不支持覆盖，只能 append index 或阻塞。

### 6.6 示例

| 用户输入 | Agent 动作 |
| --- | --- |
| `把 /A/日剧/第01話.srt 文件名翻成中文` | 生成单文件 self plan |
| `把 /A/日剧 这个文件夹名翻成英文` | 生成目录 self plan |
| `把 /A/日剧 里面的文件名翻成英文` | 扫描直接子文件，生成 children/files plan |
| `把 /A/日剧 下面所有文件和文件夹名都翻成英文，包括子文件夹` | 递归扫描 both，生成 descendants plan |
| `把 /A/日剧/第一季/第01話.srt 路径也翻译` | 追问起始层级 |
| `把 /A/日剧 翻译一下` | 追问：翻译文件夹名，还是里面的文件名？ |

---

## 7. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│ UI / HomeAgent                                             │
│                                                            │
│  Tools/Rename/NameTranslator 页面                           │
│  HomeAgent 对话输入                                         │
└───────────────┬──────────────────────────────┬─────────────┘
                │                              │
                ▼                              ▼
┌────────────────────────────┐      ┌─────────────────────────┐
│ useNameTranslatorStore     │      │ Agent tools              │
│ - selectedPaths            │      │ - inspect_rename_paths    │
│ - options                  │      │ - create_name_translation │
│ - currentPlan              │      │ - apply_name_translation  │
│ - applyProgress            │      └────────────┬────────────┘
└───────────────┬────────────┘                   │
                │                                │
                └──────────────┬─────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────┐
│ Renderer services                                           │
│                                                            │
│ nameTargetResolver      解析 roots/scope/targetKind         │
│ nameTranslationPlanner  分批调用模型翻译名称                 │
│ namePlanStore           缓存 planId -> plan                 │
└───────────────┬────────────────────────────────────────────┘
                │ IPC
                ▼
┌────────────────────────────────────────────────────────────┐
│ Electron main                                               │
│                                                            │
│ electron/main/rename/ipc.ts                                 │
│ electron/main/rename/scanner.ts                             │
│ electron/main/rename/apply.ts                               │
│ electron/main/rename/journal.ts                             │
│                                                            │
│ - 扫描文件/文件夹元数据                                     │
│ - 校验冲突与权限                                            │
│ - 执行 rename                                               │
│ - 写入 journal / 支持回滚                                   │
└────────────────────────────────────────────────────────────┘
```

---

## 8. 模块职责

### 8.1 Electron Main

新增目录：

```text
electron/main/rename/
  ipc.ts
  scanner.ts
  planner-validation.ts
  apply.ts
  journal.ts
  types.ts
```

职责：

1. 以主进程权限读取文件系统元数据。
2. 扫描目标目录，支持文件/文件夹、深度限制、隐藏项过滤、危险目录过滤。
3. 校验 rename plan：
   - source 是否仍存在。
   - source 类型是否变化。
   - target 是否冲突。
   - 文件名是否合法。
   - 路径长度是否超限。
   - 是否触及危险目录。
4. 执行 rename：
   - 支持 case-only rename。
   - 支持同目录 swap。
   - 对目录重命名做路径重写。
5. 写 journal：
   - planId。
   - 操作前路径。
   - 操作后路径。
   - 已完成步骤。
   - 失败原因。
6. 尽力回滚：
   - 只回滚当前 journal 中成功执行的项。
   - 回滚前再次校验目标是否仍存在且未被外部修改。

### 8.2 Renderer Service

新增目录：

```text
src/services/rename/
  nameTargetResolver.ts
  nameTranslationPlanner.ts
  namePlanStore.ts
  nameTranslationPrompt.ts
  nameConflict.ts
```

职责：

1. 将 UI/HomeAgent 参数归一化为统一 options。
2. 调 IPC 获取候选目标。
3. 调 AI 模型翻译名称。
4. 合并翻译结果、冲突状态、跳过原因。
5. 生成 planId 并缓存 plan。
6. 返回面向 UI/Agent 的预览摘要。

### 8.3 Store

新增：

```text
src/store/tools/rename/useNameTranslatorStore.ts
```

状态：

```ts
interface NameTranslatorState {
  selectedPaths: SelectedPath[];
  options: NameTranslationOptions;
  currentPlan: NameTranslationPlan | null;
  isPlanning: boolean;
  isApplying: boolean;
  applyProgress: ApplyProgress | null;
  history: NameTranslationPlanSummary[];

  addPaths(paths: string[]): Promise<void>;
  removePath(path: string): void;
  updateOptions(options: Partial<NameTranslationOptions>): void;
  createPreview(): Promise<void>;
  updatePlanItem(planItemId: string, patch: Partial<NameTranslationPlanItem>): void;
  applyCurrentPlan(): Promise<void>;
  rollback(journalId: string): Promise<void>;
}
```

### 8.4 UI

新增：

```text
src/pages/Tools/Rename/NameTranslator/index.tsx
src/pages/Tools/Rename/NameTranslator/components/
```

并更新：

- `src/pages/Tools/index.tsx`
- `src/pages/Tools/_shared/toolMeta.ts`
- `src/constants/router.ts`
- `src/App.tsx`
- `src/locales/zh/tools.json`
- `src/locales/en/tools.json`
- `src/locales/ja/tools.json`

### 8.5 Agent

更新：

- `src/agent/tool-schemas.ts`
- `src/agent/tools.ts`
- `src/agent/tool-executor.ts`
- `src/agent/types.ts`
- `src/agent/orchestrator.ts`
- `src/store/agent/useAgentStore.ts`
- `src/pages/HomeAgent/index.tsx`

---

## 9. 数据模型

### 9.1 Options

```ts
export type NameTranslationScope =
  | "self"
  | "children"
  | "descendants"
  | "path_segments";

export type NameTranslationTargetKind = "files" | "directories" | "both";

export type NameCollisionPolicy =
  | "fail"
  | "append_index";

export interface NameTranslationOptions {
  roots: string[];
  scope: NameTranslationScope;
  targetKind: NameTranslationTargetKind;
  recursive: boolean;
  maxDepth: number;
  includeHidden: boolean;
  includeRoot: boolean;
  sourceLang: "auto" | "ZH" | "JA" | "EN" | "KO" | "FR" | "DE" | "ES" | "RU" | "PT";
  targetLang: "ZH" | "JA" | "EN" | "KO" | "FR" | "DE" | "ES" | "RU" | "PT";
  namingStyle: "preserve" | "space" | "kebab" | "snake" | "title" | "lower";
  preserveExtension: boolean;
  preserveLeadingDot: boolean;
  preserveTechnicalTokens: boolean;
  collisionPolicy: NameCollisionPolicy;
  pathSegmentRange?: PathSegmentRange;
}
```

默认值：

```ts
const DEFAULT_NAME_TRANSLATION_OPTIONS = {
  scope: "self",
  targetKind: "files",
  recursive: false,
  maxDepth: 1,
  includeHidden: false,
  includeRoot: true,
  sourceLang: "auto",
  targetLang: "ZH",
  namingStyle: "preserve",
  preserveExtension: true,
  preserveLeadingDot: true,
  preserveTechnicalTokens: true,
  collisionPolicy: "fail",
};
```

### 9.2 Target

```ts
export interface NameTranslationTarget {
  id: string;
  kind: "file" | "directory";
  absolutePath: string;
  parentPath: string;
  originalName: string;
  stem: string;
  extension: string;
  depthFromRoot: number;
  anchorRoot: string;
  size?: number;
  modifiedAt?: number;
  skipped?: boolean;
  skipReason?: string;
}
```

### 9.3 Plan

```ts
export type NamePlanItemStatus =
  | "ready"
  | "unchanged"
  | "skipped"
  | "blocked"
  | "applied"
  | "failed"
  | "rolled_back";

export interface NameTranslationPlanItem {
  id: string;
  targetId: string;
  kind: "file" | "directory";
  sourcePath: string;
  sourceParentPath: string;
  originalName: string;
  translatedStem: string;
  newName: string;
  targetPath: string;
  status: NamePlanItemStatus;
  reason?: string;
  warnings: string[];
}

export interface NameTranslationPlan {
  planId: string;
  createdAt: number;
  options: NameTranslationOptions;
  roots: string[];
  totalTargets: number;
  previewLimit: number;
  itemsPreview: NameTranslationPlanItem[];
  itemsStored: boolean;
  readyCount: number;
  blockedCount: number;
  skippedCount: number;
  unchangedCount: number;
  warnings: string[];
  clarificationRequired?: {
    code: string;
    message: string;
    choices?: string[];
  };
  applyable: boolean;
}
```

### 9.4 Apply Result

```ts
export interface NameTranslationApplyResult {
  planId: string;
  journalId: string;
  startedAt: number;
  finishedAt: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  failures: Array<{
    itemId: string;
    sourcePath: string;
    targetPath: string;
    error: string;
  }>;
}
```

---

## 10. Agent 工具设计

名称翻译工具建议拆成 3 个工具。原因：重命名是高风险文件系统写操作，需要把「检查/计划」和「应用」分开。

### 10.1 `inspect_rename_paths`

用途：检查用户给出的路径类型，返回文件/目录、子项数量、风险提示和建议 scope。用于路径语义不确定时辅助 Agent 判断或追问。

Schema：

```ts
export const inspectRenamePathsSchema = z.object({
  paths: z.array(z.string()).min(1).describe("Absolute file or directory paths to inspect"),
});
```

返回：

```json
{
  "success": true,
  "data": {
    "paths": [
      {
        "path": "/Users/me/Videos/日剧",
        "exists": true,
        "kind": "directory",
        "directFileCount": 12,
        "directDirectoryCount": 3,
        "riskLevel": "normal",
        "suggestedScopes": ["self", "children", "descendants"]
      }
    ]
  }
}
```

### 10.2 `create_name_translation_plan`

用途：生成 dry-run 名称翻译计划，不修改文件系统。

Schema：

```ts
export const createNameTranslationPlanSchema = z.object({
  roots: z.array(z.string()).min(1).describe("Absolute file or directory paths provided by the user"),
  scope: z.enum(["self", "children", "descendants", "path_segments"]),
  targetKind: z.enum(["files", "directories", "both"]),
  recursive: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(20).default(1),
  includeHidden: z.boolean().default(false),
  includeRoot: z.boolean().default(true),
  sourceLang: z.enum(["auto", "ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"]).default("auto"),
  targetLang: z.enum(["ZH", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"]),
  namingStyle: z.enum(["preserve", "space", "kebab", "snake", "title", "lower"]).default("preserve"),
  collisionPolicy: z.enum(["fail", "append_index"]).default("fail"),
  pathSegmentStartPath: z.string().optional(),
  pathSegmentEndPath: z.string().optional(),
  includeEndFileName: z.boolean().default(true),
});
```

设计约束：

1. 该工具永远 dry-run。
2. 如果 `scope=path_segments` 但缺少 `pathSegmentStartPath`，返回 `clarificationRequired`。
3. 如果目标超过默认上限，返回 plan 但 `applyable=false`，要求用户缩小范围或显式确认大批量。
4. 返回值只包含 preview；完整 items 保存在 `namePlanStore` 中，用 `planId` 引用。

### 10.3 `apply_name_translation_plan`

用途：应用已生成的 plan。

Schema：

```ts
export const applyNameTranslationPlanSchema = z.object({
  planId: z.string().describe("Plan id returned by create_name_translation_plan"),
  confirmationText: z
    .string()
    .optional()
    .describe("The user's latest explicit confirmation text"),
});
```

执行前校验：

1. plan 必须存在且未过期。
2. plan 必须 `applyable=true`。
3. plan 无 `blocked` 项。
4. 必须有用户确认来源：
   - UI 点击确认；或
   - Agent 最近一轮用户消息明确确认该 plan，例如「确认执行刚才的重命名计划」。
5. `auto_execute` 不自动绕过确认。

返回：

```json
{
  "success": true,
  "data": {
    "planId": "rename_plan_abc",
    "journalId": "rename_journal_xyz",
    "successCount": 18,
    "failedCount": 0,
    "skippedCount": 2
  }
}
```

---

## 11. HomeAgent Prompt 规则

`src/agent/orchestrator.ts` 的 system prompt 需要新增名称翻译能力描述。

建议增加：

```text
4. Name Translation / Rename (文件名/文件夹名翻译、批量重命名):
   Translate names of files or folders without translating file contents.
```

关键行为规则：

```text
- Distinguish subtitle content translation from name translation:
  - "翻译字幕/字幕内容/把字幕翻成中文" = subtitle content translation.
  - "翻译文件名/文件夹名/重命名/改名" = name translation.

- Name translation is a filesystem rename operation. Never apply changes directly.
  Always create a dry-run plan first and summarize preview, conflicts, and required confirmation.

- If the user gives a file path:
  - Default to translating only that file's name.
  - If they mention "所在文件夹/同目录/这个目录里的文件", use the parent directory as root.
  - If they mention "路径/上级文件夹/整条路径", ask which path segment to start from unless explicitly specified.

- If the user gives a directory path:
  - "文件夹名" means scope=self, directories.
  - "里面的文件名" means scope=children, files, not recursive.
  - Use recursive descendants only when the user explicitly says recursively / 包括子文件夹 / 所有层级.

- For ambiguous phrases like "翻译这个路径" or "把这个文件夹翻译一下", ask a clarifying question or use inspect_rename_paths.

- Even in Auto Execute mode, apply_name_translation_plan requires explicit user confirmation after preview.
```

---

## 12. 翻译计划生成流程

### 12.1 目标解析

输入：`NameTranslationOptions`

输出：`NameTranslationTarget[]`

流程：

1. 对每个 root 调 `check-path-exists` 或新的 rename scan IPC。
2. 根据 root 类型和 scope 展开目标。
3. 应用过滤规则：
   - 默认跳过隐藏项。
   - 默认跳过 `.git`、`node_modules`、`Library`、`System` 等高风险目录。
   - 默认跳过符号链接目录。
   - 默认跳过无权限项。
4. 去重：
   - 以规范化 absolutePath 去重。
   - macOS/Windows 上考虑大小写不敏感路径。
5. 排序：
   - 文件可按路径字典序。
   - 目录 plan 保留 depth 信息，apply 阶段再计算顺序。

### 12.2 名称翻译

名称翻译不应让 Agent 模型直接在工具参数里生成结果。原因：

1. 大批量名称会污染对话上下文。
2. Agent 可能漏项或改错扩展名。
3. 翻译结果需要结构化校验和重试。

推荐由 `nameTranslationPlanner` 使用任务模型配置单独调用 AI SDK，结构化输出：

```ts
interface NameTranslationModelInputItem {
  id: string;
  kind: "file" | "directory";
  originalName: string;
  stem: string;
  extension: string;
  contextPath?: string;
}

interface NameTranslationModelOutputItem {
  id: string;
  translatedStem: string;
  confidence?: "high" | "medium" | "low";
  note?: string;
}
```

分批策略：

1. 每批默认 100 到 200 个名称。
2. 传入统一术语表和规则：
   - 保留扩展名。
   - 保留季集编号。
   - 保留年份、分辨率、编码、字幕组 tag。
   - 不添加解释。
   - 输出合法文件名字符。
3. 输出后做二次清洗：
   - 移除 `/`、`\`、`:` 等非法字符。
   - 去除首尾空白和结尾点号。
   - 避免 Windows 保留名：`CON`、`PRN`、`AUX`、`NUL` 等。
   - 控制长度。

### 12.3 冲突检测

冲突类型：

| 类型 | 说明 | 默认处理 |
| --- | --- | --- |
| `target_exists` | 目标路径已存在，且不是同一批 rename 的源 | blocked |
| `duplicate_target` | 同一批多个项翻译成同名 | blocked 或 append_index |
| `case_only` | 只改变大小写 | 使用临时名处理 |
| `swap` | A->B 且 B->A | 使用临时名处理 |
| `invalid_name` | 含非法字符或空名称 | blocked |
| `path_too_long` | 目标路径过长 | blocked |
| `permission_denied` | 无权限 | blocked |

默认 `collisionPolicy=fail`。如果用户明确说「自动编号避免重名」，可设置 `append_index`。

不提供 `overwrite`。文件名翻译覆盖已有文件风险过高，应让用户先处理冲突。

---

## 13. 应用重命名流程

### 13.1 执行前校验

应用前重新校验整个 plan：

1. 所有 sourcePath 仍存在。
2. source 类型未变化。
3. targetPath 仍可用。
4. 没有新冲突。
5. plan 未过期，或用户确认重新校验后的差异。

如果校验结果与 preview 不一致，阻止应用并要求重新生成 plan。

### 13.2 安全 rename 算法

批量 rename 采用两阶段策略：

1. Source -> 临时名
2. 临时名 -> Target

临时名要求：

```text
.fusionkit-renaming-<planId>-<shortId>.tmp
```

优点：

1. 支持 case-only rename。
2. 支持 A/B 互换。
3. 降低中途冲突风险。

目录重命名时需要维护 path rewrite map：

```text
原路径：/A/日剧/第一季/第01話.srt
临时父目录后，子项实际路径会变化。
apply.ts 必须每完成一步就更新后续项的 currentPath。
```

建议顺序：

1. Source -> temp：目录按 depth desc，文件按路径字典序。
2. Temp -> target：目录按 depth asc，文件按路径字典序。

实际实现可通过 `currentPathMap` 动态计算，避免使用过期路径。

### 13.3 Journal

journal 存储位置建议：

```text
app.getPath("userData")/rename-journals/<journalId>.json
```

结构：

```ts
interface RenameJournal {
  journalId: string;
  planId: string;
  createdAt: number;
  status: "running" | "completed" | "failed" | "rolled_back";
  operations: Array<{
    itemId: string;
    originalPath: string;
    tempPath?: string;
    finalPath: string;
    status: "pending" | "temp_done" | "final_done" | "failed" | "rolled_back";
    error?: string;
  }>;
}
```

### 13.4 回滚

回滚是尽力而为，不承诺完全恢复：

1. 只处理 journal 中 `final_done` 或 `temp_done` 的项。
2. 如果 finalPath 已被用户移动/修改，标记 `rollback_blocked`。
3. 回滚也需要两阶段临时名，避免冲突。
4. UI 必须展示哪些项回滚成功、哪些需要人工处理。

---

## 14. IPC 设计

新增 IPC：

```ts
// 选择文件/文件夹
"select-rename-paths"

// 检查路径和子项摘要
"inspect-rename-paths"

// 扫描名称翻译目标
"scan-rename-targets"

// 校验 plan
"validate-rename-plan"

// 应用 plan
"apply-rename-plan"

// 回滚 journal
"rollback-rename-journal"
```

### 14.1 `inspect-rename-paths`

输入：

```ts
interface InspectRenamePathsParams {
  paths: string[];
}
```

输出：

```ts
interface InspectRenamePathsResult {
  paths: Array<{
    path: string;
    exists: boolean;
    kind: "file" | "directory" | "other" | "missing";
    basename: string;
    parentPath: string;
    directFileCount?: number;
    directDirectoryCount?: number;
    hidden?: boolean;
    symlink?: boolean;
    riskLevel: "normal" | "warning" | "blocked";
    warnings: string[];
  }>;
}
```

### 14.2 `scan-rename-targets`

输入：

```ts
interface ScanRenameTargetsParams {
  options: NameTranslationOptions;
  maxTargets: number;
}
```

输出：

```ts
interface ScanRenameTargetsResult {
  targets: NameTranslationTarget[];
  totalCount: number;
  truncated: boolean;
  warnings: string[];
}
```

### 14.3 `apply-rename-plan`

输入：

```ts
interface ApplyRenamePlanParams {
  plan: NameTranslationPlan;
  items: NameTranslationPlanItem[];
}
```

输出：

```ts
interface ApplyRenamePlanResult extends NameTranslationApplyResult {}
```

---

## 15. UI 交互细节

### 15.1 预览表状态

| 状态 | 展示 | 是否可应用 |
| --- | --- | --- |
| ready | 普通行 | 是 |
| unchanged | 灰色行，说明翻译后无变化 | 否，自动跳过 |
| skipped | 灰色行，展示跳过原因 | 否 |
| blocked | 红色/警告行，展示原因 | 否 |
| applied | 成功标记 | 已执行后展示 |
| failed | 错误标记 | 已执行后展示 |

### 15.2 编辑能力

用户可以在预览表中：

1. 修改单项新名称。
2. 跳过单项。
3. 对冲突项使用自动编号。
4. 重新翻译选中项。

任何手动编辑都需要重新跑冲突校验。

### 15.3 高风险确认

以下情况应用前弹二次确认：

1. 包含目录重命名。
2. 递归重命名。
3. 超过 100 个目标。
4. 涉及 path_segments。
5. 目标中包含可执行文件、工程目录、隐藏目录。

确认弹窗必须展示：

1. 影响数量。
2. 是否包含文件夹。
3. 是否可回滚。
4. journal 会保存在哪里。

---

## 16. 安全与权限

### 16.1 默认阻止目录

默认阻止或要求强确认：

```text
/
/System
/Library
/Applications
/Users
用户 Home 根目录
.git
node_modules
```

Windows 需要类似阻止：

```text
C:\
C:\Windows
C:\Program Files
C:\Users
```

### 16.2 默认跳过

1. 隐藏文件/目录。
2. 符号链接目录。
3. 无权限项。
4. 空名称或翻译后为空。
5. 非普通文件/目录。

### 16.3 日志与审计

HomeAgent session log 需要记录：

1. inspect 参数和摘要。
2. planId、roots、scope、targetKind、ready/blocked/skipped 数量。
3. apply 的 journalId 和成功/失败数量。

不要在普通对话消息里输出超长完整路径列表，避免污染上下文。只展示摘要和 preview。

---

## 17. 性能与上限

默认上限：

| 项 | 默认 |
| --- | --- |
| 单次扫描最大目标 | 5000 |
| Agent 返回 preview | 30 |
| UI 预览分页 | 100 / 页 |
| 翻译批大小 | 100-200 名称 |
| 默认递归深度 | 1 |
| 最大递归深度 | 20 |

大批量处理：

1. 扫描结果保存在 renderer/main 的 plan store。
2. Agent 只拿 `planId`、统计和 preview。
3. 翻译分批执行，UI 显示进度。
4. 计划生成可取消。

---

## 18. 国际化与命名策略

语言列表建议与字幕翻译保持一致：

```text
ZH, JA, EN, KO, FR, DE, ES, RU, PT
```

命名策略：

1. 中文目标语言默认不插入空格。
2. 英文目标语言默认保留原分隔符；用户可选 space/kebab/snake/title。
3. 日文目标语言默认保留原风格。
4. 技术 token 默认保留：
   - `S01E02`
   - `1080p`
   - `BluRay`
   - `WEB-DL`
   - `x264`
   - `[字幕组]`
   - 年份 `(2024)`

---

## 19. 错误处理

| 场景 | 处理 |
| --- | --- |
| 路径不存在 | plan blocked，提示路径不存在 |
| 没有权限 | plan blocked，提示权限不足 |
| 翻译模型未配置 | 创建 plan 失败，提示去设置页配置任务模型 |
| 模型输出缺项 | 对缺项重试一次，仍失败则标记 blocked |
| 模型输出非法文件名 | 清洗后若为空则 blocked |
| 目标冲突 | 默认 blocked，可选择自动编号 |
| 应用中途失败 | 停止后续 final rename，写 journal，提示可回滚 |
| plan 过期或文件系统变化 | 阻止应用，要求重新生成预览 |

---

## 20. 测试策略

### 20.1 单元测试

建议新增：

```text
src/services/rename/nameTargetResolver.test.ts
src/services/rename/nameConflict.test.ts
electron/main/rename/apply.test.ts
src/agent/name-translation-intent.test.ts
src/agent/tool-schemas.test.ts
```

覆盖：

1. 文件路径 self 解析。
2. 目录 children/descendants 解析。
3. path_segments 缺少 startPath 时要求澄清。
4. hidden/symlink/blocked directory 过滤。
5. duplicate target、target exists、case-only、swap 冲突。
6. append_index 结果稳定。
7. 目录重命名路径顺序。
8. rollback journal 状态机。

### 20.2 集成测试

使用临时目录创建文件树：

```text
tmp/
  日剧/
    第一季/
      第01話.srt
      第02話.srt
    メモ.txt
```

验证：

1. plan 不修改文件系统。
2. apply 后路径符合预期。
3. 目录递归 rename 后子路径仍存在。
4. 失败时 journal 写入完整。
5. rollback 可恢复可恢复项。

### 20.3 Agent 测试

构造用户输入，验证工具选择：

1. `把 /a/b.srt 翻译成中文` -> 字幕内容翻译。
2. `把 /a/b.srt 文件名翻译成中文` -> 名称翻译 self。
3. `把 /a/日剧 这个文件夹名翻译成英文` -> 名称翻译 directory self。
4. `把 /a/日剧 里面的文件名翻译成英文` -> children files。
5. `把 /a/日剧/第一季/b.srt 连路径一起翻译` -> 追问。

---

## 21. 发布与兼容

建议分阶段发布：

### Phase 1：手动工具 MVP

1. 文件名 self。
2. 目录 children files。
3. dry-run preview。
4. apply + journal。
5. 不开放 path_segments。

### Phase 2：文件夹与递归

1. directory self。
2. children directories/both。
3. descendants + depth limit。
4. 高风险确认。

### Phase 3：HomeAgent 集成

1. inspect/create/apply 三工具。
2. system prompt 增强。
3. Agent plan preview 卡片。
4. 对话确认 apply。

### Phase 4：路径片段与回滚增强

1. path_segments。
2. 更完整的 rollback。
3. 大批量性能优化。

---

## 22. 实施工作包建议

| ID | 标题 | 主要文件 | 验收标准 |
| --- | --- | --- | --- |
| RN-001 | 类型与 IPC 扫描能力 | `electron/main/rename/*` | 可检查路径、扫描候选目标 |
| RN-002 | 名称翻译 planner | `src/services/rename/*` | 可生成 dry-run plan，包含冲突 |
| RN-003 | 安全 apply + journal | `electron/main/rename/apply.ts` | 可执行、失败有 journal、支持基础回滚 |
| RN-004 | 手动工具页 | `src/pages/Tools/Rename/NameTranslator/*` | 用户可选择路径、预览、应用 |
| RN-005 | 工具入口与 i18n | `toolMeta.ts`、`Tools/index.tsx`、`locales/*/tools.json` | rename 工具从 Coming Soon 变为可用 |
| RN-006 | HomeAgent 工具 Schema 与执行器 | `src/agent/*` | Agent 可生成 plan，不会误用字幕翻译 |
| RN-007 | HomeAgent 预览确认 UI | `HomeAgent/index.tsx`、`useAgentStore.ts` | Agent plan 必须确认后 apply |
| RN-008 | 测试与文档回填 | `*.test.ts`、`docs/home-agent/*` | 关键路径测试通过，文档同步 |

---

## 23. 关键设计结论

1. 名称翻译必须是「先计划，后应用」；不能直接把模型输出用于 rename。
2. 文件夹难点通过 `anchorRoot + scope + targetKind + pathSegmentRange` 解决。
3. 默认只影响用户明确选择的边界内路径，不自动改上级目录。
4. HomeAgent 对目录路径的默认行为要保守：不递归，不改路径片段，不覆盖。
5. `path_segments` 必须显式确认起止层级。
6. `auto_execute` 不适用于真实 rename；最多自动生成预览。
7. 执行层必须有 journal，因为批量 rename 不是单事务操作。
8. 工具 Schema 可以比字幕工具多一个 apply 阶段，这是为了文件系统安全付出的必要复杂度。

---

## 24. RN-008 实现回填

截至 2026-05-21，RN-001 至 RN-007 已完成，RN-008 对最终实现做如下同步记录：

1. 最终 IPC 名称：
   - `select-rename-paths`
   - `inspect-rename-paths`
   - `scan-rename-targets`
   - `validate-rename-plan`
   - `apply-rename-plan`
   - `rollback-rename-journal`
   - 名称翻译 planner 复用既有 `check-path-exists` 检查目标路径是否存在。
2. 最终路由：
   - 手动工具页：`/tools/rename/name-translator`
   - HomeAgent 卡片的“在工具页打开”会跳转到 `/tools/rename/name-translator?planId=<planId>`；工具页会自动消费该 query，从 renderer memory `namePlanStore` 恢复完整 plan、选中路径、配置、预览表和应用区。
3. Plan store 策略：
   - renderer memory store：`src/services/rename/namePlanStore.ts`
   - 默认 TTL：30 分钟。
   - 最多保留 10 个 plan，超过后按创建时间淘汰。
   - 不持久化完整 plan；应用前必须通过 `planId` 找到未过期 plan。
4. `path_segments` 状态：
   - 缺少起止边界时返回 `clarificationRequired.code = "path_segment_boundary_required"`。
   - 起点为根目录、Home 根目录或系统保护目录时返回 `unsafe_path_segment_start`。
   - 即使起止边界齐全，当前实现仍返回 `path_segments_deferred`，不生成可应用 plan；该能力保留到 Phase 4。
5. Journal 与 rollback：
   - 默认 journal 目录为 `app.getPath("userData")/rename-journals`。
   - apply 使用两阶段 temp/final rename，并在中途失败时保留 readable journal。
   - rollback 只处理 journal 中 `final_done` 或 `temp_done` 的可恢复项；如果目标路径已被用户移动、修改或被新文件占用，会记录失败，不提供完整事务保证。
6. HomeAgent UI：
   - Agent 工具为 `inspect_rename_paths`、`create_name_translation_plan`、`apply_name_translation_plan`。
   - `create_name_translation_plan` 结果渲染为 `qv:name-translation-plan` 预览卡片。
   - `apply_name_translation_plan` 结果渲染为 `qv:name-translation-apply-result`。
   - `auto_execute` 不会自动应用 rename；应用必须来自 UI 点击确认或最近用户消息的明确确认。
7. 验证命令与结果记录在：
   - `docs/batch-name-translation-tool/implementation-notes/2026-05-21_final-implementation-status.md`
   - `docs/batch-name-translation-tool/implementation-records/2026-05-21_RN-008_tests-and-docs.md`
