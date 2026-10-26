# workbench 设计

本文只详细设计当前增量 I1。

**设计依据**

- 项目 UI 约定：`.agents/skills/fusionkit-ui-design/SKILL.md` 与 `references/visual-contract.md`。
- 同类页面：字幕格式转换器 `src/pages/Tools/Subtitle/SubtitleConverter/index.tsx`、字幕工作台的转写队列 `src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.tsx`、长文本翻译页（上传与拖放的组合方式）。
- 本 Skill 的前端质量流程：先定设计基准，初版完成后实际渲染、审查、修复、复验。实现阶段使用 `fusionkit-ui-design` 项目 Skill 与 `qiuye-ui-quality` 做渲染审查。

2026-10-26 评审的结论已并入本文，对照表见 [records/spec-review-2026-10-26.md](../../records/spec-review-2026-10-26.md)。

## 现状与约束

**工具注册与目录**

- `src/pages/Tools/_shared/toolMeta.ts`：`ToolKey` 是封闭的联合类型，`category` 只有 `subtitle|rename|text`。
- `src/index.css`：工具色 `--tool-*` 的亮色定义在第 44–49 行，暗色在第 86–91 行。
- `src/pages/Tools/index.tsx`：
  - 已有精选、经典、实验三个分区，头部计数等于三者之和；
  - 代码中 `EXPERIMENTAL_TOOLS` 在第 29 行，`type FeaturedItem` 在第 34 行；
  - 路由在 `src/App.tsx`，标题映射在 `src/constants/router.ts` 的 `ToolNameMap`。

**会被牵动的测试**

| 测试 | 约束 |
| --- | --- |
| `src/agent/capability-catalog.test.ts` | 按源码文本切出 `const CLASSIC_TOOLS:` 到 `const EXPERIMENTAL_TOOLS:`、`const FEATURED_TOOLS =` 到 `const Tools:` 两段，统计其中的 `id`（共 7 项） |
| `test/e2e.spec.ts` | 经典网格恰好两行；实验分区只有 `textTranslator` |
| `test/tool-navigation.electron.test.ts` | 访问 `ToolNameMap` 的每个键，等待 `[data-slot=tool-detail-layout]` 和唯一的 h1 |
| `toolBooleanControlConsumers.test.ts` | Checkbox 白名单 |
| `segmentedControlConsumers.test.ts` | 不允许手写按钮组 |

**可复用组件**

- `src/pages/Tools/_shared/ui/` 中：
  - `ToolDetailLayout`：配置列 320px，aside 为 `lg:sticky lg:top-10`，主区 gap 12px；
  - `ToolConfigPanel`、`ToolField`、`ToolRadioButtonGroup`、`ToolSwitchRow`、`ToolConfigDivider`、`ToolConfigDisclosure`、`ToolOutputPathPicker`（`value` + `onSelect`）；
  - `ToolFilePickerSurface`（props：`title`、`description`、`actionLabel`、`icon`、`secondaryAction`、`layout: horizontal|stacked`、`disabled`、`dragging`、`onSelect`）；
  - `useToolFileDropTarget({label, onDrop, disabled, enabled, pageWide})`；
  - `ToolSummaryLine`、`ToolStatBar`、`ToolPanel`；
  - `ToolPageHeader`、`ToolBadge`。
- 注意：`ToolFileDropZone` 点击时打开的是渲染进程里的 `<input type=file>`，不符合「选择文件走主进程对话框」的要求，所以不用它。
- 字幕工作台中：`StudioTaskQueueRow`（`name`、`icon`、`actions`、`metadata`、`progress?`、`children`；原生 `<progress>`）、`StudioFileName`、`StudioIconButton`。visual-contract 已把 `StudioTaskQueueRow` 定为共享的队列行。
- 其他：`ErrorDetailModal`、`ConfirmDialog`、`select.tsx`、`tooltip.tsx`。`src/components/ui/progress.tsx` 不把 `value` 传给 Radix Root，也没有不确定状态，因此不用。

**状态管理**

参照字幕工作台转写的做法：主进程推送事件，渲染进程用模块单例加 `useSyncExternalStore`，离开页面后任务继续。

**其他**

- i18n 有四种语言。新命名空间要在 `src/i18n/constants.ts` 与 `src/i18n/resources.ts` 中登记。磁贴的 `t(item.titleKey)` 和底部导航的 `t(currentToolName)` 只能靠 `scripts/i18n-usage-manifest.mjs` 中登记的键来检查。
- 窗口最小 786×540，默认 1080×786。浮动的 `AgentDock` 出现在所有非首页路由上。

## 方案与取舍

### 设计基准

**用户与流程**

- **目标用户**：个人用户，偶尔到每周几次，以单次批量处理为主。
- **首要操作**：拖入文件 → 确认档位 → 全部开始。
- **主流程**：
  1. 进入页面：Windows 上左侧是设置，右侧是上传区。
  2. 拖入或选择文件。列表中逐个显示「分析中」，然后显示媒体信息。
  3. 默认任务是「压缩视频 · 均衡」。输出编码默认取快照的 `defaults.compressCodec`：有 HEVC 硬件编码器时为 HEVC，否则为 H.264；AV1 由用户主动选择。会丢内容的条目直接显示一行警告。
  4. 点「全部开始」。如果有会丢内容的条目，或有损转无损的条目，或选择了覆盖，先在确认框中列出，可以一键「改为 MKV」。
  5. 行内显示进度、倍速、剩余时间。离开页面后任务继续。
  6. 完成后显示体积变化和「在文件夹中显示」。
- **失败与恢复**：
  - 失败的行可以查看详情，并重试；
  - 已跳过的行说明原因，并提供「仍然转换」；
  - 「当前任务不适用」的行提供一键切换任务；
  - 引擎不可用时，页头说明原因，并提供「重新检测」。
- **数据来源**：`window.mediaConverter`（通道表见 engine design §8）。界面偏好在渲染进程中持久化；队列选项来自快照。

**视觉参照**

- **页面骨架**照搬 SubtitleConverter：`ToolDetailLayout` + `ToolPageHeader` + 左侧 `ToolConfigPanel` + 主区「上传区 + 队列 `ToolPanel`」。
- **上传**参照长文本翻译与字幕工作台转写：`ToolFilePickerSurface`（点击后调用 `controller.pickFiles(filter)`；`secondaryAction` 是一个小菜单，可选视频、音频、全部），加上页面级的 `useToolFileDropTarget({pageWide:true, label, onDrop})`。
- **队列行**用 `StudioTaskQueueRow` 实现，与转写队列和翻译任务一致：透明行、8px 内边距、28px 幽灵图标按钮、只在运行或排队时显示 4px 进度条。
- **尺度**沿用 visual-contract 的当前基线：
  - 面板：SmoothCorners 16 / 0.72；
  - 上传区：18 / 0.74；
  - 配置正文 12px，字段组之间 16px；
  - 配置标题约 11px，面板标题约 13.5px。
- **工具色**：新增 `--tool-media`。亮色暂定 `oklch(0.62 0.15 335)`（品红），暗色亮度约 0.72。这个色相避开了 destructive 红色（0–50°）、翻译器的橙色和重命名的紫色（290）。渲染审查时，要把它放在失败行旁边，确认两种主题下都不像错误色。
- **图标**：lucide `FileVideo2`，备选 `Film`。`Clapperboard` 已被本地字幕转写使用。

**布局与空间**

桌面端（≥1024px）：

```
┌ ToolPageHeader：[图标] 音视频转换 · 描述                  [引擎徽章][?] ┐
├─────────────── 320px ──────┬─────────────── minmax(0,1fr) ─────────────────┤
│ ToolConfigPanel             │ ToolFilePickerSurface（空：stacked 较高；有条目：horizontal 紧凑） │
│  任务 [压缩|转换|提取]        │ ToolSummaryLine：5 个文件 · 3.2 GB · 完成 2 · 节省 1.1 GB │
│  压缩档位 [画质|均衡|体积]    │ ToolPanel「队列」[全部开始][全部取消][清除已完成] │
│  输出编码 [最小体积|苹果|兼容] │  StudioTaskQueueRow：图标 文件名…  [操作]       │
│   └ 兼容性说明（1–2 行）       │    元数据 chips · ⚠ 一行损失警告（如有）         │
│  输出格式 [自动|MP4|MKV]      │    ▬▬▬ 进度条（运行中）· 阶段 · 3.1× · 剩 1:12   │
│  分辨率上限 [Select]          │    ▸ 处理计划（可展开）                         │
│  使用显卡加速  ⏻             │  行（完成）：→ 输出名 · 512 MB → 188 MB −63% [📂] │
│  不比原文件小时丢弃 ⏻        │  行（失败）：原因 [详情][重试]                   │
│ ▸ 输出与性能（ToolConfigDisclosure，必要时折叠）                                │
│   输出位置 / 同名文件 / 低占用模式                                             │
└─────────────────────────────┴───────────────────────────────────────────────┘
```

- **纵向预算**：压缩任务的配置面板粗估 700–740px，aside 是 sticky 的。如果在 1024×700 下实测超过视口，把「输出位置 / 同名文件 / 低占用模式」放进默认折叠的「输出与性能」`ToolConfigDisclosure`，保证面板不被截断。
- **上传区**：没有条目时用 stacked 布局，约 160px；有条目后改为 horizontal，约 72px，空间留给队列。队列随页面一起滚动，没有内层滚动条。
- **窄屏（<1024px）**：与其他队列页一致，主区在前、配置在后（aside 用 `order-2 lg:order-1`），让进度和结果始终在上方。行内的元数据 chips 可以换行，操作按钮保持在右上角。
- **靠角留白**：标题栏右上角的操作按钮、每行右上角的按钮组，按 visual-contract「圆角附近的等距留白」测量。

**组件与状态**

| 区域 | 组件与变体 | 状态 |
| --- | --- | --- |
| 任务选择 | `ToolRadioButtonGroup`（3 项） | 切换时字段淡入淡出（尊重减少动态效果）；未开始的条目重新请求处理计划 |
| 档位、输出编码、输出格式、输出位置、同名文件 | `ToolRadioButtonGroup`；兼容性说明用 `ToolField` 的 hint | 输出编码的标签以用途命名，3 句说明见 AC-WORKBENCH-03-2 |
| 分辨率上限、目标格式、提取格式 | `Select`；目标格式分组 | 默认：保持原始 / MP4 / 保持原音轨 |
| 布尔开关 | `ToolSwitchRow` | 显卡加速不可用时禁用，Tooltip 说明原因，并提示 HEVC/H.264 会自动使用显卡 |
| 输出文件夹 | `ToolOutputPathPicker`（`value` 为显示名，`onSelect` 调用 `pickOutputDirectory`） | 文件夹失效时回退，并弹出 toast |
| 上传 | `ToolFilePickerSurface` + 页面级拖放 | 空 / 紧凑 / 拖入中（`dragging`）/ 禁用（引擎检测中或不可用时，说明原因）；拖入文件夹或临时副本时，行内或 toast 提示原因 |
| 汇总 | `ToolSummaryLine`；节省量用 `ToolStatBar` 的 success 色调 | 没有条目时隐藏 |
| 队列行 | `StudioTaskQueueRow` + 媒体专用的 metadata、actions、children | analyzing、unsupported（附原因与建议）、not_applicable（附「切换到…」）、idle、queued 与 running（各阶段，注明「按开始时的设置处理」）、succeeded、partial、skipped（附「仍然转换」）、failed、cancelled、interrupted、input_changed |
| 进度 | `StudioTaskQueueRow` 的原生 `<progress>` | 时长未知时，在 children 中放一个不带 value 的原生 `<progress>`（不确定状态） |
| 损失警告 | 行内一行 `text-amber` 文字 + 图标 | 只在出现 `*_dropped`、`hdr_tonemapped`、`subtitle_styling_lost`、`downmixed_to_stereo` 时显示 |
| 处理计划 | 行内折叠区，使用 `accordion.tsx` 的样式 | 默认收起；编码器显示友好名称 |
| 开始前确认 | `ConfirmDialog` | 列出会丢内容、有损转无损、将被覆盖（`wouldReplace`）的文件；每项可以「改为 MKV」或「跳过」 |
| 错误详情 | `ErrorDetailModal` | 显示错误码说明，以及脱敏后的 stderr 末尾（等宽字体，可复制） |
| 全部取消 | `ConfirmDialog` | — |
| 引擎徽章 | `ToolBadge` 风格的胶囊 + Tooltip | detecting、ready（列出硬件编码器）、unavailable（显示原因）；点击可以「重新检测」，有硬件编码任务时禁用 |
| 平台不支持（macOS） | `ToolDetailLayout` + `ToolPageHeader` + 一段说明 | 不显示配置与上传区 |

- **键盘与焦点**：所有行操作都是带 `aria-label` 的按钮。Esc 优先级沿用 `useToolPageEscape`：先关闭弹窗、选择器、取消拖入，最后才返回。
- **播报**：完成和失败通过 `aria-live="polite"` 区域播报，例如「vacation.mp4 已完成，节省 63%」。
- **动效**：行的增删沿用列表淡入；上传区在 stacked 与 horizontal 之间切换时，用高度过渡（参照 `motion-recipes` 的 auto-height 案例）。减少动态效果时不做过渡。
- **离开提示**：页面卸载时，如果有任务在运行，`showToast` 提示一次（参照 long-text 的 `useBackgroundNotice`）。

**内容与验收样本**

| 样本 | 用途 |
| --- | --- |
| 普通短名称 `vacation.mp4` | 常规布局 |
| 超长名称，如 `【4K HDR】2026 年家庭聚会 - 第三部分（完整版）final_final_v2.mkv` | 中间省略与 Tooltip |
| 竖屏 1080×1920 HEVC HDR10 小样的元数据 | chips 换行、HDR 标记 |
| 带图形字幕与样式 ASS 的 MKV 小样 | 损失警告、开始前确认、「改为 MKV」 |
| 带封面的纯音频 FLAC | 音频元数据；在「压缩视频」下显示 not_applicable |
| 无法处理的文件（`.txt` 改名为 `.mp4`） | unsupported 行 |
| 30 个条目，混合运行中、完成、失败、跳过、部分完成 | 列表密度与滚动 |
| 英文界面 | 最长标签，如「Smallest size (AV1)」「Discard if not smaller」「Low-usage mode」 |

- **视口**：1280×800、1080×786（默认窗口）、1024×700、786×540（最小窗口），亮色与暗色。786×540 下要把 30 行的队列滚动到底部再看。
- **证据**：以 quiet 模式启动真实 Electron，截图保存到 `records/i1/screenshots/`，并逐项写下观察。

### 渲染进程架构

**控制器** `src/services/media-converter/controller.ts`（模块单例）：

- 第一次 `subscribe` 时取快照，然后订阅 `onChanged`。只应用 sequence 更大的事件；进度事件只替换对应条目的 `progress`。
- 对外提供：`getState()`、`subscribe()`、`addDroppedFiles(files)`、`pickFiles(filter)`、`start(itemIds?, confirmations?)`、`cancel`、`retry(itemIds, override?)`、`remove`、`clear`、`reveal`、`previewPlan`、`setOptions`、`redetect()`。
- 离开页面也不退订。收到 `batch-finished` 且窗口不在前台时，调用 `showSystemNotification`。

**偏好设置** `src/store/tools/media/useMediaConverterPreferences.ts`：

- 持久化键：`fusionkit.media-converter.preferences.v1`。
- 保存三种任务各自的设置、输出模式、`directoryId` 与其显示名。冲突策略不保存（「覆盖」只在当前会话有效）。
- 低占用模式和并发数不在这里保存，它们由主进程管理。
- 读取时在 `merge` 中用 zod 清洗；`localStorage` 的读写包在 try/catch 中。

**处理计划**

- 对展开的条目，以及会显示损失警告的可见条目，在设置变化后防抖 300 ms 再调用 `previewPlan`。
- 结果按「条目 + 设置签名」缓存。

**开始流程**

1. 用当前面板设置调用 `start`。
2. 主进程返回 `needsConfirmation`（有损转无损、将被替换的文件）时，与本地的损失警告一起合并到同一个确认框。
3. 用户确认后，带 `confirmations` 再次调用 `start`。

**文案映射**

`labels.ts` 用 `as const` 映射表，把原因码转成 i18n 键（`media:errors.<code>`、`media:warnings.<code>`、`media:skip.<code>`），把编码器 id 转成友好名称。每类都有兜底文案。

### 注册与目录

- **`toolMeta.ts`**：`ToolKey` 增加 `mediaConverter`；`category` 增加 `"media"`；`toneVar: "--tool-media"`；`route: "/tools/media/converter"`。
- **`Tools/index.tsx`**：
  - 新增 `MEDIA_TOOLS` 分区，使用 `SectionHeading`（`tools:catalog.media`、`media_description`）。
  - **声明位置必须在 `EXPERIMENTAL_TOOLS` 之后、`type FeaturedItem` 之前**。这样它不落在 `capability-catalog.test.ts` 解析的两段源码里。渲染位置由 JSX 决定，与声明位置无关。
  - 只有 `window.mediaConverter?.supported` 为真时才渲染。
  - 磁贴宽度在渲染审查时确定（`lg:col-span-3` 或整行）。
  - 头部计数加上 `MEDIA_TOOLS.length`。
  - 渲染位置在经典分区之后、实验分区之前。
- **`App.tsx`**：始终注册该路由。`supported` 为假时，页面显示「平台不支持」状态，不跳转，保证 `tool-navigation.electron.test.ts` 能找到 `tool-detail-layout` 和 h1。
- **`router.ts`**：`ToolNameMap` 增加 `"/tools/media/converter": "menu.media.converter"`。
- **i18n 清单（必做）**：
  - 把新磁贴的 `tools:fields.*`、`tools:field_desc.*`（以及需要翻译的 chip）键，追加到 `scripts/i18n-usage-manifest.mjs` 中 ToolTile 的三个选择器条目；
  - 把 `common:menu.media.converter` 追加到 `BottomNavigation#currentToolName` 条目。
- **测试**：新增注册测试，参照 `localSubtitleTranscriberRegistration.test.ts`。

**取舍**：不放进精选分区。精选卡片需要专门的配色和插画，还会牵动 Agent 能力目录测试。I5 接入 Agent 后再评估。

## 代码落点

| 路径 | 作用 |
| --- | --- |
| `src/pages/Tools/Media/MediaConverter/index.tsx` | 页面（含平台不支持状态） |
| `src/pages/Tools/Media/MediaConverter/MediaConverterSettings.tsx` | 配置面板 |
| `src/pages/Tools/Media/MediaConverter/MediaQueue.tsx` | 队列面板、批量操作、开始前确认 |
| `src/pages/Tools/Media/MediaConverter/MediaQueueRow.tsx` | 基于 `StudioTaskQueueRow` 的行 |
| `src/pages/Tools/Media/MediaConverter/PlanSummaryView.tsx` | 处理计划 |
| `src/pages/Tools/Media/MediaConverter/EngineStatusBadge.tsx` | 引擎徽章 |
| `src/pages/Tools/Media/MediaConverter/labels.ts` | 原因码、编码器、档位到 i18n 键的映射 |
| `src/pages/Tools/Media/MediaConverter/format.ts` | 体积（1024 进制）、时长、速度、百分比的格式化 |
| `src/services/media-converter/controller.ts` | 控制器单例 |
| `src/store/tools/media/useMediaConverterPreferences.ts` | 偏好设置 |
| `src/locales/{zh,en,ja,zh-Hant}/media.json` | 文案 |
| `src/locales/{zh,en,ja,zh-Hant}/tools.json` | 目录分区与磁贴文案 |
| `src/locales/{zh,en,ja,zh-Hant}/common.json` | 菜单名 |
| `src/i18n/constants.ts`、`src/i18n/resources.ts` | 登记命名空间 |
| `src/pages/Tools/_shared/toolMeta.ts`、`src/pages/Tools/index.tsx`、`src/App.tsx`、`src/constants/router.ts`、`src/index.css` | 注册 |
| `scripts/i18n-usage-manifest.mjs` | 登记磁贴与底部导航的键 |
| `src/pages/Tools/Media/MediaConverter/*.test.ts(x)` | 注册、格式化、控制器测试 |
| `test/media-converter/media-converter.electron.test.ts` | UI 端到端（`FUSIONKIT_MEDIA_E2E=1`，quiet 模式） |
| `test/media-converter/helpers/media-ui.ts` | 启动、`createTestRun`、`--user-data-dir`、在运行目录生成 lavfi 素材、对话框与 shell 桩、拖放模拟、测试开关 |

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-WORKBENCH-01 | 注册与目录：`MEDIA_TOOLS` 的声明位置、平台判断、页内平台不支持状态、四语文案、i18n 清单 |
| R-WORKBENCH-02 | `ToolFilePickerSurface` + 页面级拖放、控制器的 `addDroppedFiles`/`pickFiles`、行状态（analyzing / unsupported / not_applicable 与切换）、元数据 chips、重复提示、文件夹提示 |
| R-WORKBENCH-03 | `MediaConverterSettings`（按任务显示的字段、以用途命名的编码与说明、默认值）、偏好 store、`PlanSummaryView`、行内损失警告、开始前确认（改为 MKV、有损转无损、覆盖清单） |
| R-WORKBENCH-04 | `MediaQueue` 的批量操作与禁用态、行进度（含不确定状态）、各种结果状态、`aria-live`、汇总栏、离开提示、重载后继续、系统通知 |
| R-WORKBENCH-05 | `EngineStatusBadge`、上传区禁用态、CPU 弱编码器提示与「改用 AV1」、显卡开关的 Tooltip |

## 验证与风险

**UI 验证计划**（落实在 tasks 的 required 检查中）

- **路由**：`/tools` 与 `/tools/media/converter`。另外按 quiet 模式运行回归测试 `test/tool-navigation.electron.test.ts` 与 `test/e2e.spec.ts`（目录断言），与 HEAD 基线对比。
- **视口**：1280×800、1080×786、1024×700、786×540，亮色与暗色。
- **语言**：zh 与 en；ja 抽查一屏。
- **样本**：见上方「内容与验收样本」。测试素材在测试运行目录中由 lavfi 生成，不放在 `%TEMP%`。
- **交互**：
  - 加入文件（选择与拖放）、拖入文件夹；
  - 切换任务；
  - 展开处理计划、查看行内损失警告；
  - 开始前确认（改为 MKV）、开始、取消、重试、仍然转换；
  - 查看失败详情、在文件夹中显示（用测试开关记录调用）；
  - 离开页面再回来、重载窗口；
  - Esc 与返回；
  - 一次加入 101 个文件。
- **审查顺序**：方向 → 结构 → 细节 → 交互 → 适配。每个问题按「位置 → 现象 → 原因 → 改动 → 复验」记录。
- **度量**：用 DOM 测量面板内边距、靠角间距、aside 高度，与 SubtitleConverter 和转写队列对照。

**风险**

- **配置面板过高**：1024×700 与 786×540 下可能被截断。缓解：做实测，超出就折叠「输出与性能」。
- **预览请求过多**：设置变化后，处理计划的请求可能成批涌出。缓解：只为展开或可见的条目请求，并做防抖。
- **AgentDock 遮挡**：可能挡住右下角。缓解：渲染审查时检查，必要时在主区底部留出空间。
- **基线已有失败**：`tool-spacing`、`tool-file-drop`、`tool-navigation` 等 UI 测试在 HEAD 上就是红的。新分区不能增加新的失败，用 HEAD 基线对比来判断。
