# 通用长文本文件翻译工具 Final Design

> 日期：2026-06-23
> Feature Slug：`long_text_translator`
> 状态：设计已收敛；M0 技术验证、BE 主进程最小闭环（CORE-001/002、BE-001 至 BE-007）、FE-001 至 FE-004 文本翻译 UI、REL-001 至 REL-003 可靠恢复能力、MEM-001 至 MEM-004 串行语义记忆能力、PROJ-001/PROJ-002 有序项目能力、OUT-001 TXT 块级双语输出、MD-001 至 MD-005 Markdown 解析/输出组装、执行协议与 parallel E2E、DOC-001 README/发布说明与 DOC-002 工作区清理/兼容策略已完成；Execution Plan 仍需继续推进 `MD-006`、`FE-005`、`QA-MD-001`、`DOC-MD-001` 补齐 Markdown 串行恢复、Renderer 入口和发布文档后再进入发布候选 QA
> 范围：新增支持整本小说规模 `.txt` / `.md` 文件的批量 AI 翻译工具。

---

## 1. 评审结论

### 1.1 可复用的现有能力

现有字幕翻译工具已经提供了以下可复用经验：

1. 使用任务模型配置调用 OpenAI Compatible Chat Completions API。
2. 文件级任务队列、等待队列、最大并发数和取消机制。
3. 按 token 上限拆分内容并显示分片进度。
4. 分片失败重试、检查点、部分结果文件和历史任务恢复。
5. 输出路径、同名冲突处理、token 与费用预估。
6. Renderer store、纯队列 service、IPC execution service 和 Electron 主进程执行器的分层结构。

相关现有文件：

- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/store/tools/subtitle/useSubtitleTranslatorStore.ts`
- `src/services/subtitle/translatorQueueService.ts`
- `src/services/subtitle/translatorExecutionService.ts`
- `electron/main/translation/translation-service.ts`
- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/checkpoint.ts`
- `electron/main/translation/recovery-artifacts.ts`

### 1.2 不能直接沿用字幕翻译实现的部分

长文本翻译不能通过增加 `.txt` / `.md` 后缀的方式直接塞入字幕翻译模块，原因如下：

1. 字幕分片以 LRC 行或 SRT 块为结构边界，长文本需要段落、标题、列表、引用、章节和 Markdown AST 边界。
2. 当前字幕串行模式只把上一片原文作为下一片上下文，没有持久化的译文上下文、术语表、人物关系、章节摘要或滚动语义记忆。
3. 字幕 checkpoint 把全部源分片和译文保存在单个 JSON 文件中。整本小说规模下，每完成一片都重写整个 manifest，会产生明显的内存、磁盘写放大和损坏风险。
4. 字幕任务使用 `fileName` 作为队列和取消标识，不足以区分不同目录中的同名文件。
5. 长文件不应由 Renderer 读取全文后通过 IPC 发送给主进程，应由主进程根据文件路径流式或分段读取。
6. Markdown 翻译必须保护代码、URL、frontmatter 等结构，并避免重新序列化造成无关格式漂移。

### 1.3 最终设计约束

实现期间不得违反以下约束：

1. 长文本翻译是独立领域模块，不与 `SubtitleTranslatorTask` 混用。
2. 所有任务、IPC 事件、运行时控制均使用稳定唯一的 `taskId`。
3. 支持 `.txt` 和 `.md`，最大规模按整本小说设计。
4. 支持“快速并发”和“连贯串行”两种分片执行模式。
5. 串行模式的语义记忆必须持久化并可恢复，不能只存在进程内存中。
6. 多文件小说项目可按用户确定的顺序共享串行语义记忆。
7. 输出支持“仅译文”和“段落/块级双语对照”。
8. Markdown 双语输出采用“原始可翻译块后紧跟译文引用块”的形式。
9. 文件编码自动探测和解码，正常流程不要求用户理解或选择编码。
10. 不把 API Key、Authorization header 或完整模型 profile 写入恢复工作区。
11. HomeAgent 不属于本期实现范围，但设计需保留稳定接入点。

---

## 2. 背景

FusionKit 现有 AI 翻译工具主要面向字幕和文件名。用户还需要处理小说、文章、技术文档、说明书等普通长文本文件，并且希望在速度和连贯性之间自主选择：

- 大批量、对上下文依赖较低的内容使用分片并发翻译。
- 小说等强上下文内容使用分片串行翻译，并在后续分片请求中持续携带语义记忆。

目标文件可能达到整本小说级，并可能由一个大文件或多个章节文件组成。工具必须在长时间运行、应用退出、网络中断、模型限流和部分分片失败后可靠恢复，而不是重新翻译已完成内容。

---

## 3. 目标与非目标

### 3.1 目标

1. 新增独立的“长文本翻译”手动工具页。
2. 支持单个或批量导入 `.txt`、`.md` 文件。
3. 支持把多个文件组织为一个有序项目，共享串行语义记忆。
4. 支持快速并发与连贯串行两种执行模式。
5. 支持仅译文与块级双语对照输出。
6. 支持自动文件编码探测、无损解码和 UTF-8 输出。
7. 支持整本小说规模的分片、增量持久化、进度统计和恢复。
8. 支持自定义分片 token 上限和串行语义记忆 token 上限。
9. 支持自定义文档背景、翻译要求、风格要求和术语表。
10. Markdown 输出尽量保持原始结构与无关格式不变。
11. 支持取消、失败重试、断点续译和从头重译。
12. 提供 token / 费用预估，并清晰说明串行语义记忆带来的额外输入 token。

### 3.2 非目标

本期不包含：

1. HomeAgent 工具注册、意图识别或自然语言入队。
2. DOCX、PDF、EPUB、HTML、RTF 等格式。
3. 所见即所得的段落级人工译文编辑器。
4. 翻译记忆库的跨项目永久复用。
5. 云端任务同步或跨设备恢复。
6. 多用户协作、审校工作流或版本控制。
7. 对 Markdown 内嵌 HTML 的语义翻译；首版默认保护并原样保留。
8. 自动判断多个文件的正确阅读顺序。工具提供排序能力，但最终顺序由用户确认。

---

## 4. 用户可见行为

### 4.1 工具入口

建议新增一级工具分类“文本工具”，并添加：

```text
/tools/text/translator
```

工具名称：

```text
长文本翻译
```

入口文件预计包括：

- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/pages/Tools/index.tsx`
- `src/pages/Tools/_shared/toolMeta.ts`
- `src/App.tsx`
- `src/locales/*/tools.json`
- `src/locales/*/text.json`

### 4.2 基本流程

```text
添加文件
  -> 确认文件顺序与项目模式
  -> 配置语言、输出、执行与上下文
  -> 后台解析、编码识别与费用预估
  -> 开始翻译
  -> 查看文件级和分片级进度
  -> 完成后打开输出目录
```

### 4.3 单文件与项目模式

#### 独立文件模式

每个文件是一个独立任务：

- 独立分片。
- 独立语义记忆。
- 一个文件失败不影响其它文件。
- 适合互不相关的文章或文档。

#### 有序项目模式

多个文件组成一个翻译项目：

- 用户可拖拽排序或使用文件名自然排序。
- 串行模式按“文件顺序 → 文件内分片顺序”执行。
- 项目级语义记忆跨文件延续。
- 每个文件仍产生独立输出文件。
- 文件边界会作为强语义边界写入记忆，例如“章节结束”。
- 用户可以选择在指定文件前重置语义记忆，适合多卷或附录。

项目顺序必须在任务开始前冻结。开始后如需改变顺序，必须重新创建项目或从受影响位置重新规划，不能静默改变后继续恢复。

### 4.4 输出模式

#### 仅译文

输出只包含目标语言，尽量保持原始段落和 Markdown 结构。

#### 双语对照

`.txt` 使用块级相邻输出：

```text
Original paragraph.

Translated paragraph.
```

每组之间保留稳定空行。为了避免原文与译文在纯文本中难以区分，可提供以下格式配置，默认使用简洁模式：

```text
简洁：原文 + 空行 + 译文
带标签：[Original] / [Translation]
```

`.md` 使用“原始块后紧跟译文引用块”：

```md
Original paragraph.

> Translated paragraph.
```

规则：

1. 普通段落、标题、列表项、引用、表格等按“可翻译块”处理。
2. 原始 Markdown 块保持原样。
3. 译文紧跟原块，以 blockquote 形式插入。
4. 标题译文不生成第二个 Markdown 标题，避免重复锚点和目录污染。
5. 列表译文不生成第二套同级列表，避免列表序号和缩进结构被破坏。
6. 原始块本身已经是引用时，译文引用按安全嵌套层级生成。
7. 无法安全插入译文引用的复杂结构保持原样，并记录警告。

### 4.5 输出命名

默认不覆盖源文件：

```text
novel.txt -> novel.zh.txt
chapter-01.md -> chapter-01.zh.md
```

其中语言后缀使用目标语言代码的小写形式。用户可配置：

- 输出到源文件目录。
- 输出到指定目录。
- 同名冲突时自动追加序号。
- 明确选择覆盖已有输出；永不默认覆盖源文件。

项目模式保持相对目录结构。例如：

```text
source/
  volume-1/chapter-01.md
  volume-1/chapter-02.md

output/
  volume-1/chapter-01.zh.md
  volume-1/chapter-02.zh.md
```

---

## 5. 核心领域模型

建议新增：

```text
src/type/textTranslation.ts
electron/main/text-translation/types.ts
```

核心类型：

```ts
type TextFileFormat = "txt" | "markdown";

type TextTranslationExecutionMode =
  | "parallel"
  | "sequential_context";

type TextTranslationOutputMode =
  | "target_only"
  | "bilingual";

type TextTranslationTaskStatus =
  | "not_started"
  | "preparing"
  | "waiting"
  | "running"
  | "paused"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

type TextTranslationProjectMode =
  | "independent_files"
  | "ordered_project";

interface TextTranslationFileRef {
  fileId: string;
  sourcePath: string;
  relativePath?: string;
  fileName: string;
  format: TextFileFormat;
  sizeBytes: number;
  modifiedAt: number;
  order: number;
}

interface TextTranslationOptions {
  sourceLang: TranslationLanguage | "AUTO";
  targetLang: TranslationLanguage;
  executionMode: TextTranslationExecutionMode;
  outputMode: TextTranslationOutputMode;
  projectMode: TextTranslationProjectMode;

  sliceTokenLimit: number;
  semanticMemoryTokenLimit: number;
  modelContextTokenLimit: number;
  outputTokenReserve: number;
  parallelSliceConcurrency: number;

  documentBackground?: string;
  translationInstructions?: string;
  styleInstructions?: string;
  glossary?: Array<{
    source: string;
    target: string;
    note?: string;
  }>;

  outputDir?: string;
  outputPathMode: "custom" | "source";
  conflictPolicy: "overwrite" | "index";
}

interface TextTranslationTask {
  taskId: string;
  projectId?: string;
  files: TextTranslationFileRef[];
  options: TextTranslationOptions;
  status: TextTranslationTaskStatus;
  phase: TextTranslationPhase;
  progress: TextTranslationProgress;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 5.1 默认值

建议默认值：

```text
executionMode             parallel
outputMode                target_only
projectMode               independent_files
sliceTokenLimit           3000
semanticMemoryTokenLimit  8192
modelContextTokenLimit    32768
outputTokenReserve        max(4096, sliceTokenLimit × 2)
parallelSliceConcurrency  3
```

说明：

1. 小说用户选择串行模式后，默认 8192 tokens 的语义记忆上限相对充裕。
2. 8192 是配置上限，不代表每次一定填满。
3. 实际可用记忆预算由请求预算器动态计算。
4. 并发默认 3 路，比字幕当前单文件 5 路更保守，避免多个小说任务叠加产生过高瞬时请求量。
5. 分片 token 上限和语义记忆上限应分别配置，不能混为一个值。

---

## 6. 总体架构

```text
TextTranslator Page
  -> useTextTranslatorStore
     -> textTranslatorQueueService
     -> textTranslatorExecutionService
        -> namespaced IPC
           -> TextTranslationService
              -> InputFileService
                 -> EncodingDetector
                 -> Text/Markdown Parser
              -> SegmentPlanner
              -> RequestBudgeter
              -> TranslationModelClient
              -> ParallelExecutor
              -> SequentialContextExecutor
              -> SemanticMemoryManager
              -> WorkspaceRepository
              -> OutputAssembler
```

### 6.1 Renderer 职责

Renderer 只负责：

1. 选择文件和输出目录。
2. 编辑文件顺序和任务配置。
3. 展示元数据、预估、进度、警告和恢复入口。
4. 通过路径和轻量参数发起任务。
5. 管理任务队列视图。

Renderer 不负责：

1. 读取整本小说全文。
2. 执行真实分片。
3. 保存所有分片译文。
4. 维护串行语义记忆。
5. 组装最终输出文件。

### 6.2 Electron 主进程职责

主进程负责：

1. 文件读取、编码探测和解码。
2. 文本/Markdown 结构解析。
3. 分片规划和 token 预算。
4. 模型调用、重试、限流和取消。
5. 串行语义记忆维护。
6. 增量工作区写入和任务恢复。
7. 最终输出组装和原子写入。
8. 通过 IPC 推送任务与文件级进度。

---

## 7. 文件读取与编码自动探测

### 7.1 用户体验原则

正常情况下不向用户展示编码选择。页面只显示：

- 已识别编码，例如 `UTF-8`、`GB18030`、`Shift-JIS`。
- 低置信度或疑似损坏时的警告。
- 高级故障恢复入口中的手动覆盖选项。

“用户无感”不等于忽略错误。系统必须避免以错误编码继续翻译并生成乱码输出。

### 7.2 探测流程

按以下顺序处理：

1. 检查 BOM：
   - UTF-8 BOM
   - UTF-16 LE
   - UTF-16 BE
2. 对无 BOM、偶数字节长度且具有明显奇偶位 NUL 分布的内容，执行 UTF-16 LE/BE 启发式识别；没有足够结构证据时不猜测。
3. 对其余无 BOM 内容执行严格 UTF-8 解码，并要求解码质量检查通过。
4. UTF-8 失败时调用编码探测器生成候选：
   - GB18030 / GBK
   - Big5
   - Shift-JIS
   - EUC-JP
   - EUC-KR
   - Windows-1252
   - UTF-16 变体
5. 对候选编码分别抽样解码。
6. 使用质量评分选出最佳候选。
7. 对最终编码进行完整解码并验证。

PRE-001 已验证并固定首版依赖：

- `chardet@2.2.0`：统计探测与候选置信度。纯 TypeScript、无原生绑定，覆盖首版目标编码。
- `iconv-lite@0.7.2`：候选和最终文本解码。纯 JavaScript，统一 Windows/macOS/Linux 行为。

不使用 Electron/Node `TextDecoder` 作为通用最终解码器。Electron 33 的 Node 20.18.3 运行时虽然接受目标编码标签，但实测 `windows-1252` 的 `0x80`、`0x91` 至 `0x97` 被保留为 C1 控制字符，而不是映射为欧元符号、智能引号和破折号；`iconv-lite` 能正确执行这些映射。`TextDecoder({ fatal: true })` 仍可在实现中作为严格 UTF-8 快路径验证器。

### 7.3 解码质量评分

评分至少检查：

1. Unicode replacement character `�` 数量。
2. NUL 和不可打印控制字符比例。
3. 解码后文本可读字符比例。
4. 目标语言文字范围与探测结果是否明显矛盾。
5. Markdown 结构是否出现异常大量破碎符号。
6. 不同候选之间的分数差。

PRE-001 fixture 验证采用以下初始接受门槛，BE-002 实现时应以常量和测试固化：

1. 解码质量分不低于 `0.82`。
2. 统计探测置信度不低于 `0.55`。
3. 最佳与次佳候选置信度差至少 `0.15`；最佳置信度达到 `0.90` 时可免除差值要求。
4. BOM 和通过质量检查的严格 UTF-8 结果视为确定性结果。
5. 不符合门槛时进入低置信度处理，不自动选择“最像”的编码。

### 7.4 低置信度处理

如果无法得到可靠结果：

1. 不开始模型请求。
2. 任务进入 `failed`，错误阶段记录为 `detecting_encoding`。
3. UI 提示文件可能使用罕见编码或内容已损坏。
4. 在错误详情的高级入口中允许手动选择编码后重新准备。

手动覆盖是异常恢复能力，不是正常配置项。

### 7.5 输出编码

所有新输出统一写为 UTF-8，无 BOM。任务元数据记录：

- 原始探测编码。
- 是否有 BOM。
- 探测置信度。
- 是否使用过手动覆盖。

---

## 8. 文本结构解析与分片

### 8.1 中间表示

无论 TXT 还是 Markdown，先解析为统一的可翻译单元：

```ts
interface TranslationUnit {
  unitId: string;
  fileId: string;
  order: number;
  kind:
    | "paragraph"
    | "heading"
    | "list_item"
    | "blockquote"
    | "table_cell"
    | "plain_text"
    | "protected";
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  prefix?: string;
  suffix?: string;
  translatable: boolean;
  structuralContext?: {
    headingPath?: string[];
    listDepth?: number;
    quoteDepth?: number;
    tableId?: string;
  };
}
```

`sourceStart` / `sourceEnd` 指向规范化换行后的解码文本。最终组装时使用这些位置进行局部替换或插入。

### 8.2 TXT 解析

规则：

1. 空行分隔自然段。
2. 连续非空行默认视为同一段落，保留内部换行信息。
3. 明显章节标题单独成为 unit，但不依赖标题识别才能正确工作。
4. 超长段落按句子边界拆成多个 unit。
5. 仍超长时按标点和软换行拆分。
6. 最后才允许 token 硬切，并记录“段内硬切”标记供上下文处理。

### 8.3 Markdown 解析

使用支持 GFM 和源码位置信息的 Markdown AST 解析器。保护节点：

- YAML/TOML frontmatter。
- fenced code block。
- indented code block。
- inline code。
- URL、autolink、链接目标。
- 图片地址。
- HTML block 和 inline HTML。
- 数学公式（如解析器识别）。
- 分隔线和纯结构标记。

可翻译节点：

- heading 文本。
- paragraph 文本。
- list item 内的自然语言。
- blockquote 内的自然语言。
- table cell 文本。
- link label 和 image alt 文本，可作为高级选项；首版默认翻译 label/alt、保护目标地址。

PRE-002 已验证并固定首版解析依赖：

- `unified@11.0.5`
- `remark-parse@11.0.0`
- `remark-gfm@4.0.1`
- `remark-frontmatter@5.0.0`
- `@types/mdast@4.0.4`（开发依赖）

该组合与应用现有 `react-markdown@10 + remark-gfm@4` 渲染管线属于同一 Unified/mdast 生态，能够为 GFM 表格、任务列表、删除线、YAML/TOML frontmatter 和 CommonMark 节点提供稳定的 `position.start.offset` / `position.end.offset`。

位置 offset 是 JavaScript 字符串的 UTF-16 code unit 索引。解析、替换和组装必须始终基于同一个已规范化字符串，并使用 `slice()` 从后向前应用变更；这样即使文本包含 emoji 等代理对字符，也不会发生偏移漂移。

图片 alt 是一个已确认的特殊情况：mdast `image` / `imageReference` 节点暴露 `alt` 值和整个图片源码位置，但不会为 alt 创建独立子节点。MD-001 需要在该节点的受控源码范围内，用支持转义符和嵌套方括号的小型扫描器定位 alt span；不得替换整个 image 节点，也不得修改图片地址。

### 8.4 Markdown 格式保真

实现不得把 AST 重新完整序列化为 Markdown。推荐：

1. AST 只负责识别节点、层级和源码位置。
2. 对源文本建立从后向前的 replacement / insertion 操作列表。
3. 仅译文模式替换可翻译范围。
4. 双语模式在原始块结束位置插入引用格式译文。
5. 未参与翻译的字符保持逐字节等价的文本形式，换行规范化除外。

这能减少列表缩进、空行、强调符号、链接格式和用户自定义排版被重写的风险。

PRE-002 已验证以下插入契约能被 `ReactMarkdown + remark-gfm + remark-frontmatter` 正确解析：

1. 标题、普通段落：原块后插入一个同级 blockquote。
2. 列表：把整个列表视为一个翻译块，原列表后插入“包含译文列表的 blockquote”；不在每个原 list item 内分别插入，避免缩进归属和序号错乱。
3. 原 blockquote：译文使用比原文多一层的引用深度，使其成为单独的嵌套译文引用块。
4. 表格：保留完整原表格，在其后插入“包含同列数译文表格的 blockquote”，并保持原对齐方式。
5. code、HTML、frontmatter、thematic break 等保护块不插入空译文块。
6. 无法安全生成完整翻译结构时保留原块并记录 warning，不能退化为破坏原 Markdown 的局部拼接。

### 8.5 分片规划

分片是一个或多个连续 `TranslationUnit` 的集合：

```ts
interface TranslationSegment {
  segmentId: string;
  fileId: string;
  indexInFile: number;
  globalIndex: number;
  unitIds: string[];
  sourceTokenCount: number;
  sourceTextSnapshotPath: string;
  startsMidUnit: boolean;
  endsMidUnit: boolean;
}
```

规划原则：

1. 不跨文件组成一个模型请求。
2. 优先在章节标题、空行和块边界处分片。
3. 不拆开 Markdown 代码块或其它保护节点。
4. 不拆开短段落。
5. 单个超长段落允许在句子边界拆分。
6. 分片规划结果一旦任务启动即冻结并落盘。
7. 恢复时不重新依赖当前算法生成分片，而是直接使用工作区中已冻结的 segment 数据。

---

## 9. 两种执行模式

### 9.1 快速并发模式

特点：

1. 多个分片受控并发。
2. 分片不依赖前一片的译文结果。
3. 每片携带相同的全局翻译要求、术语表和文档背景。
4. 可携带有限的相邻原文窗口或章节路径作为静态参考。
5. 任意分片可以独立重试和恢复。

适合：

- 技术文档。
- 多篇独立文章。
- 上下文依赖较弱的内容。
- 用户更关注速度的场景。

一致性增强：

1. 项目开始前可选执行一次轻量“全局分析”，从目录、标题和抽样文本生成初始术语/风格提示。
2. 用户提供的术语表始终优先于模型推断。
3. 并发分片不得并发修改共享语义记忆。

首版建议不自动增加一次昂贵的全文预分析请求；只使用用户输入、结构元数据和有限抽样。后续可增加可选的预分析阶段。

### 9.2 连贯串行模式

严格按以下顺序执行：

```text
项目文件顺序
  -> 文件内 segment 顺序
```

每片请求包含：

1. 固定系统翻译规则。
2. 用户文档背景、翻译要求、风格要求。
3. 用户术语表。
4. 当前语义记忆。
5. 最近一片或有限窗口的原文与译文尾部。
6. 当前分片。

模型需要返回：

```ts
interface SequentialTranslationResponse {
  translatedText: string;
  memoryPatch: SemanticMemoryPatch;
}
```

该接口是领域层结果，不代表线上必须使用单个 JSON 对象。PRE-003 已验证并固定首版线协议：

1. 普通并发翻译返回纯译文文本。
2. 串行翻译使用每次请求动态生成的边界标记：

```text
<<<FUSIONKIT_TRANSLATION:segment-42>>>
译文正文
<<<FUSIONKIT_MEMORY_PATCH:segment-42>>>
{"currentSceneSummary":"..."}
<<<FUSIONKIT_END:segment-42>>>
```

3. 边界 ID 只允许字母、数字、`_`、`-`，并与当前 segment/request 绑定。
4. 三个边界必须各出现一次、顺序正确，边界前后不得有额外内容。
5. `memoryPatch` 区域使用严格 JSON 和固定 schema；译文区域不要求 JSON 转义。
6. 如果边界、译文、finish reason 或占位符无效，整个响应失败并重试。
7. 如果仅 `memoryPatch` 无效，但译文已通过其他完整性检查，则允许“译文成功、记忆未更新”，记录警告且禁止推进稳定记忆版本。

PRE-003 实测部分 OpenAI Compatible 服务会拒绝 `response_format`，而动态边界文本仍能通过普通 chat completions 返回。首版因此不依赖 JSON Schema、tool calling 或厂商私有结构化输出字段；未来可把结构化输出作为经过 capability probe 后的可选优化，但不能改变上述降级语义。

### 9.3 串行恢复规则

串行语义具有依赖链，因此：

1. 正常恢复从第一个未完成 segment 继续。
2. 每个已完成 segment 记录其输入 `memoryVersion` 和输出 `memoryVersion`。
3. 工作区保存最近稳定记忆和周期性快照。
4. 如果重翻某个已完成 segment，该 segment 之后的所有译文默认标记为 `stale`。
5. 用户必须选择：
   - 从该 segment 开始重新串行翻译后续内容。
   - 放弃重翻并继续使用原依赖链。
6. 不允许只替换中间一片后继续把旧后续译文视为完全一致。

---

## 10. 串行语义记忆

### 10.1 记忆结构

建议采用结构化记忆：

```ts
interface SemanticMemory {
  schemaVersion: 1;
  version: number;
  updatedAfterSegmentId?: string;

  documentSummary: string;
  currentChapterSummary: string;
  currentSceneSummary: string;

  characters: Array<{
    sourceName: string;
    translatedName: string;
    aliases?: string[];
    description?: string;
    relationships?: string[];
    pronounOrGenderNotes?: string;
  }>;

  terminology: Array<{
    source: string;
    target: string;
    note?: string;
    origin: "user" | "model";
  }>;

  styleRules: string[];
  unresolvedContext: string[];
  recentContinuityNotes: string[];
}
```

用户术语表不允许被模型覆盖。模型产生冲突译法时：

1. 继续使用用户术语。
2. 记录冲突警告。
3. 不把冲突写入有效记忆。

`SemanticMemoryPatch` 不采用开放式 RFC 6902 JSON Patch，也不允许模型直接修改 `schemaVersion`、`version` 或术语 `origin`。首版只接受以下受限操作：

- 替换文档、章节和当前场景摘要。
- `characterUpserts`。
- `terminologyUpserts`，合并时统一视为模型来源。
- 追加 style rules、未决上下文和近期连贯性备注。
- 按内容标识已解决的未决上下文。

每个字符串长度和数组项目数必须有上限。Patch 的 schema 验证与实际合并分离：解析成功不代表允许覆盖用户术语，最终冲突规则由 memory manager 执行。

### 10.2 三级上下文

串行请求上下文分为：

1. 长期记忆：
   - 文档概要。
   - 人物和世界观。
   - 术语。
   - 文风规则。
2. 章节/场景记忆：
   - 当前章节摘要。
   - 当前场景人物、地点和事件。
   - 未闭合语义。
3. 近期窗口：
   - 上一片末尾原文。
   - 上一片末尾译文。

### 10.3 Token 上限

用户可配置 `semanticMemoryTokenLimit`，默认 `8192`。

实际记忆预算：

```text
effectiveMemoryBudget =
  min(
    semanticMemoryTokenLimit,
    modelContextTokenLimit
      - systemAndInstructionsTokens
      - glossaryTokens
      - currentSegmentTokens
      - recentWindowTokens
      - outputTokenReserve
      - safetyMargin
  )
```

建议 `safetyMargin` 至少为上下文窗口的 5%，并设置固定最小值。

如果预算不足：

1. 用户术语表和显式规则优先级最高，不能被自动删除。
2. 保留当前章节/场景和未闭合语义。
3. 压缩长期概要。
4. 截断低优先级旧事件。
5. 最后缩短近期窗口。

如果固定内容和当前分片已超过模型上下文窗口：

1. 自动降低当前分片大小并重新规划尚未开始的 segment，仅限任务正式开始前的准备阶段。
2. 任务开始并冻结规划后，不静默修改分片；应报配置错误并允许用户创建新任务。

### 10.4 记忆压缩

记忆超过上限时，通过独立压缩步骤生成更短的结构化记忆。为避免每片额外产生一次模型请求：

1. 正常分片响应返回 `memoryPatch`。
2. 本地合并 patch。
3. 只有合并后的记忆超过阈值时才执行压缩请求。
4. 压缩前保存快照。
5. 压缩失败时保留旧稳定记忆并缩短近期窗口，不得丢失恢复能力。

建议阈值：

```text
达到 memory token 上限的 90% 时压缩
```

### 10.5 快照策略

保存：

- `latest.json`：最新稳定记忆。
- 每个文件结束快照。
- 每 N 个 segment 的周期快照，建议默认 N=10。
- 记忆压缩前快照。

快照用于：

- 应用异常退出恢复。
- 从中间 segment 重新翻译。
- 排查模型何时改变术语或人物关系。

---

## 11. 模型请求与响应契约

### 11.1 模型客户端

建议提取新的通用 OpenAI Compatible 客户端，而不是复制字幕 `axios.post`：

```text
electron/main/ai/openai-compatible-client.ts
```

职责：

- 统一 endpoint。
- Authorization。
- proxy。
- AbortSignal。
- 超时。
- 重试分类。
- think 标签清理。
- usage 提取。
- finish reason 检查。
- 错误脱敏。

字幕翻译迁移到该客户端不属于本期硬性范围，但新模块不应继续复制一套散落的请求逻辑。

### 11.2 Prompt 输入

当前分片应使用明确的边界标记，避免模型把上下文重新翻译：

```text
<translation_instructions>...</translation_instructions>
<glossary>...</glossary>
<semantic_memory>...</semantic_memory>
<recent_context>...</recent_context>
<content_to_translate>...</content_to_translate>
```

Prompt 必须强调：

1. 只翻译 `content_to_translate`。
2. 上下文仅用于一致性。
3. 不添加解释、Markdown 代码围栏或额外前后缀。
4. 不修改保护占位符。
5. 返回结构必须符合当前模式。

### 11.3 Markdown 占位符

在发送模型前，把 URL、代码、HTML 等保护内容替换成任务内唯一占位符，例如：

```text
⟦FKP:segmentId:0001⟧
```

返回后必须验证：

1. 占位符数量一致。
2. 每个占位符只出现一次。
3. 顺序满足当前结构要求。
4. 没有未知占位符。

验证失败：

1. 用更强约束 prompt 重试。
2. 达到重试上限后该 segment 失败。
3. 不写入不可信译文。

### 11.4 响应完整性

检查：

1. 返回非空。
2. 清理响应开头的 `<think>...</think>`；OpenAI Compatible 的独立 `reasoning_content` 不得混入译文。
3. `finish_reason` 不是长度截断；如被截断则按可重试错误处理。
4. 占位符完整。
5. 串行响应的动态边界唯一且顺序正确。
6. 结构化记忆 patch 可解析；仅 patch 失败时不得更新记忆，但可保留已验证译文。
7. `usage` 允许缺失，缺失时保留空值并继续执行，不伪造 token 数。
8. 翻译长度没有明显异常。异常比例只触发警告或重试，不能作为唯一失败依据。

占位符加强约束重试必须明确列出当前片期望的完整占位符序列，要求逐字复制、各出现一次并保持顺序，同时再次禁止解释文字和代码围栏。

### 11.5 重试分类

可重试：

- 网络超时。
- 连接重置。
- HTTP 408、429、部分 5xx。
- 空响应。
- 长度截断。
- 结构或占位符校验失败。

不可直接重试：

- 401/403。
- endpoint 或模型明确不存在。
- 本地文件不可读。
- 工作区不可写。
- 配置无法满足上下文预算。

采用指数退避和抖动，并尊重 `Retry-After`。

---

## 12. 全局并发与调度

存在两层调度：

1. 文件/项目任务队列。
2. 单任务内的 segment 调度。

如果每层独立设置并发，可能出现：

```text
5 个文件任务 × 每个 5 个 segment = 25 个瞬时请求
```

因此主进程必须设置全局模型请求信号量：

```ts
interface TranslationRequestScheduler {
  acquire(taskId: string, priority: number): Promise<Release>;
  cancelWaiting(taskId: string): void;
}
```

建议默认全局上限为 5，可在后续高级设置中配置。

规则：

1. 并发模式每个任务默认最多占 3 个槽位。
2. 串行模式每个任务同时只占 1 个槽位。
3. 多任务之间使用轮转或公平队列，避免一个大项目长期占满全部槽位。
4. 429 频繁出现时可暂时降低动态并发；首版至少应支持基于重试等待释放槽位。
5. 取消任务时同时取消等待中的请求和执行中的 AbortController。

---

## 13. 工作区与持久化

### 13.1 工作区位置

运行数据不应默认混入用户输出目录。建议存储于 Electron `userData`：

```text
<userData>/text-translation/tasks/<taskId>/
```

失败时 UI 可导出恢复包或打开工作区。最终输出仍写入用户选择的目录。

### 13.2 目录结构

```text
<taskId>/
  task.json
  files.ndjson
  units/
    <fileId>.ndjson
  segments/
    index.ndjson
    source/
      00000001.txt
      00000002.txt
  results/
    00000001.txt
    00000002.txt
  memory/
    latest.json
    snapshots/
      00000010.json
      file-<fileId>.json
  events.ndjson
  metrics.json
  locks/
    active.lock
```

### 13.3 为什么不用单个大型 JSON

整本小说可能包含数千个 unit 和 segment。每片完成时重写整个 JSON 会：

- 放大磁盘写入。
- 增加峰值内存。
- 增加原子 rename 的文件体积。
- 提高意外退出时的损坏窗口。

因此：

- 不可变索引使用 NDJSON。
- 大文本分片和译文使用独立文件。
- 小型状态使用原子写 JSON。
- 事件使用 append-only NDJSON。

PRE-004 对 10,000 segment 的工作区模型验证显示：

- `segments/index.ndjson` 约 0.88 MB。
- 单片完成只需要写独立 result 文件和一行 event，样例约 `12,000 + 217` bytes。
- 对照的单体 JSON manifest 即使不内嵌全部源文，也约 1.15 MB，且每片完成都会重写。

因此正式实现中，segment 完成路径不得更新包含全部 segment 的大型 manifest。`task.json` 只更新小型计数和状态，必要时可做低频状态快照。

### 13.4 `task.json`

只保存小型元数据：

```ts
interface PersistedTextTranslationTask {
  schemaVersion: 1;
  taskId: string;
  projectId?: string;
  status: TextTranslationTaskStatus;
  phase: TextTranslationPhase;
  options: TextTranslationOptionsWithoutSecrets;
  sourceFingerprint: SourceFingerprint[];
  segmentCount: number;
  completedSegmentCount: number;
  failedSegmentIds: string[];
  staleFromSegmentId?: string;
  createdAt: string;
  updatedAt: string;
}
```

不保存：

- API Key。
- Authorization header。
- 完整模型 profile。

可保存：

- 模型 key。
- endpoint 的脱敏标识或 profile id。
- 每片实际使用模型，供排查。

### 13.5 Segment 状态

每个 segment 的状态事件追加到 `events.ndjson`：

```ts
type SegmentEvent =
  | { type: "segment_started"; segmentId: string; at: string }
  | { type: "segment_completed"; segmentId: string; resultPath: string; memoryVersion?: number; usage?: Usage; at: string }
  | { type: "segment_failed"; segmentId: string; errorCode: string; at: string }
  | { type: "segment_stale"; segmentId: string; reason: string; at: string };
```

恢复时通过不可变 segment 索引和事件日志重建状态。为提高启动速度，可以周期性生成小型状态快照，但事件日志仍是审计依据。

### 13.6 原子写入

以下文件必须使用“临时文件 → fsync（可行时）→ rename”：

- `task.json`
- `memory/latest.json`
- 记忆快照。
- 单个 segment 结果。
- 最终输出文件。

---

## 14. 任务生命周期

### 14.1 阶段

```ts
type TextTranslationPhase =
  | "idle"
  | "inspecting_files"
  | "detecting_encoding"
  | "parsing"
  | "planning_segments"
  | "estimating"
  | "translating"
  | "assembling_outputs"
  | "completed";
```

### 14.2 首次执行

1. Renderer 创建任务，请求只包含路径和配置。
2. 主进程生成 `taskId` 和工作区。
3. 检查文件元数据与扩展名。
4. 自动探测编码并解码。
5. 解析 TXT / Markdown。
6. 生成 unit 和冻结 segment 计划。
7. 计算 token / 费用预估。
8. 写入任务元数据与不可变索引。
9. 按模式执行 segment。
10. 每片成功后原子写结果并追加事件。
11. 串行模式同步写稳定语义记忆。
12. 全部分片完成后按文件组装输出。
13. 原子写最终文件并标记 completed。

### 14.3 暂停、取消和失败

#### 暂停

首版可将暂停实现为：

1. 不再启动新请求。
2. 等待当前请求完成，或用户选择立即中止。
3. 状态保存为 `paused`。
4. 恢复时从第一个未完成 segment 继续。

#### 取消

1. 中止执行中的请求。
2. 取消调度器中的等待请求。
3. 保留工作区和已完成结果。
4. 标记 `cancelled`，允许后续恢复或删除。

#### 失败

1. 当前 segment 写失败事件。
2. 并发模式可配置首版行为：
   - 推荐默认继续处理其它独立 segment；存在成功结果但未全部完成时，最终任务为 `partially_completed`。
3. 串行模式当前 segment 失败后必须停止后续 segment。
4. 保留所有已完成结果和工作区。

### 14.4 恢复

应用启动或用户打开恢复入口时：

1. 扫描 `<userData>/text-translation/tasks/`。
2. 忽略 completed 且已按策略清理的任务。
3. 校验 `task.json` schema。
4. 校验 segment 源快照和结果文件。
5. 检查源文件：
   - 源文件仍存在且 fingerprint 一致：正常恢复。
   - 源文件缺失或已变化：仍可使用工作区冻结的源 segment 完成翻译，但输出路径和风险需提示。
6. 使用当前任务模型 profile 的凭据继续，不从磁盘恢复 API Key。

### 14.5 重启与配置变化

允许恢复时变化：

- API Key。
- endpoint。
- 模型 key。
- 全局并发限制。
- segment 并发限制。
- 输出冲突策略。

默认不允许直接变化：

- 源/目标语言。
- 输出模式。
- 文件顺序。
- 分片计划。
- 用户术语表。
- 翻译要求和风格要求。
- 串行记忆 token 上限。

需要改变这些语义配置时，创建新任务，避免混合不同契约的结果。

---

## 15. 输出组装

### 15.1 TXT

仅译文：

1. 按 unit 顺序替换可翻译文本。
2. 恢复原段落分隔和受保护文本。
3. 对段内硬切的多个 segment 无额外空行拼接。

双语：

1. 每个自然块保留原文。
2. 紧跟译文。
3. 保持原块之间的相对空白。
4. 不把分片边界暴露到最终文件。

### 15.2 Markdown

仅译文：

1. 用译文替换可翻译源码范围。
2. 还原保护占位符。
3. 保持 Markdown 标记、URL 和代码不变。

双语：

1. 原始块不变。
2. 在块后插入译文 blockquote。
3. 对多行译文的每一行增加正确引用前缀。
4. 根据原块缩进处理列表内部插入，确保引用属于正确列表项或在安全位置脱离列表。
5. 表格作为整体可翻译块：保留原表格，在其后追加包含译文表格的 blockquote，并保持原行列顺序；不在原单元格内混入 `<br>` 双语内容。
6. 代码块、HTML、frontmatter 等保护块不追加“空译文”。

### 15.3 部分输出

工作区内允许生成内部预览，但用户输出目录中的正式文件只在对应源文件所有 segment 完成后生成。

对于项目模式：

- 已完整完成的文件可以先生成正式输出。
- 后续文件失败不撤销已完成文件。
- 项目整体状态显示“部分完成”。

---

## 16. Token 与费用预估

### 16.1 预估维度

展示：

- 源文本 token。
- 分片数量。
- 基础 prompt 输入 token。
- 用户术语与指令 token。
- 并发模式预计输入/输出 token。
- 串行模式语义记忆额外输入 token 区间。
- 预计总费用区间。

### 16.2 串行模式为何使用区间

语义记忆会随翻译增长和压缩，准备阶段无法精确知道每片实际记忆长度。因此显示：

```text
最低估计：按初始记忆计算
推荐估计：按平均 50% 记忆上限计算
上限估计：按每片使用完整记忆预算计算
```

实际执行后用模型返回的 usage 更新真实消耗。

### 16.3 小说级预估性能

预估不得在 Renderer 主线程处理整本小说。主进程在分片规划时已经计算 token，应复用该结果，避免重复编码全文。

---

## 17. IPC 契约

所有 channel 使用命名空间，避免与字幕的全局事件冲突。

### 17.1 Renderer -> Main

```text
text-translation:create-task
text-translation:prepare-task
text-translation:start-task
text-translation:pause-task
text-translation:cancel-task
text-translation:resume-task
text-translation:restart-task
text-translation:delete-task
text-translation:list-recoverable-tasks
text-translation:get-task-detail
text-translation:reveal-output
text-translation:reveal-workspace
```

创建任务请求不包含全文：

```ts
interface CreateTextTranslationTaskRequest {
  files: Array<{
    sourcePath: string;
    relativePath?: string;
    order: number;
  }>;
  options: TextTranslationOptions;
  model: {
    profileId?: string;
    apiKey: string;
    modelKey: string;
    endpoint: string;
  };
}
```

主进程持久化前必须剔除 `apiKey`。

### 17.2 Main -> Renderer

```text
text-translation:task-updated
text-translation:progress
text-translation:file-completed
text-translation:task-completed
text-translation:task-failed
text-translation:warning
```

所有事件必须携带：

```ts
{
  taskId: string;
  sequence: number;
  occurredAt: string;
}
```

`sequence` 用于 Renderer 忽略乱序或重复事件。

### 17.3 进度模型

```ts
interface TextTranslationProgress {
  phase: TextTranslationPhase;
  completedFiles: number;
  totalFiles: number;
  completedSegments: number;
  totalSegments: number;
  activeSegmentIds: string[];
  currentFileId?: string;
  estimatedInputTokens?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  percentage: number;
}
```

百分比以完成 segment 数为基础，并对准备和组装阶段保留少量权重。UI 同时显示明确数字，避免长 segment 导致百分比长时间不变时用户误以为卡死。

---

## 18. Renderer 状态与交互设计

### 18.1 Store

建议：

```text
src/store/tools/text/useTextTranslatorStore.ts
src/services/text/textTranslatorQueueService.ts
src/services/text/textTranslatorExecutionService.ts
```

Store 只持久化用户偏好，不持久化小说全文或所有 segment：

- 上次输出路径。
- 默认执行模式。
- 默认输出模式。
- 分片 token 上限。
- 语义记忆 token 上限。
- 模型上下文窗口。
- 并发数。
- 最近使用的翻译要求和风格要求，可考虑隐私开关。

运行时任务由主进程工作区负责持久化，Renderer 启动时查询恢复。

### 18.2 页面布局

建议三块布局：

1. 配置区
   - 语言。
   - 执行模式。
   - 输出模式。
   - 分片和语义记忆。
   - 输出路径。
   - 高级模型上下文预算。
2. 文件/项目区
   - 文件列表。
   - 编码、格式、大小。
   - 拖拽排序。
   - 独立模式 / 有序项目模式。
   - 指定位置重置语义记忆。
3. 任务区
   - 当前阶段。
   - 文件和分片进度。
   - token / 费用。
   - 暂停、取消、恢复、重试。
   - 警告和错误详情。

### 18.3 模式文案

快速并发：

```text
多个分片同时翻译，速度更快。适合独立文章和技术文档，跨段一致性弱于连贯模式。
```

连贯串行：

```text
按顺序翻译并持续维护人物、术语、情节和文风记忆。更适合小说，速度较慢且输入 Token 更多。
```

### 18.4 配置校验

开始前检查：

1. 至少一个文件。
2. 文件扩展名合法。
3. 输出目录可写。
4. 目标语言不同于明确指定的源语言。
5. `sliceTokenLimit` 在安全范围。
6. `semanticMemoryTokenLimit` 为正且小于模型上下文窗口。
7. `modelContextTokenLimit` 足以容纳分片、指令和输出预留。
8. 有序项目模式下文件 order 不重复且已确认。
9. 已配置任务执行模型。

---

## 19. 主进程模块建议

```text
electron/main/text-translation/
  ipc.ts
  types.ts
  text-translation-service.ts
  task-registry.ts
  request-scheduler.ts
  model-client.ts
  input/
    encoding-detector.ts
    file-reader.ts
  parsing/
    text-parser.ts
    markdown-parser.ts
    protected-placeholders.ts
  planning/
    segment-planner.ts
    request-budgeter.ts
    token-counter.ts
  execution/
    parallel-executor.ts
    sequential-context-executor.ts
    retry-policy.ts
  memory/
    semantic-memory-manager.ts
    memory-budget.ts
  persistence/
    workspace-repository.ts
    event-log.ts
    task-recovery.ts
  output/
    text-output-assembler.ts
    markdown-output-assembler.ts
```

模块边界：

- Parser 不调用模型。
- Planner 不写最终输出。
- Executor 不直接操作 Renderer。
- WorkspaceRepository 不理解 prompt。
- OutputAssembler 只消费冻结的结构和可信结果。
- IPC 层只做参数校验、调用 service 和事件转发。

---

## 20. 性能与资源边界

### 20.1 文件规模

设计目标：

- 单文件支持整本小说规模。
- 多文件项目总文本可明显大于单文件。
- 不把完整译文和所有 segment 同时常驻内存。

PRE-004 实测环境为 macOS arm64、Node v20.19.5、`--expose-gc`。合成 TXT 样本结果：

| 单文件大小 | 读取 | UTF-8 解码 | 64KB 抽样 token 估算 | 分片规划 | segment 数 | 观测 RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 MB | 0.25 ms | 2.27 ms | 7.26 ms | 0.28 ms | 63 | 114.59 MB |
| 10 MB | 1.43 ms | 19.57 ms | 6.10 ms | 1.42 ms | 622 | 135.59 MB |
| 50 MB | 12.32 ms | 93.13 ms | 5.83 ms | 5.43 ms | 3,110 | 247.39 MB |

合成 Markdown 样本结果：

| 单文件大小 | 读取 | UTF-8 解码 | Unified/remark AST parse | AST 节点 | 观测 RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5 MB | 0.56 ms | 7.62 ms | 67,907 ms | 404,150 | 1,463.88 MB |

结论：

1. TXT 的全量读取和解码在 50 MB 级别可接受，但仍应避免同时保留多份全文副本。
2. 准备阶段不得对 10 MB 以上长文同步执行全文精确 BPE tokenization；实测中 10 MB/50 MB 精确计数会进入不可接受等待。首版使用抽样精确计数 + 字节/字符比例估算，正式执行时对单个 segment 再做更精确预算。
3. Markdown AST 成本远高于 TXT。5 MB 代表性 Markdown 已接近 1.5 GB RSS 和 68 秒解析时间，首版必须对 `.md` 设置更低保护阈值。

首版保护：

```text
TXT 单文件软警告：50 MB
TXT 单文件硬限制：200 MB
Markdown 单文件软警告：5 MB
Markdown 单文件硬限制：10 MB
项目总量软警告：200 MB
项目总量硬限制：1 GB
```

硬限制是首版保护，不代表架构目标上限。后续若实现流式 TXT 解析、Markdown 分块解析或 worker 隔离，可通过新的性能验收调高。

### 20.2 内存

目标：

1. 输入读取允许单文件解码为字符串，但不得同时保留多份全文副本。
2. 解析完成后，大型 source segment 写入工作区。
3. 执行阶段按需读取 segment。
4. 结果完成后立即写文件并释放响应对象。
5. Renderer 只接收摘要，不接收全文。

后续可升级为流式 TXT 解析；Markdown AST 通常需要完整文档，因此首版需要为单个超大 Markdown 文件设置合理保护。

准备阶段 token 估算策略：

1. 对文件抽取固定大小样本，默认 64 KB。
2. 使用现有 tokenizer 对样本做精确计数。
3. 按字节数和字符数估算全文 token 区间。
4. 对计划生成的 segment 做局部精确或更高精度估算。
5. UI 明确展示为“估算”，执行后以模型返回 usage 修正。

不得在主进程同步精确 token 化整本小说全文。

### 20.3 磁盘

工作区可能同时保存：

- 冻结源分片。
- 分片译文。
- 记忆快照。
- 最终输出。

开始前估算工作区需求。PRE-004 固定首版公式：

```text
minimumRequiredBytes = sourceBytes * 2 + 64 MB
recommendedAvailableBytes = sourceBytes * 3.5 + 128 MB
```

如果可用空间低于 minimum，准备阶段硬阻断。低于 recommended 但高于 minimum 时允许继续，但必须显示磁盘空间警告。

跨平台检查优先使用 Node `fs.promises.statfs(workspaceRoot)` 并通过 feature detection 包装。若当前平台或文件系统不可用，应退化为软警告，不得伪造可用空间。

### 20.4 日志

不得记录：

- API Key。
- Authorization。
- 完整小说正文。
- 完整模型返回。

错误日志只记录：

- taskId / segmentId。
- HTTP 状态和脱敏错误。
- 长度、token、重试次数。
- 最多有限字符的脱敏预览，默认关闭正文预览。

---

## 21. 安全、隐私与数据清理

1. UI 明确提示文本会发送到用户配置的模型服务。
2. 工作区含原文、译文和语义记忆，属于用户敏感数据。
3. 提供：
   - 删除任务并清理工作区。
   - 工作区清理计划 API。
   - 保留 N 天后清理策略。
   - 缺失或不兼容 metadata 的人工复核策略。
4. 默认建议：
   - 成功任务保留恢复工作区 7 天，到期后可自动清理。
   - 失败/取消/部分完成任务默认不自动清理，30 天后在任务管理中标记为建议清理；高级设置可允许自动清理非成功任务。
5. 删除应只作用于该 `taskId` 的受控工作区，防止路径穿越。
6. 所有从 Renderer 传入的路径都在主进程规范化和验证。
7. 当前实现将自动清理能力收敛在 repository 层：
   - `planWorkspaceCleanup` 只产出 `delete` / `retain` / `review` 计划，不直接删除。
   - `cleanupWorkspaces` 仅删除计划中 `delete` 的成功过期任务。
   - 缺失 `task.json`、不支持 `schemaVersion`、无效 `updatedAt`、非成功过期任务只进入 `review`，不静默删除。
   - UI 默认仍以用户显式删除任务为主，自动触发点等待任务管理或设置页验收后再开放。

---

## 22. 错误与边界场景

必须覆盖：

1. 空文件。
2. 只有代码块或 frontmatter 的 Markdown。
3. 单个段落超过分片上限。
4. 超长单词、URL 或无标点文本。
5. CRLF / LF / CR 混合换行。
6. 编码探测低置信度。
7. 源文件在准备后被修改、移动或删除。
8. 输出目录无权限或空间不足。
9. Markdown 占位符被模型修改或丢失。
10. 模型返回空内容、解释性文字、代码围栏或截断结果。
11. 串行记忆 patch 解析失败。
12. 用户术语与模型记忆冲突。
13. 并发任务部分分片失败。
14. 串行任务中间分片失败。
15. 应用在写结果、写记忆或组装最终文件时退出。
16. 两个同名文件位于不同目录。
17. 多文件项目顺序包含重复或缺失。
18. Markdown 列表、嵌套引用、表格中的双语插入。
19. 文件名中包含 Unicode、特殊符号和多重扩展名。
20. 恢复时模型 profile 已删除或未配置。

---

## 23. 测试与验证策略

### 23.1 单元测试

编码：

- UTF-8 / BOM。
- UTF-16。
- GB18030。
- Big5。
- Shift-JIS。
- Windows-1252。
- 低置信度和乱码拒绝。

解析：

- TXT 段落和句子拆分。
- Markdown 标题、列表、引用、表格。
- 代码、URL、frontmatter 保护。
- source position 和 replacement 正确性。

分片：

- 不超过 token 上限。
- 不拆保护节点。
- 超长段落降级拆分。
- 多文件全局顺序稳定。

记忆：

- patch 合并。
- 用户术语不可覆盖。
- token 预算裁剪。
- 压缩和快照恢复。
- 中间重翻导致后续 stale。

持久化：

- 原子写。
- 事件日志恢复。
- 部分文件缺失。
- schema 不兼容。

输出：

- TXT 仅译文和双语。
- Markdown 仅译文和引用块双语。
- 原始非翻译范围不变化。
- 占位符完整恢复。

### 23.2 集成测试

使用 fake OpenAI Compatible server 模拟：

- 正常翻译。
- 429 + Retry-After。
- 500。
- 超时。
- 空返回。
- finish_reason=length。
- 占位符丢失。
- 非法 memory patch。
- 取消中的请求。

验证：

- 并发上限。
- 多任务公平性。
- 串行顺序。
- 断点恢复不重复请求已完成 segment。
- 串行恢复使用正确 memoryVersion。

### 23.3 Fixtures

建议新增：

```text
test/text-translation/
  fixtures/
    txt/
    markdown/
    encodings/
    novel-project/
```

至少准备：

- 中英日小说章节。
- 多文件章节项目。
- 含 GFM 表格、嵌套列表、链接、图片、代码块的 Markdown。
- 超长无标点段落。
- 各编码样例。
- 应用中断后的工作区快照。

### 23.4 性能测试

验证：

1. 1 MB、10 MB、50 MB TXT 的准备耗时和峰值内存。
2. 大型 Markdown 的 AST 解析峰值内存。
3. 数千 segment 的工作区恢复速度。
4. 每完成一片时磁盘写入量不随任务总大小线性放大。
5. Renderer 不接收大正文 payload。
6. 多任务并发不超过全局限制。

### 23.5 手工验收

1. 单个 TXT 并发仅译文。
2. 单个 TXT 串行双语。
3. 单个 Markdown 并发仅译文。
4. Markdown 双语引用块格式。
5. 多章节小说按顺序共享记忆。
6. 人名和术语跨文件一致。
7. 中途取消后恢复。
8. 应用退出后恢复。
9. 源文件删除后从冻结分片恢复。
10. GB18030 / Shift-JIS 文件无需用户设置即可正确翻译。

---

## 24. 发布与兼容策略

1. 新模块和字幕翻译并存，不改变现有字幕任务和恢复 schema。
2. 工作区使用独立目录和 `schemaVersion`。
3. 首版可标记 Beta，并在 UI 说明：
   - Markdown 会保护复杂结构。
   - 极复杂 Markdown 建议检查输出。
   - 串行模式更慢且费用更高。
4. 如工作区 schema 升级：
   - 支持只读识别旧任务。
   - 能迁移则迁移。
   - 不能迁移时允许导出已完成译文，不静默删除。
   - 清理策略遇到未知 `schemaVersion` 时只标记 `review`，不会自动删除。
5. 新工具的路由、i18n 和工具 metadata 不影响现有工具入口。

---

## 25. HomeAgent 后续接入备忘

本期不设计或实现 HomeAgent 工作包，但后续接入时应复用同一个主进程任务服务，不创建第二套翻译逻辑。

预留原则：

1. `create-task` 请求和任务状态查询使用稳定 DTO。
2. HomeAgent 只传文件路径、顺序和用户明确的配置，不传全文。
3. 模糊表达必须区分：
   - 字幕内容翻译。
   - 文件名翻译。
   - 长文本内容翻译。
4. 有序小说项目需要 Agent 明确展示文件顺序或要求用户确认。
5. 长时间、高费用任务在自动执行模式下也应先展示预估和配置摘要。
6. 后续可增加工具：
   - `inspect_text_translation_files`
   - `create_text_translation_task`
   - `start_text_translation_task`
   - `resume_text_translation_task`
7. HomeAgent 接入必须单独创建 feat/design 文档和执行计划，不混入本期实现状态。

---

## 26. 明确排除与待执行计划确定项

### 26.1 已明确排除

- HomeAgent。
- DOCX / PDF / EPUB。
- 跨项目翻译记忆库。
- 人工段落审校编辑器。
- 云同步。

### 26.2 技术验证状态

已完成：

1. PRE-001：固定 `chardet + iconv-lite` 编码探测与解码组合。
2. PRE-002：固定 Unified/mdast 解析组合、源码位置策略，以及列表/引用/表格双语 blockquote 契约。
3. PRE-003：固定普通译文文本与串行动态边界协议、受限 `memoryPatch` schema、非法 patch 降级边界，以及可复用 Fake OpenAI Compatible Server。
4. PRE-004：固定小说级资源边界、工作区布局、磁盘空间估算公式、成功任务 7 天保留策略和跨平台 `statfs` 降级策略。

后续实现阶段状态：

1. MEM-001 至 MEM-004 已落地语义记忆模型、预算、快照、patch、压缩、串行 executor、恢复和 stale 契约。
2. DOC-002 已落地 repository 层清理计划/执行 API、成功任务 7 天保留、非成功任务 30 天人工复核、缺失 metadata 和旧 schema 保护。
3. TXT 端到端能力已完成；Markdown parser、placeholder、输出组装器、执行响应协议和 parallel target-only/bilingual 主进程 E2E 已完成，并支持冻结 source 后在源文件缺失时恢复。
4. 2026-06-24 已新增 `fix/2026-06-24_long_text_translator_markdown-e2e-gap.md`，`MD-004`/`MD-005` 已完成，Execution Plan 仍需继续推进 `MD-006`、`FE-005`、`QA-MD-001`、`DOC-MD-001`。
5. `QA-001` 至 `QA-003` 仍是发布候选验收入口，但应等待 Markdown E2E 补齐后再作为整体收口。

后续工作不得静默改变本文的核心用户契约；如必须改变，应先更新 Final Design 和执行计划。

---

## 27. 建议实施顺序

本文不作为执行计划，以下仅定义架构优先级：

1. 先完成编码探测、TXT 解析、工作区和单文件仅译文最小闭环。
2. 再完成并发调度、失败恢复和费用统计。
3. 再完成串行语义记忆和小说项目模式。
4. 再完成 Markdown 结构保护和两种输出模式。
5. 最后完成 QA 自动化、性能测试、跨平台手工验收和真实模型验证。

正式开发前应基于本文创建：

```text
docs/v0.2.10/text-translator/long_text_translator_execution_plan.md
docs/v0.2.10/text-translator/long_text_translator_implementation_records/
```

执行计划需要拆分 `PRE`、`CORE`、`BE`、`FE`、`QA`、`DOC` 工作包，并建立进度台账。
