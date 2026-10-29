# 实施记录：T-WORKBENCH-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKBENCH-02 |
| 日期 | 2026-10-28 |
| 验证版本 | snapshot-sha256:73144138eb7340497ce6d25865cb1c3ef70e821688f0bd20ef72f0071f66126d（基线 a742ec76 + 未提交工作树）。独立评审于 21:10 取得：在评审的最后一次源码修改（21:02）、其后的 `pretest` 与 Electron 运行、静态检查、单元测试、三份证据文件与截图复制都完成之后，写本记录之前；本记录文件不在其中。本任务各文件的 sha256 前 12 位：`controller.ts` 7637e5e017bc，`controller.test.ts` 2359a2f16cc0，`useMediaConverterPreferences.ts` fdc5fbea976c，`useMediaConverterPreferences.test.ts` f3a8e17bac67，`MediaConverter/index.tsx` 38cf520203b5，`MediaConverterSettings.tsx` 04e23e318dc1，`EngineStatusBadge.tsx` ee653978868a，`labels.ts` c85d61c8ef87，`zh/media.json` 51daf1174b18，`en/media.json` 5c489710c776，`ja/media.json` 136b019e38ca，`zh-Hant/media.json` 90a135c50d9c，`media-converter.electron.test.ts` 7b7cd3110268；用到但不在写集内的 `helpers/media-ui.ts` 为 6fdf0413cfee（T-WORKBENCH-01 评审后的版本）。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；Vite 5.4.21；Electron 41.10.6，Playwright 1.58.2，窗口模式 quiet（vitest.config.ts 默认：离屏、不抢焦点、静音）；随附 ffmpeg n8.1.2 LGPL（UI 测试只在运行目录中用 lavfi 生成一段 2 s 320×180 的 H.264/AAC 小样，PRIORITY_LOW）；RTX 4070 Ti SUPER（UI 测试用 `FUSIONKIT_TEST_MEDIA_CAPS` 的 cpu_only、nvenc、detecting_ms:10000、unavailable:runtime_invalid，没有做真实的编码器检测）。`pnpm run pretest` 与 Electron 测试都经 `cmd start "" /low /wait /b` 以 IDLE 优先级运行（vitest、Electron 与 ffmpeg 随之继承），同一时间只跑一个；每次运行前后 electron.exe 进程数都是 0。 |
| 任务指纹 | 5128d2eee3510c1b0b317d2f440baabc97673aaf64ecd63e2ff1fb11e7d42309 |

## 实际结果

**接手情况**

本任务在 18:21 被整批中止过一次。接手时检查了上一次尝试在 17:21 之后留下的文件：控制器、偏好 store、设置面板、引擎徽章、`labels.ts`、`index.tsx`、四份 `media.json` 与 Electron 测试中的 T-WORKBENCH-02 场景。这些文件都在本任务写集内，逐个读过，逻辑正确的保留。上一次尝试的证据一律不用，本记录中的检查全部重新运行（独立评审又全部重跑一次，见「评审与修复」）。

- `test/media-converter/helpers/media-ui.ts` 不在本任务写集内。实现时它在 T-WORKBENCH-01 记录的哈希之后被改过，本任务按原样使用。T-WORKBENCH-01 的独立评审（20:07–20:29）随后又改了它（现为 6fdf0413cfee），并在同一测试文件中增加了一项 %TEMP% 检查；本任务的评审按这个版本运行，没有改动它。
- 本任务没有动 test-results 下的其他内容。

**设计依据**

动手前读了以下材料：
- `.agents/skills/fusionkit-ui-design`（SKILL.md、visual-contract.md、validation.md）、`qiuye-ui-quality`、spec 技能的 `frontend-quality.md`；
- module-workbench design 的设计基准、渲染进程架构、注册与目录；
- 相关避坑记录：FK-PIT-0089（末项折叠区停靠面板底边）、FK-PIT-0188（quiet 窗口）、FK-PIT-0191/0197（先构建、构建锁）、FK-PIT-0194（nova Tooltip 保持块布局）、FK-PIT-0014（i18n 用法）、FK-PIT-0088/0090（布尔用 `ToolSwitchRow`，有限互斥值用分段控件）。

参照的现有实现：
- 字幕翻译器页头的模型徽章（`secondary` Badge + 状态点 + 8×8 幽灵图标按钮）；
- 本地转写与字幕翻译器配置面板的双列字段（`grid grid-cols-2 gap-3`）；
- 字幕翻译器「定时开始」末项折叠区的停靠写法（`-mb-3` + `border-b-0`）；
- 长文本翻译与转写队列的 `ToolFilePickerSurface`；
- 长文本 store 的逐字段 zod 清洗。

**实现（均在写集内）**

- `src/services/media-converter/controller.ts`：渲染进程的队列视图，模块单例 `getMediaConverterController()`，页面经 `useMediaConverterState()`（`useSyncExternalStore`）读取。
  - 首次订阅时先注册 `onChanged`，再读快照。读快照期间到达的事件先缓存，快照装入后只重放 sequence 更大的。快照用 `mediaConverterSnapshotSchema` 校验，不合格或请求失败时进入 `failed`（带错误码），下一个订阅者重试。没有 API 或 `supported` 为假时为 `platform_unsupported`。
  - 只应用 sequence 更大的事件。`items` 原位替换、新条目追加、删除 `removed`，未变的条目保持同一对象。`progress` 只替换对应条目的 `progress`，按条目节流 250 ms，窗口内只显示最新一次；同一条目的新摘要到达时，丢弃还在等待的进度。
  - `engine` 事件取 ready 状态里的 `resolvedEncoders`/`defaults`，检测中保留上次已知值，并清空计划缓存。快照的能力已是 ready 时，同样优先用能力里的值。
  - `batch-finished` 只在窗口不在前台时（`document.hasFocus()` 为假，可注入）调用 `showSystemNotification`。只取消的批次不通知。正文为成功、失败、跳过数，有节省时附 1024 进制的节省量。
  - `setOptions(patch)` 经 `set-options` 写到主进程。答复只在其间没有更新的 `options` 事件时才应用。`redetect()` 期间 `redetecting` 为真，`busy` 等失败以 `MediaConverterClientError` 交给界面。`hardwareEncodeRunning` 判断有没有运行中的条目在用硬件视频编码器（h264_mf 的软件模式除外）。
  - `previewPlan` 按「条目 + 设置签名」缓存（与字段顺序无关），条目变化或引擎变化时失效，失败的请求不缓存。其余命令是薄封装，请求同步发出，拖放的 File 在事件内仍可读。离开页面不退订，只有 `dispose()` 退订。
- `src/store/tools/media/useMediaConverterPreferences.ts`：持久化的 zustand store，键 `fusionkit.media-converter.preferences.v1`，版本 1。
  - 保存当前任务、三种任务各自的字段，以及输出位置（源文件旁，或主进程给的文件夹 id 与显示名）。
  - 不保存同名策略：`partialize` 不含它，`merge` 一律回到「自动编号」。低占用模式和并发数也不保存，它们在主进程。
  - 读取时在 `merge`/`migrate` 中用 contract 的 zod 字段 schema 逐字段清洗：非法字段回默认，其余保留，多余字段丢弃。面板写入时同样逐字段校验。`localStorage` 读写包在 try/catch 中。
  - 压缩的 `codec` 默认为 `null`，表示跟随快照的 `defaults.compressCodec`（AC-ENCODE-02-7），用户改选后保存所选值。
  - `toConversionSettings` 生成发往主进程的设置：显卡加速只在选 AV1 且本机有 AV1 硬件编码器时为真。`toOutputSelection` 生成输出参数。
  - `reconcileOutputDirectories(list)`：保存的文件夹 id 不在主进程的列表中时，回到「源文件旁」并返回 true，页面据此弹出提示；显示名变了就同步。主进程的每个请求都先等 `state.json` 恢复完成（ipc 的 `ready`），所以快照里的文件夹列表总是恢复后的，不会误报。
- `src/pages/Tools/Media/MediaConverter/MediaConverterSettings.tsx`：左侧 `ToolConfigPanel`。
  - 「任务」分段控件，默认「压缩视频」。切换后只显示该任务的字段，按任务重新挂载并淡入（减少动态效果时不动画）。
  - 压缩视频：
    - 「压缩档位」三段；
    - 「输出编码」竖排三段，以用途命名，下面是随所选编码变化的一句兼容性说明；
    - 检测完成后，所选编码在本机只能用弱 CPU 编码器（`resolvedEncoders[codec].weak`）时，说明下面显示一行琥珀色提示，末尾是「改用 AV1」。中文、日文句子以全角句号结尾时，链接紧接句号，不再插空格；英文句子后留一个空格。用键盘按「改用 AV1」后，提示消失，焦点移到 AV1 选项上，不会落回页面；
    - 「输出格式」（自动 / MP4 / MKV，带「?」说明自动的规则）与「分辨率上限」`Select` 同排两列，两个控件都是 28px 高；
    - 「使用显卡加速」只在选 AV1 且 `resolvedEncoders.av1.gpuOn.hardware` 为真时可用。不可用时整行可聚焦，Tooltip 说明原因：编码不是 AV1、本机没有 AV1 显卡编码器、或仍在检测。三种说明都告诉用户 HEVC 和 H.264 会自动使用显卡；
    - 「不比原文件小时丢弃」默认开。
  - 转换格式：「目标格式」`Select`，按视频（MP4/MKV/WebM/MOV）与音频（MP3/M4A/Opus/FLAC/WAV/ALAC）分组；「尽量只换封装」默认开；「重新编码时的画质」三段，目标为音频时改为「音质」与高 / 标准 / 小。
  - 提取音频：「输出格式」默认「保持原音轨（无损）」；「音质档位」只在 MP3/M4A/Opus 时出现；「全部音轨」默认关。
  - 末尾的「输出与性能」`ToolConfigDisclosure` 按 FK-PIT-0089 停靠面板底边，摘要为输出位置 · 同名策略（· 低占用）。内容如下：
    - 「输出位置」：选「指定文件夹」时调用主进程目录对话框，取消则仍为源文件旁；选定后用 `ToolOutputPathPicker` 显示文件夹名，可以重选。
    - 「同名文件」：选「覆盖」时显示琥珀色提醒。
    - 「低占用模式」：经 `controller.setOptions({lowUsage})` 写到主进程。只在快照还没有队列选项时禁用；保存过程中不禁用，开关保持键盘焦点。
  - 折叠规则：测量「输出与性能」展开时面板的高度，与窗口留给面板的高度（`innerHeight − 40px 吸顶 − 56px`；底部导航与 Agent 球在窗口底边以上 50px 内，另留 6px）比较。放不下时默认折叠，放得下时默认展开；用户手动开合后，本次以用户为准。连折叠后都放不下时，通知页面取消 aside 的吸顶（`lg:static`），面板末端可以随页面滚到。首次测量前关闭折叠过渡。
  - 主进程不再列出所保存的文件夹时，回到源文件旁，并弹出警告 toast。
- `src/pages/Tools/Media/MediaConverter/EngineStatusBadge.tsx`：页头右侧的引擎徽章（`Badge` 胶囊 + 状态点或转圈图标 + Tooltip）和「重新检测」图标按钮，两者间距 8px，与其他工具页头一致。
  - 检测中：未验证、检测中或快照尚未读到时显示。
  - 就绪：按家族显示硬件编码器，如「NVIDIA NVENC」，没有时显示「仅 CPU」。Tooltip 列出编码器友好名、本次降级的编码器，以及 `driverUpdates` 的驱动提示；NVENC 给出最低版本 570（AC-ENGINE-03-4）。有驱动提示时状态点为琥珀色。
  - 不可用：运行时失败优先于检测失败，胶囊显示「不可用：原因」，Tooltip 给出原因与处理建议。快照读不到也归入此状态，这时按钮改为重新读取快照。
  - 「重新检测」在检测中、请求进行中、或有硬件编码任务运行时禁用。禁用时外层可聚焦，由 Tooltip 说明原因；主进程答 `busy` 时用 toast 说明。
  - 状态文字另有 `role=status`、`aria-live=polite` 的隐藏播报。
- `src/pages/Tools/Media/MediaConverter/index.tsx`：
  - 页头放引擎徽章，aside 放设置面板（`order-2 lg:order-1`，过高时 `lg:static`）。
  - 主区放最小的上传区：`ToolFilePickerSurface` stacked，点击后调用 `controller.pickFiles("all")`，加入后 toast「已加入 N 个文件」。引擎不可用时上传区禁用，说明中写出原因与建议（AC-WORKBENCH-05-1），说明文字保持正文颜色，在整块变淡后仍然清楚。检测中仍可添加，只是不能开始。对话框打开期间不再禁用上传区（对话框是模态的，重复点击由一个 ref 挡掉），上传区不会在对话框背后变淡，按钮也不丢焦点。
  - 拖放、文件类型菜单、队列和完整的加入结果提示由 T-WORKBENCH-03 补齐。平台不支持状态（T-WORKBENCH-01）未改。
- `src/pages/Tools/Media/MediaConverter/labels.ts`：`as const` 映射，包括任务、档位、音频档位、以用途命名的编码与兼容性说明、输出格式、输出位置、同名策略、全部编码器友好名（含 `h264_mf_sw`）、硬件家族、引擎不可用原因与建议、请求错误；另有 `encoderLabel`、`hardwareFamilyOf`、`engineUnavailableCode`、`requestErrorLabel`。
- 四种语言的 `media.json` 都有 `upload`、`settings`、`engine`、`encoders`、`request_errors`、`notifications`（每种语言 135 个键）。T-WORKBENCH-01 的 4 个键原样保留。
- 测试：
  - `controller.test.ts`（16 项）、`useMediaConverterPreferences.test.ts`（8 项）。
  - `media-converter.electron.test.ts` 的 T-WORKBENCH-02 部分（5 项 Electron），覆盖内容见下文「交互覆盖」。

**渲染审查**

截图都来自 quiet Electron 中的最终代码。设备像素比为 2；1280×800、1024×700、786×540 的页面实际为 1292×806、1036×706、798×546（FK-PIT-0188）。审查顺序为方向 → 结构 → 细节 → 交互 → 适配。

实现时的初版审查发现以下问题，均已修复并复验：

1. **压缩面板在 1280×800 下放不下**
   - 现象：折叠「输出与性能」后，面板仍有 738（zh）/ 771（en）/ 806（ja）px，超过 716px 的可用高度。aside 因此取消吸顶，在最常见的窗口里随页面滚走。
   - 原因：竖排三段的输出编码、兼容性说明、CPU 弱编码器提示，加上两行开关，比设计粗估的 700–740px（含输出组）高约 250px。
   - 改动：「输出格式」与「分辨率上限」改为同排两列（项目已有的 `grid-cols-2 gap-3` 写法），`Select` 用 28px 的 `sm`；缩短弱编码器提示；底部预留由粗估的 72px 改为实测的 50px + 6px。
   - 复验：zh 667 / en 682，都小于 716，吸顶且默认折叠；同排两个控件顶边对齐、等高。
2. **提示中多一个空格**：zh、zh-Hant、ja 的弱编码器提示在全角右括号后多一个空格，已从文案中去掉。
3. **上传区的不可用原因太淡**：原因文字改用正文颜色，整块仍然变淡表示不可用。
4. **徽章与刷新按钮间距不一致**：由 4px 改为与其他工具页头一致的 8px。
5. **T-WORKBENCH-01 的目录测试失败**：应用切换路由时保留目录页的滚动位置，页面变高后页头量在 −39；测试在打开工具后先把滚动容器拉回顶部再量（`App.tsx` 不在写集内，产品未改）。

最终截图（`records/i1/screenshots/T-WORKBENCH-02-*.jpg`，共 45 张，来自评审 21:03 的最后一次运行）逐张观察：

- `-compress-light-zh-1280x800`、`-compress-dark-en-1280x800`：方向与转写、翻译各页一致：左侧 320px 配置面板，右侧 stacked 上传区，页头右侧为胶囊 + 刷新按钮。
  - 字段组间距 16px，同排两列顶边对齐（529/529），控件同高（28/28）。
  - 弱编码器提示 2 行，琥珀色在两种主题下都可读；中文「体积会偏大。改用 AV1」紧接，英文句点后一个空格接「Use AV1」。
  - 折叠的「输出与性能」停靠面板底边，没有多余分隔线。
  - 未滚动时面板末端（折叠组的标题）在窗口底边附近，左下角与浮动 AgentDock 球略有重叠；向下滚动约 100px 后面板吸顶，末端在底部导航以上（见风险）。
  - 选择器文字为 12px（与项目其他配置面板的 `Select` 一致），旁边分段控件为 11px，同排时略有差异，可以接受。
- `-compress-light-en-1024x700`、`-compress-end-light-en-1024x700`、`-compress-dark-zh-1024x700`、`-compress-end-dark-zh-1024x700`：折叠后仍高于可用高度（682/667 > 616），aside 不吸顶；滚到末尾能看到完整的折叠组与面板底边，在底部导航以上。英文「Maximum resolution」「Keep original」在半列中完整显示。
- `-compress-light-zh-786x540`、`-compress-dark-en-786x540`、`-compress-end-light-zh-786x540`、`-compress-end-dark-en-786x540`：窄窗口时上传区在前、设置在后，与其他队列页一致。面板占满宽度，弱编码器提示一行放下，面板末端在底部导航以上；没有横向溢出和被裁切的文字。
- `-compress-light-ja-1280x800`（抽查）：日文较长，H.264 兼容性说明折两行，弱编码器提示三行，「ます。AV1 に変更」紧接。折叠后 718px，比可用高度多 2px，所以不吸顶、随页面滚动，内容完整。日文按字换行（「大き／めです」）是浏览器对日文的默认断行，与其他页面一致。
- `-codec-{av1,hevc,h264}-light-zh`、`-codec-{av1,hevc,h264}-dark-en`：三句兼容性说明随所选编码切换。AV1 没有弱编码器提示；HEVC 显示 Kvazaar，H.264 显示 OpenH264。中文两行内放下，英文最多两行。
- `-gpu-tooltip-{h264,av1}-light-zh`、`-gpu-tooltip-{h264,av1}-dark-en`：显卡开关禁用时，Tooltip 在右侧打开，分别说明「只有最小体积可选」与「本机没有 AV1 显卡编码器」，都提示 HEVC/H.264 会自动用显卡；框随文字自适应。亮色下禁用开关的轨道很浅（共享 `ToolSwitchRow` 的 60% 不透明度），暗色下清楚；整行标题同样变淡，禁用状态仍可辨认。
- `-gpu-enabled-light-zh`、`-gpu-enabled-dark-en`（NVENC）：选 AV1 后开关可用，打开后为实心；没有弱编码器提示。
- `-convert-light-zh`、`-convert-dark-en`、`-convert-targets-light-zh`、`-convert-targets-dark-en`：转换格式的默认值为 MP4、尽量只换封装开、均衡；面板 628/674px，放得下，「输出与性能」自动展开，末项低占用开关距面板底边 12px。目标格式下拉按「视频 / 音频」分组，选中项打勾，十项完整。
- `-extract-light-zh`、`-extract-dark-en`：提取音频的默认值为「保持原音轨（无损）」，没有音质档位，「全部音轨」关；面板 577/592px，「输出与性能」自动展开。中文「全部音轨」说明第二行只剩「音轨」两字，是共享开关行的正常换行。
- `-output-light-zh`、`-output-dark-en`：选「覆盖」后摘要同步为「源文件旁 · 覆盖」，琥珀色提醒为 AC 原文；低占用说明两行，留白与上方字段一致。
- `-folder-fallback-light-zh`：保存的文件夹 id 已失效时，回到「源文件旁」，右上角警告 toast 显示完整文案（sonner 默认宽度下折两行）。
- `-engine-detecting-light-zh`、`-engine-detecting-dark-en`：转圈图标 +「正在检测编码能力 / Detecting encoders」，刷新按钮变淡禁用。
- `-engine-ready-cpu-light-zh`：绿色状态点 +「仅 CPU」。
- `-engine-ready-nvenc-light-zh`、`-engine-ready-nvenc-dark-en`：「NVIDIA NVENC」；Tooltip 标题加粗，每行一个编码器友好名。
- `-engine-driver-update-light-zh`、`-engine-driver-update-dark-en`：评审改为真实的「驱动过旧」状态：没有可用的显卡编码器，胶囊为「仅 CPU / CPU only」，状态点变为琥珀色；Tooltip 先说明全部由 CPU 编码，再写出「需要 570 或更新版本」并建议更新驱动后重新检测，没有外部链接。
- `-engine-redetect-busy-light-zh`、`-engine-redetect-busy-dark-en`：有 NVENC 任务运行时刷新按钮禁用，悬停外层显示「有显卡编码任务在运行，结束后才能重新检测」。
- `-engine-unavailable-light-zh-1280x800`、`-engine-unavailable-dark-en-786x540`：红色胶囊「不可用：编码组件已损坏」；Tooltip 分两层，原因加粗，建议在下。786 宽时页头描述让出空间折为两行，胶囊不被挤压。
- `-unavailable-page-light-zh-1280x800`、`-unavailable-page-dark-en-786x540`：上传区禁用，按钮变淡，说明写出原因与建议，与页头一致。

度量（全部数值在 `T-WORKBENCH-02-ui.txt` 中）：

| 窗口 | 语言 | 任务 | 展开高 | 折叠高 | 可用高 | 实际 | 位置 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1280×800 | zh | 压缩 | 903 | 667 | 716 | 折叠 | sticky |
| 1280×800 | en | 压缩 | 933 | 682 | 716 | 折叠 | sticky |
| 1280×800 | zh / en | 转换 | 628 / 674 | — | 716 | 展开 | — |
| 1280×800 | zh / en | 提取 | 577 / 592 | — | 716 | 展开 | — |
| 1024×700 | en / zh | 压缩 | 933 / 903 | 682 / 667 | 616 | 折叠 | static |
| 786×540 | zh / en | 压缩 | 885 | 649 | 456 | 折叠 | 单列 |
| 1280×800 | ja | 压缩 | 987 | 718 | 716 | 折叠 | static |

面板内没有被截断或省略的元素（测试中 `overflowing` 为空），任何窗口都没有横向溢出。

**交互覆盖（Electron 断言）**

- 三种任务切换与各自默认值；转换与提取在 1280×800 下自动展开「输出与性能」。
- 编码切换后三句说明、弱编码器提示（含中英文链接前的间隔）与「改用 AV1」；用键盘按「改用 AV1」后焦点落在 AV1 选项上。
- 显卡开关在 cpu_only 下禁用，并核对两种 Tooltip。
- 目标格式分组的十个选项；提取格式选有损格式后才出现音质档位。
- 选「覆盖」后的提醒。
- 低占用模式经主进程写入，`getSnapshot().options.lowUsage` 随之变化；重启后从主进程恢复；用键盘关闭时开关保持焦点。
- 重启后除「覆盖」外的设置全部恢复，`localStorage` 中没有 overwrite、lowUsage 或路径。
- 失效文件夹回退并提示，回退后的值已写回存储。
- 上传区经打桩的对话框加入文件：属性为 `openFile, multiSelections`，过滤器含 mp4/mkv/mp3/flac，主进程队列中出现 `picked.mp4`。
- NVENC 下默认 HEVC，AV1 的显卡开关可用。
- 注入一个真实形态的「驱动过旧」引擎事件（没有硬件编码器、全部 CPU 编码器、`driverUpdates` 为 NVENC 570）后，徽章为「仅 CPU」加琥珀色点，Tooltip 写出版本 570、没有编码器列表；恢复 NVENC 就绪状态后，注入一个使用 hevc_nvenc 的运行中条目，「重新检测」禁用。
- detecting_ms：检测中「重新检测」禁用、上传区可用、显卡开关说明「正在检测」；检测完成后可以重新检测，再次进入检测中，然后回到就绪。
- 不可用：徽章、Tooltip 与上传区都写出原因与建议。
- 打开的选择器按 Esc 先关闭，页面不返回。
- 全程没有 pageerror。

**评审与修复**

独立评审（20:31–21:10）读了本任务的全部代码、测试与记录，对照 requirements、design 的设计基准与渲染进程架构，以及转写队列、字幕翻译器页头与配置面板等参照实现；逐张查看了实现时的 34 张截图，修复后又逐张查看了最终的 45 张。发现与处理：

1. **低占用开关在保存期间禁用，键盘焦点丢失（主要，可访问性）**
   - 现象：开关在 `set-options` 往返期间 `disabled`，用空格切换后焦点落回页面，整行还会闪一下 60% 不透明度。
   - 改动：只在快照没有队列选项时禁用；保存期间保持可用（主进程按顺序应答，较晚的答复不会覆盖更新的 `options` 事件）。
   - 复验：Electron 中用键盘关闭低占用，开关保持焦点，主进程选项随之变化。
2. **「改用 AV1」按下后焦点落回页面（次要，可访问性）**
   - 现象：提示与按钮随编码切换一起消失。
   - 改动：切换后把焦点移到 AV1 选项上。
   - 复验：Electron 中用键盘按下后，AV1 选中且获得焦点。
3. **上传区在对话框打开期间禁用（次要）**
   - 现象：模态对话框背后的上传区变淡，按钮丢焦点。
   - 改动：不再因选择中而禁用，重复调用由 ref 挡掉。
   - 复验：上传区经打桩对话框加入文件的场景通过。
4. **中文、日文的「改用 AV1」前多一个空格（次要，文字排版）**
   - 现象：「体积会偏大。 改用 AV1」「ます。 AV1 に変更」，全角句号后又有空格。
   - 改动：句子以全角标点结尾时不插空格，英文仍留一个空格。
   - 复验：截图与 Electron 中对整行文字的精确断言（zh、en）。
5. **驱动过旧的场景是不可能出现的状态（测试证据）**
   - 现象：测试在「NVENC 可用」的状态上加了 NVENC 驱动过旧，截图里同时列出三个 NVENC 编码器和「驱动过旧」。
   - 改动：改为真实形态（没有硬件编码器、全部 CPU 编码器、默认 H.264），之后先恢复 NVENC 就绪状态，再检查硬件编码中的「重新检测」。
   - 复验：徽章为「仅 CPU」加琥珀色点，Tooltip 先说全部由 CPU 编码，再写出 570。
6. **单元测试中有一个恒真断言（次要，测试）**
   - 现象：`expect(h.state().items[0]).toBe(h.state().items[0])`。
   - 改动：改为与事件前取得的对象比较，未变条目保持同一对象，变化的条目换新。
   - 复验：新增变异 M20（`items` 事件重建未变条目）被发现，20/20。
7. **「放得下就默认展开」的分支没有被测试覆盖（次要，测试）**
   - 改动：在转换与提取任务下断言「输出与性能」自动展开，并记录面板高度。
8. **检查后无需改动**：
   - 序列去重、读快照期间的事件缓存、按条目 250 ms 的进度合并、只在失焦时通知、`set-options` 的版本判断；
   - 偏好的逐字段清洗、「覆盖」不持久化、失效文件夹回退（主进程请求先等恢复完成，不会误报）；
   - 折叠与吸顶的判定；
   - 渲染进程不发送任何路径，四种语言键对齐；
   - 测试中的 `describeMediaUi` 只在 `FUSIONKIT_MEDIA_E2E=1` 时运行，证据中 10 项都实际运行，没有跳过。
9. **未改（记录在风险中）**：
   - 1280×800 未滚动时面板末端与 AgentDock 球略有重叠；
   - 亮色下禁用开关的轨道很浅，属于共享 `ToolSwitchRow`；
   - 选择器与分段控件字号相差 1px；
   - 驱动过旧只在徽章 Tooltip 中说明。

评审只改了写集内的文件：`MediaConverterSettings.tsx`、`index.tsx`、`controller.test.ts`、`media-converter.electron.test.ts`，以及本记录、三份证据文件与 `screenshots/T-WORKBENCH-02-*.jpg`。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKBENCH-02-1 | 通过 | file:records/i1/T-WORKBENCH-02-unit.txt |
| V-WORKBENCH-02-2 | 通过 | file:records/i1/T-WORKBENCH-02-ui.txt |
| V-WORKBENCH-02-3 | 通过 | file:records/i1/T-WORKBENCH-02-static.txt |

- V-WORKBENCH-02-1（评审重跑，21:07）：`controller.test.ts` 16 项、`useMediaConverterPreferences.test.ts` 8 项，共 24 项通过，覆盖：
  - 按 sequence 去重，丢弃乱序事件，读快照期间的事件只重放更新的；
  - 进度按条目 250 ms 合并，只替换对应条目，其他行保持同一对象；
  - `batch-finished` 只在窗口失焦时通知，只取消的批次不通知；
  - 偏好往返恢复，非法值逐字段清洗，「覆盖」不持久化，失效文件夹回退到源文件旁；
  - 压缩编码跟随本机默认、改选后记住，显卡只在 AV1 且有硬件编码器时发出。
- 变异检查：20 个变异（含评审新增的 M20）全部被发现，源文件按字节还原（同一证据文件）。补充运行 T-WORKBENCH-01 的 `registration.test.ts`（12 项）与分段控件、布尔开关、配置折叠区三个共享控件的消费者测试（5 项），全部通过。
- V-WORKBENCH-02-2（评审重跑，21:03）：最后一次源码修改之后先 `pnpm run pretest`，再以 quiet 模式运行整个 `media-converter.electron.test.ts`，10/10 通过：T-WORKBENCH-01 的 2 项辅助函数测试与 3 项 Electron 场景，加本任务的 5 项。覆盖的视口、主题、语言与截图见上文；45 张最终截图已逐张查看。评审期间同样的组合共运行三次（20:46、20:55、21:03），三次都是 10/10。
- V-WORKBENCH-02-3（评审重跑，21:02–21:08）：`pnpm exec tsc --noEmit -p tsconfig.json` 没有诊断。三份测试文件不在 tsconfig 的 include 中，另用一份继承它的配置检查，同样没有诊断。`pnpm run i18n:check` 退出码 0：四种语言 media 都是 135 个键，「All source translation keys resolve.」。media 中的同值提示只有日文与中文相同的产品名（SVT-AV1（CPU）等）。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKBENCH-03-1 | 通过 | V-WORKBENCH-02-1, V-WORKBENCH-02-2 |
| AC-WORKBENCH-03-2 | 通过 | V-WORKBENCH-02-1, V-WORKBENCH-02-2, V-WORKBENCH-02-3 |
| AC-WORKBENCH-03-3 | 通过 | V-WORKBENCH-02-1, V-WORKBENCH-02-2, V-WORKBENCH-02-3 |
| AC-WORKBENCH-03-4 | 通过 | V-WORKBENCH-02-1, V-WORKBENCH-02-2, V-WORKBENCH-02-3 |
| AC-WORKBENCH-05-1 | 通过 | V-WORKBENCH-02-1, V-WORKBENCH-02-2, V-WORKBENCH-02-3 |
| AC-WORKBENCH-05-2 | 通过 | V-WORKBENCH-02-2, V-WORKBENCH-02-3 |

- AC-WORKBENCH-03-1 中「切换后未开始条目的处理计划同步更新」：本任务提供控制器一侧，设置签名不同就重新请求计划，条目或引擎变化时缓存失效，已有单元测试。计划的展示（`PlanSummaryView`，以及设置变化后防抖 300 ms 再请求）属于 T-WORKBENCH-03（AC-WORKBENCH-03-5）。本任务结束时还没有条目行，界面上没有可以同步的计划。这里的「通过」只指本任务负责的部分。
- AC-WORKBENCH-03-4 中「开始时，用确认框列出将被替换的文件」属于 T-WORKBENCH-04 的开始前确认。本任务交付的是覆盖提醒、「覆盖」只在本次会话有效，以及 `toOutputSelection` 把同名策略带给 `start`。
- AC-WORKBENCH-05-1 的「上传区禁用并显示原因」由本任务的最小上传区实现；T-WORKBENCH-03 在它上面加入拖放与文件类型菜单时，应保留这个禁用状态。

## 风险与未执行项

- **跨任务的验收子项。** 上文 AC 表下的三处子项，要在 T-WORKBENCH-03/04 完成后在集成版本上复核。
- **测试注入的状态。**
  - 驱动过旧提示与「有硬件编码任务在运行」两种状态，是测试经 `webContents.send('media-converter:changed', …)` 注入的事件：预加载照常校验后交给控制器，sequence 取快照之后的值。驱动过旧按真实形态注入（没有硬件编码器、全部 CPU 编码器）。主进程的测试开关不能产生这两种状态；真实 NVENC 驱动过旧、真实硬件编码中的「重新检测」答 `busy`，分别由 engine 的测试覆盖。
  - 引擎的就绪与不可用状态都来自 `FUSIONKIT_TEST_MEDIA_CAPS`，本任务没有在界面中跑真实的编码器检测。
- **驱动过旧只在 Tooltip 中说明。** 胶囊仍为「仅 CPU」，只有状态点变为琥珀色，悬停或聚焦后才能看到 570 与更新建议。这满足「提示所需的最低驱动版本」，但不够显眼；如需更醒目（例如胶囊写「仅 CPU · 驱动过旧」），可在 T-WORKBENCH-04 或 I2 中再定。
- **系统通知只做了单元测试。** quiet 窗口中 Playwright 让 `document.hasFocus()` 恒为真，Electron 中无法构造「窗口不在前台」。`batch-finished` 的通知逻辑由单元测试覆盖，真实批次的通知留给 T-WORKBENCH-04 的场景。
- **折叠与吸顶取决于内容。** 折叠只在面板放不下时发生。日文、CPU-only、1280×800 时折叠后比可用高度多 2px，所以不吸顶；1024×700 时所有语言都不吸顶，面板随页面滚动，末端仍可到达。没有弱编码器提示的机器（例如有 NVENC）矮约 50px。
- **1280×800 未滚动时面板末端靠近窗口底边。** 面板从约 137px 处开始，折叠后 667–682px，未滚动时「输出与性能」的标题在窗口底边附近，左下角与浮动 AgentDock 球略有重叠。页面底部留有空白，滚动约 100px 后面板吸顶，末端在底部导航以上。这与其他配置面板较长的工具页一致；队列加入后（T-WORKBENCH-03/04）主区变高，应在 V-WORKBENCH-04-2 的 AgentDock 遮挡检查中再看一次。
- **共享控件的观感。** 亮色下禁用的 `ToolSwitchRow` 轨道很浅；选择器为 12px、分段控件为 11px，同排时略有差异。两者都来自共享组件，与其他工具页一致，未改。
- **路由切换不归零滚动位置。** 这是应用现有行为：`App.tsx` 不在写集内。所有比窗口高的工具页，从已滚动的目录页打开时都会停在原来的偏移上。本任务只调整了测试的测量方式，没有改产品。
- **「重新检测」按下后焦点落回页面。** 按钮在检测期间禁用，这是项目中运行期间禁用按钮的通常做法；检测状态由 `aria-live` 播报。
- **上传区是最小实现。** 加入后只有一条「已加入 N 个文件」toast。重复、拒绝、超量的说明，拖放、文件类型菜单与队列，都由 T-WORKBENCH-03 完成。
- **通知中的体积格式化是临时实现。** 控制器内有一个 1024 进制的 `formatSaved`，T-WORKBENCH-03 新建 `format.ts` 后应改为复用它。
- **运行目录已删除。** 评审的所有运行目录（`test-results/media-converter/ui-*` 与截图暂存目录 `wb02r-review`）都在复制截图与度量后删除。test-results 下的其他内容未动。
