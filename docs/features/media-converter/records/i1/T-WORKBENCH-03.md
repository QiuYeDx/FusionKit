# 实施记录：T-WORKBENCH-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKBENCH-03 |
| 日期 | 2026-10-28 |
| 验证版本 | snapshot-sha256:005da5075bcb6756c61ec8d0a2c8bdda1a28640b59e38629b5295e1ac1ee3cde（基线 a742ec76 + 未提交工作树）。独立评审在最后一次源码修改（`MediaQueueRow.tsx` 中分析中的行先占计划行）、其后的 `pnpm run pretest` 与完整 Electron 运行、tool-navigation 回归、静态检查、截图复制与证据文件都完成之后、改写本记录之前取得（2026-10-29 00:13）。本任务各文件的 sha256 前 12 位：`MediaConverter/index.tsx` b961ae6add18，`MediaQueue.tsx` 891b22cd0453，`MediaQueueRow.tsx` d52a4cdf0c59，`PlanSummaryView.tsx` 43dababd9de9，`format.ts` b7eb05a90d48，`format.test.ts` 15b896ae901c，`labels.ts` 8271927722c8，`zh/media.json` 4c54b377b2a4，`en/media.json` 22df639384c3，`ja/media.json` 0fffe0c71c7e，`zh-Hant/media.json` f25a18c2c359，`media-converter.electron.test.ts` 47b99558a8cf；写集外经授权修改的 `controller.ts` 为 0e1037b818c0（评审未改）；用到但未改的 `helpers/media-ui.ts` 为 6fdf0413cfee。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；Vite 5.4.21；Electron 41.10.6，Playwright 1.58.2，窗口模式 quiet（vitest.config.ts 默认：离屏、不抢焦点、静音）；随附 ffmpeg n8.1.2 LGPL（测试素材都在运行目录中由 lavfi 生成，不超过 2 s；竖屏样本按设计「内容与验收样本」为 1080×1920（Kvazaar ultrafast），其余 320×180；ffmpeg 以 PRIORITY_LOW 运行）；RTX 4070 Ti SUPER（UI 测试一律 `FUSIONKIT_TEST_MEDIA_CAPS=cpu_only`，没有在显卡上做编码检测）。`pnpm run pretest` 与每次 Electron 运行都经 PowerShell `Start-Process` 启动的 cmd.exe，随即设为 Idle 优先级，vitest、Electron、ffmpeg/ffprobe 随之继承；同一时间只跑一个，每次运行前后 electron.exe 进程数都是 0。 |
| 任务指纹 | 8f5184ca6597013ef22065a532f42f3a0ef884693256dd92bec106029b6e6a6a |

## 实际结果

**设计依据**

动手前读了以下材料：
- `.agents/skills/fusionkit-ui-design`（SKILL.md、visual-contract.md、validation.md）、`qiuye-ui-quality`、spec 技能的 `frontend-quality.md`；
- module-workbench requirements 的 R-WORKBENCH-02/03，design 的设计基准、渲染进程架构、处理计划、注册与目录；engine design §8（通道表）、contract.ts、ipc.ts、queue.ts 的 `add`/`previewPlan`、inputs.ts 的拖放解析、planner 的 `matrix.ts`/`stream-plan.ts`；
- 前两个任务的记录（T-WORKBENCH-01/02）与编排说明；
- 相关避坑记录：FK-PIT-0099（%TEMP% 中的 Shell 副本）、FK-PIT-0148（在 drop 事件内同步取得文件）、FK-PIT-0162（拖放登记放在语义工作区上）、FK-PIT-0172（内容流高度过渡）、FK-PIT-0188（quiet 窗口）、FK-PIT-0191/0197（先构建、构建锁）、FK-PIT-0196（小控件的平滑圆角）、FK-PIT-0014（i18n 用法检查）。

参照并复用的现有实现：
- 上传：长文本翻译与转写队列的 `ToolFilePickerSurface` + 页面级 `useToolFileDropTarget({pageWide:true})`；长文本的 `secondaryAction` 写法；
- 队列行：转写队列的 `StudioTaskQueue`/`StudioTaskQueueRow`、`StudioFileName`（中间省略 + Tooltip）、`StudioIconButton`（28px 幽灵按钮）；
- 提示条：长文本与转写的 `StudioNotice`；
- 折叠区：`StudioDisclosure`（`accordion.tsx` 的样式与 Motion 高度过渡）；
- 高度过渡：`DialogMotionRegion`（`transitionKey` 为上传区布局，减少动态效果时为 0）。

**实现（写集内）**

- `format.ts`：
  - `formatBytes`：1024 进制，标为 B/KB/MB/GB/TB；100 以下保留一位小数；四舍五入到 1024 时进到下一单位（1023.96 MB 显示为 1 GB）。
  - `formatDurationUs`/`formatDurationMs`：时钟格式；不足 1 秒但大于 0 的显示 0:01。
  - 码率 kbps/Mbps（1000 进制，满 1000 kbps 进位）；帧率最多三位小数（29.97、23.976），可变帧率的平均值最多一位（评审修改）；采样率 kHz；倍速 ×；百分比；`formatSizeChange` 用真正的减号 U+2212（−62%，变大为 +x%）；`formatResolution` 按显示旋转交换宽高。
  - 数字都经 `Intl.NumberFormat(当前语言)`，不认识的语言标签回落到英文。
- `labels.ts`：新增的 `as const` 映射：
  - 文件类型菜单；加入时被拒的原因（单个与多个两套，含 `temporary_copy_unresolved`）；
  - `media:errors.<code>`/`media:advice.<code>` 的探测失败原因与建议，运行时类失败转用引擎的不可用文案；
  - 条目状态、阶段、HDR 标记、声道；
  - `media:warnings.<code>` 的全部计划警告，丢弃的字幕按图形/文字分别说；
  - 不适用原因、流类型、流被丢弃的原因、计划错误；
  - 不翻译的格式名与编码名（H.264、HEVC、PGS 等）。
  - 所有 `t()` 的键都能静态求出，没有新增用法清单条目。
- `index.tsx`：
  - 上传区：`ToolFilePickerSurface`。
    - 没有条目时为 stacked（158px），有条目后为 horizontal（68px），外面包一层 `DialogMotionRegion` 做高度过渡。
    - 主按钮打开主进程对话框（全部音视频）；`secondaryAction` 是一个 28px 的筛选图标按钮加菜单，可选「只选视频/只选音频/所有音视频」。菜单的点击在本层拦下，不会再触发整块上传区的点击。
    - 引擎不可用或快照未就绪时禁用，并保留 T-WORKBENCH-02 的原因说明；检测中仍可加入。
  - 页面级拖放：`useToolFileDropTarget({pageWide:true})` 登记在页面根节点上，拖到页面任意位置都会加入，并显示共享的整页提示「松开以加入音视频转换」。回调在 drop 事件内同步调用 `controller.addDroppedFiles`（FK-PIT-0148）。
  - 加入结果：
    - 只有新加入时，用 toast「已加入 N 个文件」；
    - 有重复、超出 100 个或被拒的文件时，在上传区下方用 `StudioNotice` 提示（只有重复时 `role=status`，有文件没加入时 `role=alert`；可关闭，下次加入时替换）：已加入数；「「x」已在列表中，没有重复加入」；「一次最多加入 100 个文件，另有 n 个没有加入」；队列已有 500 个未结束条目时「列表已满（最多 500 个），另有 n 个文件没有加入」；每类被拒原因一行，多个时列出前三个名称再计数。
    - 对话框取消时（结果全空）不改动现有提示。
- `MediaQueue.tsx`：
  - 「队列」`ToolPanel` + `StudioTaskQueue`，带条目数徽标，随页面滚动，没有内层滚动条；没有条目时不显示。
  - 处理计划使用的设置：面板设置按签名保持同一对象，停止变化 300 ms 后才交给各行（`PLAN_DEBOUNCE_MS`）。
  - 一个共享的 `IntersectionObserver` 告诉各行是否在视口中，根为应用的滚动区域，上下各留 120px（评审修改：原先以窗口为根，滚动区域会把这 120px 裁掉）。
  - T-WORKBENCH-04 再加标题栏的全部开始/取消/清除、汇总栏与开始前确认。
- `MediaQueueRow.tsx`（`memo`，只在条目、计划设置或引擎对象变化时重渲染）：基于 `StudioTaskQueueRow`。
  - 分析中：转圈图标 +「分析中…」。
  - 无法处理：红色文件图标，元数据位置为红色原因，下一行灰色建议。
  - 已探测：
    - 类型图标（视频/音频）；
    - 元数据按组排列：时长·体积；分辨率（按旋转）·帧率（可变帧率写「约 x fps（可变帧率）」）·编码（10-bit 以上注明）+ HDR 标记；主音轨的编码·声道·采样率·码率；音轨数·字幕数（音频文件含封面时为「含封面」）。
    - 组内不断行，组与组之间换行；共享行的 `.studio-task-meta > *` 默认不换行，用行上的任意变体覆盖为可收缩、可换行。
  - 处理计划：空闲条目在视口中或展开时调用 `controller.previewPlan`。结果按状态显示：
    - `ready`/`skipped`：计划行「处理计划 · 编码器 → 格式」（可展开）；`skipped` 另有「已经是目标格式，开始时会跳过」。
    - `task_not_applicable`/`no_audio_stream`/`no_video_stream`：一行「当前任务不适用 + 原因 + 切换按钮」。音频文件为「改为转换成 MP3」（转换的目标已是音频格式时沿用它），没有音轨的视频为「切换到「压缩视频」」。用键盘按下时，焦点留在这一行的文件名上。
    - `no_encoder_available`：琥珀色说明。只在「压缩视频」下，按 `alternatives` 提供「改用 X」；没有可用替代时说明其他编码也不行。
    - 其他错误：一行灰色说明。
  - 损失警告：计划中有 `PLAN_LOSS_CODES` 的警告时，不展开也显示一行琥珀色警告（多条用「、」连接），与主进程计划的顺序一致。
  - 分析中的行与计划未到的空闲行，计划行先占位（「处理计划 · 正在生成…」，24px；分析中时占位是评审补上的）；不适用的一行也是 24px。这样一批文件陆续分析完、计划陆续到达、行滚入视口时，行高不变，列表不跳。
  - 设置刚变化、新计划还在路上时，旧计划变淡并标 `aria-busy`。
  - 「移除」：除排队与运行外都显示，28px 幽灵按钮，与行的上边、右边都是 8px；主进程答复没有移除任何条目时（其间已开始运行），按钮恢复可用（评审修改）。
  - 开始后的状态（由 T-WORKBENCH-04 完成）先显示状态与阶段文字、开始时冻结的计划（注明「按开始时的设置处理」），以及引擎已随状态发来的信息：`disk_space_low` 的「磁盘空间不足：需要 X，可用 Y」（`formatBytes`）、取消或中断时已保存的「m/n 个输出」，有进度值的运行中条目显示进度条。
- `PlanSummaryView.tsx`：展开后的处理计划，内容全部来自主进程的计划摘要，自己不做任何规划。
  - 编码器友好名（10-bit 注明），或「不重新编码，只更换封装」；
  - 每个输出的格式与扩展名（「全部音轨」时带音轨号与语言）；
  - 每条流：类型、序号、编码、语言（`Intl.DisplayNames`）、标题 → 直接复制 / 重新编码：X / 转为 X / 丢弃及原因，丢弃为琥珀色；
  - 附件、章节、数据流的去留；
  - 全部警告（损失类琥珀色，其余灰色），以及需要确认的「有损转无损」。
- 四种语言的 `media.json`：新增 `upload.*`、`add.*`、`queue.*`、`errors.*`、`advice.*`、`warnings.*`、`plan.*`，每种语言 278 个键（评审加了 `add.queue_full` 及其单数形式）。`upload.hint` 改为说明可以拖入（「拖入视频或音频文件，或点「选择文件」，可一次添加多个」）。
- 测试：
  - `format.test.ts`：9 项，含德语的小数点与百分号用来证明按语言格式化；评审在帧率一项中加了可变帧率平均值的断言。
  - `media-converter.electron.test.ts`：新增 T-WORKBENCH-03 的 2 个 Electron 场景（见「交互覆盖」）。
  - 另有两处为适应新页面而改动的旧场景：T-WORKBENCH-01 的辅助函数自测改为直接拖到页面（页面现在自己接收拖放，原来的临时 drop 监听会造成重复加入）；T-WORKBENCH-02 的场景里上传按钮的选择器改为排除筛选按钮。

**写集外的改动（经编排授权）**

- `src/services/media-converter/controller.ts`：删除临时的 `formatSaved`，系统通知改用 `format.ts` 的 `formatBytes`，没有其他改动。controller.test.ts 16 项仍通过。
- 没有改 `helpers/media-ui.ts`、`registration.test.ts` 或用法清单。
  - 页面在静态渲染下仍然可用：引擎状态为空时为 stacked 上传区，没有队列。registration.test.ts 12 项不改即通过。
  - 文件夹、临时副本的拖放与 `previewPlan` 请求计数需要的辅助函数，写在测试文件内。

**渲染审查与修复**

截图都来自 quiet Electron 中的最终代码（独立评审修复后重新拍摄，见下文「评审与修复」）。设备像素比为 2，1280×800 与 786×540 的页面实际为 1292×806 与 798×546（FK-PIT-0188）。审查顺序为方向 → 结构 → 细节 → 交互 → 适配。实现时发现并修复的问题：

1. **计划到达时行变高，列表跳动**
   - 位置：786×540 加入 101 个文件后滚到末尾。
   - 现象：截图停在第 93–98 行，而不是第 100 行。
   - 原因：行在进入视口后才请求计划，计划行出现，每行高 24px，把末尾推出窗口。
   - 改动：空闲条目在计划到达前就显示占位的计划行（「处理计划 · 正在生成…」）；计划行与不适用行都定为 24px。
   - 复验：滚到末尾的截图停在第 100 行。1280 下不适用行与普通空闲行同高（90/90，测试中有断言）。
2. **上传区说明没有提到可以拖入**
   - 现象：stacked 状态只写「选择要压缩……的文件」。
   - 改动：`upload.hint` 四种语言都改为先说拖入。
3. **中文计划中「转为MP4 文本字幕」缺空格**：zh、zh-Hant 的 `plan.action.convert` 在「转为」后加一个空格（「转为 MP4 文本字幕」），与项目其他中英混排一致。
4. **鼠标切换任务后弹出文件名 Tooltip**
   - 现象：点「改为转换成 MP3」后，焦点移到文件名，Radix 随之打开 Tooltip。
   - 改动：只在键盘触发（`event.detail === 0`）时移动焦点。
   - 复验：Electron 中用 Enter 触发，焦点在文件名上。
5. **测试样本与截图本身的问题**（产品代码未因此改动）：
   - 超长文件名在 1280 和 786 下都没有被截断：按设计样本的开头加长，现在两种窗口都在中间省略，测试中有断言；
   - 竖屏样本在 786 下一行放得下：改为手机常见的可变帧率，并把断言改为「放不下就必须换行、放得下就不换行、从不溢出」。786 下中英两种语言都换行；
   - 带样式 ASS 的样本因 `-shortest` 丢了字幕事件：去掉 `-shortest`；
   - 状态截图包含了不相邻的行、被底部导航压住：改为每组相邻行先滚到标题栏下再截，截图前把指针移开；
   - 删除一个未用的类型导入。

最终截图（`records/i1/screenshots/T-WORKBENCH-03-*.jpg`，共 34 张，评审最后一次运行拍摄，逐张重新查看）观察：

- `-upload-empty-light-zh-1280x800`：没有条目时，上传区为 stacked。图标底座、标题、说明、按钮居中，与长文本翻译的开始页同一写法；右侧没有空队列面板，首要操作清楚。
- `-filter-menu-light-zh`：筛选按钮与「选择文件」同为 28px 描边按钮。菜单右对齐按钮，三项带视频、音频、文件图标，不遮挡上传区标题。
- `-queue-light-zh-1280x800`、`-queue-dark-en-1280x800`：
  - 上传区收为 68px 一行，筛选与选择按钮在右侧；
  - 队列面板与设置面板顶边对齐，标题「队列 8」；
  - 行透明、8px 内边距，名称与元数据左缘对齐（缩进 23px）；
  - 状态区分清楚：不适用行的图标变淡，琥珀色损失行一眼可见，无法处理的行为红色原因加灰色建议；
  - 暗色下 HDR10 标记、琥珀色与红色都清楚；
  - 左下角 AgentDock 球与设置面板末端略有重叠（已知，见风险）。
- `-queue-light-en-786x540`、`-queue-dark-zh-786x540`、`-queue-end-light-en-786x540`、`-queue-end-dark-zh-786x540`：
  - 窄窗口时主区在前、设置在后；
  - 竖屏视频的元数据整组换到第二行（「2 audio tracks · 1 subtitle」），组内不断开；
  - 英文页头描述折为两行，引擎徽章不被挤压；
  - 末尾四个无法处理的行完整，面板底边在设置面板之前；没有横向溢出。
- `-row-not-applicable-light-zh`、`-dark-en`：「当前任务不适用 / Not for this task」加粗，原因为灰色，「改为转换成 MP3 / Convert to MP3 instead」为 24px 描边按钮，与文字同行垂直居中。
- `-rows-unsupported-light-zh`、`-dark-en`：四种原因各占一行，建议在下一行：
  - 改名的文本文件：文件已损坏或无法读取（引擎给的是 `probe_failed`）；
  - 播放列表：文件格式不受支持（如播放列表）；
  - 微信语音：微信语音格式暂不支持；
  - 只有字幕轨的 MKV：不是音视频文件。
  - 红色在暗色下仍可读；移除按钮与行的上、右边都是 8px。
- `-rows-media-light-zh`、`-dark-en`：
  - 竖屏视频：0:02 · 1.6 MB · 1080×1920 · 约 16.2 fps（可变帧率）· HEVC + HDR10 标记 · AAC·立体声·44.1 kHz·128 kbps · 2 条音轨·1 条字幕，加琥珀色「HDR 将转为 SDR」；1280 下一行放得下，786 下「2 条音轨 · 1 条字幕」整组换到第二行；
  - 带字幕的 MKV：3 条字幕，计划「OpenH264（CPU）、Opus → MKV」；
  - 超长文件名在中间省略，保留「…final_v2.mkv」。
- `-long-name-tooltip-light-zh`、`-dark-en`：悬停文件名时，Tooltip 显示全名，按 20rem 自然换行三行，框随文字收紧；行的 hover 背景与 Tooltip 不冲突。
- `-loss-line-light-zh`、`-dark-en`：输出格式改为 MP4 后，带字幕的 MKV 一行显示「ASS 字幕样式将丢失、2 条图形字幕将被丢弃」，与主进程计划的警告顺序一致；上方的竖屏视频仍是 HDR 一行。
- `-plan-light-zh-1280x800`、`-plan-dark-en-1280x800`、`-plan-light-zh-786x540`：
  - 展开后计划框为 8px 圆角，有边框，背景比行浅一层；
  - 编码器「OpenH264（CPU）、AAC、MP4 文本字幕」；
  - 五条流逐行：两条 PGS 为琥珀色「丢弃：MP4 无法保存这种字幕」，ASS 为「转为 MP4 文本字幕」；
  - 警告五条，损失类琥珀色，其余灰色；
  - 786 下内容完整换行，没有横向溢出。
- `-switched-light-zh`：键盘按下切换后，左侧任务变为「转换格式」，目标为 MP3，音质档位出现；FLAC 行变为「MP3（LAME）→ MP3」，焦点环在文件名上并显示其 Tooltip；视频行同步重新规划为 MP3。
- `-carried-queued-light-zh`、`-carried-ended-light-zh`（注入的开始后状态，见风险）：
  - 「排队中」条目没有移除按钮，展开的计划首行为「按开始时的设置处理」；
  - 「失败」条目有红色叉号图标和「磁盘空间不足：需要 5.5 GB，可用 1.2 GB」；
  - 「已取消」条目显示「已保存 1/3 个输出」。
  - 只是 T-WORKBENCH-04 之前的过渡呈现。
- `-duplicate-notice-light-zh`、`-dark-en`：提示条在上传区与队列之间，信息图标为灰色（不是问题），「「clip.mp4」已在列表中，没有重复加入。」；关闭按钮 28px，未被悬停。
- `-drop-overlay-light-zh`：拖入时显示共享的整页提示（虚线平滑圆角，背景半透明），文字为「松开即可导入文件 / 松开以加入音视频转换」，与其他工具一致。
- `-folder-notice-light-zh`、`-dark-en`：琥珀色警告图标，文案为「「素材文件夹」是文件夹：暂不支持文件夹，请选择其中的文件。」，英文同义；队列仍是 1 个。
- `-unreadable-notice-light-zh`：没有磁盘路径的文件：「「from-archive.mp4」无法读取：找不到它在磁盘上的位置，请用选择文件添加。」
- `-analyzing-light-zh-786x540`：一次加入 101 个文件后，列表末尾的行都是转圈图标加「分析中…」，下面已有占位的计划行「处理计划 · 正在生成…」，与分析完的行同为三行、同高，行距均匀。
- `-queue-full-notice-light-zh-786x540`（评审新增）：琥珀色警告图标，「列表已满（最多 500 个），另有 3 个文件没有加入。」，没有「一次最多 100 个」那一行；与其他提示条同一写法，关闭按钮未被悬停。
- `-overflow-notice-light-zh-786x540`：两行提示「已加入 100 个文件。」「一次最多加入 100 个文件，另有 1 个没有加入。」；队列徽标 101，前两行已显示媒体信息与计划行。
- `-queue-end-dark-en-786x540-101`：滚到第 100 行，计划行齐全，行距均匀；底部导航压住最后一行的下半部分，这是窗口底边的常态，页面底部有留白可以继续滚动。

度量（全部数值在 `T-WORKBENCH-03-ui.txt` 中）：

| 窗口 | 主题·语言 | 不适用行高 | 空闲行高（一行元数据） | 竖屏视频行高 / 元数据行数 | 无法处理行高 | 移除按钮 上/右 | 溢出 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280×800 | 亮·zh | 90 | 90 | 112 / 1 | 84 | 8 / 8 | 无 |
| 1280×800 | 暗·en | 90 | 90 | 112 / 1 | 84 | 8 / 8 | 无 |
| 786×540 | 亮·en | 90 | 90 | 132 / 2 | 84 | 8 / 8 | 无 |
| 786×540 | 暗·zh | 90 | 90 | 132 / 2 | 84 | 8 / 8 | 无 |

- 上传区：stacked 158px，horizontal 68px。
- 超长文件名在四种组合下都被中间截断，结尾都是「final_v2.mkv」。
- 防抖：两个档位相隔 100 ms 点击，之后的 `preview-plan` 请求只有 4 个（每个可规划的行一个），都是最后的档位，都在第二次点击后 307–308 ms。
- 101 个文件加入后，92 行仍在分析中；停在末尾时，视口中的最后一行在其余文件分析完的过程中位置不变（6 次取样都是 456px）。
- 滚回顶部后，100 个批量行中只有 10 个请求了计划（停在末尾时分析完的几行与顶部的几行）；从未显示过的第 50 行没有请求，滚到它之后才请求；滚动区域下方 21px 的行已请求（120px 余量）。

**交互覆盖（Electron 断言）**

- 加入：
  - 筛选菜单的「只选音频」：对话框只有音频过滤器（含 flac/mp3/m4a，不含 mp4）；
  - 主按钮：对话框为「音视频 + 所有文件」；
  - 拖放：落在上传区，或落在设置面板上（页面任意位置）。
- 行：
  - 8 个文件立刻出现，先是「分析中」，之后显示媒体信息。四个无法处理的文件逐个核对原因与建议，其中播放列表、微信语音、只有字幕轨的 MKV 的原因码固定断言（`container_not_allowed`、`wechat_silk_unsupported`、`no_media_streams`）。
  - 中英两种语言下核对元数据各组的内容；
  - 文件名中间省略，悬停与键盘聚焦都能打开全名 Tooltip。
- 损失警告与计划：
  - 竖屏 HDR 视频与输出 MP4 时的字幕 MKV，行内一行警告的文字等于由主进程 `previewPlan` 的损失警告逐条生成的文字；自动容器时字幕 MKV 没有警告行。
  - 展开的计划：编码器友好名、每条流的类型与处理方式、警告与确认代码的顺序，都与主进程计划逐项相等（AC-WORKBENCH-03-5）。
  - 防抖：在主进程包装 `preview-plan` 处理函数记录请求，结果见上面的度量。
- 切换任务：用键盘按「改为转换成 MP3」，任务与目标格式随之改变，FLAC 行变为可处理，焦点在文件名上。
- 移除：一个无法处理的条目被移除，其他条目不受影响。
- 开始后的状态：注入排队、`disk_space_low` 失败、带部分输出的取消三个条目，断言见上面的截图观察。
- 拖放的提示：
  - 同一文件再拖一次：提示「已在列表中」，条目数不变；
  - 文件夹：经 Chromium 真实的拖放管线（CDP `Input.dispatchDragEvent` 带磁盘路径），预加载读到文件夹路径，主进程解析为 `folder_not_supported`；
  - 临时副本：应用的 %TEMP% 指向运行目录中的文件夹，从那里拖入的文件被主进程当作无法证明原文件的 Shell 副本（`temporary_copy_unresolved`），提示「请先解压，或用选择文件添加」；
  - 没有磁盘路径的 File：预加载判为 `file_unavailable`；
  - 关闭按钮可以关掉提示。
- 101 个文件：提示加入 100、另有 1 个；条目逐个出现、先分析，分析完时视口中的行不移动；只有视口中（含下方 120px）的行请求计划。
- 列表已满：主进程对一次选择的答复被替换为「另有 3 个没有加入」，提示为「列表已满（最多 500 个）……」，没有「一次最多 100 个」那一行，`role=alert`。
- 提示条的播报级别：只有重复时 `role=status`，有文件没加入时 `role=alert`。
- 身份而非名称：100 个内容相同、名称不同的副本都被加入；另一文件夹中同名的 clip.mp4 也被加入（文件夹名分别为 media 与 other）。
- 两个场景都没有 pageerror。

**评审与修复（独立评审，2026-10-28 至 10-29）**

评审读了本任务的全部代码（`index.tsx`、`MediaQueue.tsx`、`MediaQueueRow.tsx`、`PlanSummaryView.tsx`、`format.ts`/`format.test.ts`、`labels.ts`、四种语言的 `media.json`、测试文件中本任务的场景与改动过的前两个任务场景），对照 contract.ts、queue.ts 的 `add`/`remove`、预加载的拖放处理、共享的 `StudioTaskQueueRow`/`ToolFileDropScope`/`DialogMotionRegion` 与长文本翻译的提示条写法；重新跑了全部 V 检查，并逐张重看 34 张截图。各 AC 的主体实现成立，没有阻断或严重问题。发现并修复的问题（均为次要）：

1. **列表在一批文件分析完时仍会跳动。**
   - 位置：786×540 一次拖入 101 个文件，停在列表末尾。
   - 现象：在视口里的最后一行，随着上方与视口内的行分析完，1.5 s 内从 484px 移到 708px（评审第 2 次运行的度量），被推出视口。
   - 原因：实现时只给「空闲、计划未到」的行占了计划行；分析中的行只有两行，分析完多出 28px 的计划行。
   - 改动：`MediaQueueRow.tsx` 中分析中的行也先显示占位的计划行（「处理计划 · 正在生成…」），提前展开时，分析完后计划自动填入。
   - 复验：最后一行在 76 个文件分析完的过程中每 250 ms 取样 6 次，位置都是 456px（测试中有断言）；截图 `-analyzing-light-zh-786x540` 中分析中的行与分析完的行同高。
2. **「上下各留 120px」实际不生效。**
   - 原因：`IntersectionObserver` 以窗口为根，rootMargin 只扩大窗口；行在应用自己的滚动区域里，滚动区域的裁剪不带余量。
   - 改动：`MediaQueue.tsx` 中观察器在第一行登记时创建，根为该行所在的 `[data-slot=scroll-area-viewport]`。
   - 复验：滚动区域下方 21px 处的行已请求计划（测试中断言「下方 100px 内的行都已请求」）。
3. **可变帧率的平均值显示三位小数**（「约 14.985 fps」），与「约」矛盾。`format.ts` 的 `formatFrameRate` 加 `approximate`，可变帧率最多一位小数（「约 16.2 fps」）；`format.test.ts` 加断言，变异 M9 被发现。
4. **列表满时提示的原因不对。** 引擎把「一次超过 100 个」和「队列已有 500 个未结束条目」都计入 `truncated`，原来一律说「一次最多加入 100 个文件」。`index.tsx` 按这次加入提交的文件总数区分两者，后者显示新键 `add.queue_full`（四种语言）。测试经主进程替换一次 `pick-files` 的答复（同 `recordPlanRequests` 的做法）核对文案、`role=alert` 并截图。
5. **提示条的播报级别。** 有文件没加入时改为 `role="alert"`（长文本翻译的提示条对问题也用 alert），只有重复时仍是 `role="status"`；测试断言两者。
6. **移除按钮可能永久禁用。** 主进程答复没有移除任何条目（其间已开始运行）时，按钮恢复可用。
7. **测试本身的问题。**
   - 竖屏样本：帧率改为一位小数后，360×640 的样本在 786 下一行放得下，换行不再被检验；改为设计「内容与验收样本」的 1080×1920（Kvazaar `preset=ultrafast`，2 s），音频 44.1 kHz，786 下中英都换行。超出 640×360 的理由是这一检查要看的正是该样本的元数据。
   - T-WORKBENCH-02 场景的竞态：切回「压缩视频」后立即读「输出与性能」是否展开，面板随后自动折叠，点击被拦截（评审第 1 次运行失败一次）。改为先等面板稳定再读；只改了测试的等待，没有改产品代码。
   - 「最后一行在滚到之前没有请求计划」：最后一行现在会在视口中分析完并请求计划，断言改为从未显示过的第 50 个批量行。

评审确认无需修改的点：拖放在 drop 事件内同步交给控制器（FK-PIT-0148）；渲染进程从不发送路径；`usePlan` 的 `live` 标志丢弃过期答复，控制器按「条目 + 设置签名」缓存，条目或引擎变化时清空；防抖在最后一次变化后 300 ms（本次 307 ms）；`PlanSummaryView` 不做任何规划；i18n 键都能静态求出；Esc 在菜单与 Tooltip 打开时由 `useToolPageEscape` 留给本地；`studio.css` 随所有路由一起打包，提示条在本页有样式。

- 批次 D2 集成复核（2026-10-29）：T-WORKBENCH-04 之后改动了本任务的共享文件（index.tsx、MediaQueue*.tsx、四个 media.json 与 Electron 测试），本记录的验证版本与截图早于这些改动。集成检查在最终代码上重新运行 `pnpm run pretest` 与完整的 `FUSIONKIT_MEDIA_E2E=1` Electron 文件，15/15 通过（含本任务两个场景），format.test.ts 随 739 项非 Electron 测试通过；截图未重拍，最终界面以 T-WORKBENCH-04 的截图为准。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKBENCH-03-1 | 通过 | file:records/i1/T-WORKBENCH-03-unit.txt |
| V-WORKBENCH-03-2 | 通过 | file:records/i1/T-WORKBENCH-03-ui.txt |

- V-WORKBENCH-03-1：
  - `format.test.ts` 9 项通过。
  - 对 `format.ts` 做了 9 个变异（1000 进制、取消进位、连字符代替减号、不足 1 秒显示 0:00、忽略语言、忽略旋转、kbps 不进位、帧率两位小数、可变帧率仍显示三位小数），全部被发现，文件按字节还原（sha256 b7eb05a90d48）。
  - 同一证据文件还记录了最终代码上的 registration（12 项）、controller（16 项）、共享控件消费者与拖放作用域测试，共 41 项通过。
- V-WORKBENCH-03-2：
  - 评审在最后一次源码修改之后先 `pnpm run pretest`，再以 quiet 模式运行整个 `media-converter.electron.test.ts`，12/12 通过：T-WORKBENCH-01 的 5 项（含 2 项不启动 Electron）、T-WORKBENCH-02 的 5 项，以及本任务的 2 项。评审过程中的前两次运行（一次 2 项失败、一次 12/12）及其原因记在证据文件开头。
  - 覆盖：竖屏 HEVC、带 PGS 与样式 ASS 的 MKV、带封面的 FLAC、伪造的 mp4、超长文件名，另有播放列表、微信语音和只有字幕轨的 MKV；分别经对话框（打桩）与拖放加入；拖入文件夹；一次加入 101 个文件。
  - 视口 1280×800 与 786×540，亮色与暗色，zh 与 en。34 张截图已逐张查看，观察见上文。
- 补充检查（不在本任务验证计划内，证据见 `T-WORKBENCH-03-static.txt` 与 ui 证据末尾）：
  - `pnpm exec tsc --noEmit -p tsconfig.json` 没有诊断；
  - 两份测试文件（tsconfig.json 不包含）用继承它的配置检查，同样没有诊断；
  - `pnpm run i18n:check` 退出码 0：四种语言 media 都是 278 个键，「All source translation keys resolve.」；
  - `FUSIONKIT_TOOL_UI_E2E=1 FUSIONKIT_TEST_MEDIA_CAPS=cpu_only` 的 `tool-navigation.electron.test.ts` 1/1 通过：新页面的拖放登记与队列不影响每个工具页的标题对齐与 Esc 顺序。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKBENCH-02-1 | 通过 | V-WORKBENCH-03-2 |
| AC-WORKBENCH-02-2 | 通过 | V-WORKBENCH-03-1, V-WORKBENCH-03-2 |
| AC-WORKBENCH-02-3 | 通过 | V-WORKBENCH-03-2 |
| AC-WORKBENCH-02-4 | 通过 | V-WORKBENCH-03-2 |
| AC-WORKBENCH-03-5 | 通过 | V-WORKBENCH-03-2 |
| AC-WORKBENCH-03-6 | 通过 | V-WORKBENCH-03-2 |

- AC-WORKBENCH-02-1 的「对话框可以按视频、音频或全部筛选」：UI 测试点了「只选音频」和主按钮（全部），「只选视频」的过滤器由 T-WORKBENCH-01 的辅助函数自测经 `pickFiles({filter:'video'})` 核对，三项共用同一个菜单组件。
- AC-WORKBENCH-02-3：
  - 「开始时跳过该文件」属于开始流程：主进程的 `start` 已经把不适用的条目以原因码拒绝（engine 已测），界面在 T-WORKBENCH-04 的「全部开始」中复核。
  - 伪造的 mp4 被引擎判为 `probe_failed`，所以显示「文件已损坏或无法读取」；「不是音视频文件」由只有字幕轨的 MKV（`no_media_streams`）呈现。
- AC-WORKBENCH-03-6：本任务交付的是「不展开也能直接看到一行警告」，并且内容与主进程计划一致。「全部开始」时的确认框、「改为 MKV」、有损转无损的确认都属于 T-WORKBENCH-04（该任务的验收同样列有本 AC）。这里的「通过」只指本任务负责的部分。

## 风险与未执行项

- **注入的状态。** 「排队中、`disk_space_low` 失败、已保存部分输出的取消」三种行，是测试经 `webContents.send('media-converter:changed', …)` 注入的条目（预加载照常校验），条目内容用了真实媒体信息与主进程真实给出的计划。这些状态的完整呈现与操作由 T-WORKBENCH-04 负责。
- **文件夹与临时副本不是 Explorer 的真实拖放。**
  - 文件夹：经 CDP `Input.dispatchDragEvent` 带磁盘路径投放，走的是 Chromium 的拖放管线、预加载与主进程的真实解析，但不是从 Explorer 窗口拖出的。
  - 临时副本：为不碰真实 %TEMP%，测试启动应用时把它的 TEMP/TMP 指向运行目录中的文件夹，从那里拖入。主进程照常用隐藏的 PowerShell 查询 Explorer 当前选中的文件（只读），找不到对应项后判为 `temporary_copy_unresolved`。从压缩包里直接拖出文件的真实场景，留给用户验收。
- **开始后状态的图标与文字是过渡实现。** 已完成、失败、跳过、取消、中断、输入已变化的图标与状态文字只是占位，进度条只在有进度值时显示；不确定进度、结果、重试、仍然转换等都由 T-WORKBENCH-04 完成。行内的「移除」先在本任务提供（除排队与运行外），T-WORKBENCH-04 会补齐其他操作。
- **列表密度。** 每个空闲行约 90px（名称、元数据、计划行三行）。设计的草图也是三行；30–100 个条目时的密度检查，在 V-WORKBENCH-04-2 中与转写队列对照。
- **AgentDock 遮挡（已知）。** 1280×800 未滚动时，设置面板左下角与浮动 AgentDock 球略有重叠；786 下滚到末尾时，底部导航压住最后一行的下半部分，页面底部有留白可以继续滚动。由 V-WORKBENCH-04-2 统一测量。
- **主进程的规划结果。** 示例中 AAC 被重新编码为 AAC，自动容器为 MKV 时音频转为 Opus。这些是 planner 的决定，界面只是照实显示，没有判断其是否最优。
- **可变帧率的数字。** 平均帧率最多显示一位小数（如「约 16.2 fps」）；固定帧率仍最多三位（23.976）。
- **「改为转换成 MP3」改的是整个面板的任务。** I1 没有单个文件的设置（R-WORKBENCH-07 在 I3），所以在音频文件的行上一键切换后，列表中的视频也会按「转换格式 · MP3」规划（各行的计划行随即显示「MP3（LAME）→ MP3」）。这是规格的设计；混合列表时是否需要在 T-WORKBENCH-04 的开始前确认中提示「视频将只保留音频」，留给用户验收决定。
- **列表已满的情形只用替换的答复验证。** 真正凑满 500 个未结束条目需要 500 次探测，测试经主进程替换了一次 `pick-files` 的答复；区分两种原因的计算在一次加入中同一文件出现两次且已在列表中时，可能把个别「超过 100 个」算成「列表已满」，属于极端情形。
- **运行目录已删除。** 实现与评审的所有运行目录（`test-results/media-converter/ui-*`，包括同一文件中前两个任务场景的运行）都在复制截图与度量后删除；test-results 下的其他内容没有动。tool-navigation 照常改写了它自己的产物（`test-results/tool-navigation/`）。评审没有设置 `FUSIONKIT_MEDIA_REVIEW_DIR`，因此 T-WORKBENCH-01/02 的记录截图没有被覆盖。
- **环境说明。** 记录 Vitest 版本时，在临时目录误执行了一次 `npx vitest --version`，npx 把 vitest 4.1.12 下载进了自己的缓存。项目的依赖与锁文件没有变化，所有测试都用项目自带的 Vitest 2.1.9。
