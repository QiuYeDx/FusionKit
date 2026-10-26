# workbench 任务

每个任务块就是唯一的任务台账，不另写状态汇总表；总览由脚本生成。任务只引用需求与 AC 编号，不复制 AC 文本。

## 通用验证约定

- 静态检查：`pnpm exec tsc --noEmit -p tsconfig.json`、`pnpm run i18n:check`。
- 组件与单元测试：`npx vitest run --maxWorkers=4 --minWorkers=1 <路径>`。
- Electron UI 测试：先执行 `pnpm run pretest`（即 `vite build --mode=test` 加预加载检查），再执行 `FUSIONKIT_MEDIA_E2E=1 npx vitest run test/media-converter/media-converter.electron.test.ts`。
  - 窗口模式默认 quiet：离屏、不抢焦点、静音。
  - 测试数据放在 `createTestRun('test-results/media-converter')` 创建的运行目录中，并以 `--user-data-dir` 隔离。
  - 主进程的测试开关见 engine design §9。
- 渲染审查的截图放在 `records/i1/screenshots/`，每张截图配一段文字观察。
- 只运行目标测试，不跑全量测试套件。用户可能在玩游戏，所以 UI 测试只在 quiet 模式下运行。

### T-WORKBENCH-01 工具注册、目录分区、文案骨架与 UI 测试骨架

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKBENCH-01 |
| 验收 | AC-WORKBENCH-01-1, AC-WORKBENCH-01-2, AC-WORKBENCH-01-3 |
| 依赖 | T-ENGINE-06 |
| 写集 | src/pages/Tools/_shared/toolMeta.ts, src/pages/Tools/index.tsx, src/App.tsx, src/constants/router.ts, src/index.css, src/i18n/constants.ts, src/i18n/resources.ts, src/locales/zh/media.json, src/locales/en/media.json, src/locales/ja/media.json, src/locales/zh-Hant/media.json, src/locales/zh/tools.json, src/locales/en/tools.json, src/locales/ja/tools.json, src/locales/zh-Hant/tools.json, src/locales/zh/common.json, src/locales/en/common.json, src/locales/ja/common.json, src/locales/zh-Hant/common.json, src/pages/Tools/Media/MediaConverter/index.tsx, src/pages/Tools/Media/MediaConverter/registration.test.ts, scripts/i18n-usage-manifest.mjs, test/media-converter/media-converter.electron.test.ts, test/media-converter/helpers/media-ui.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design「注册与目录」完成：
  - 注册工具、添加 `--tool-media` 的亮色和暗色值；
  - 声明 `MEDIA_TOOLS`，位置在 `EXPERIMENTAL_TOOLS` 之后、`type FeaturedItem` 之前，按 `supported` 决定是否渲染，并计入工具总数；
  - 添加路由。macOS 上不跳转，显示「平台不支持」页内状态；
  - 在 `ToolNameMap` 中登记；
  - 页面骨架：`ToolDetailLayout` + `ToolPageHeader`。
- 新建 `media` 命名空间，四种语言都有骨架键。登记到 `NAMESPACES` 与 `resources` 中。在 i18n 清单的 ToolTile 与 BottomNavigation 条目中追加新的键（必做）。
- 建立 UI 测试骨架 `media-ui.ts`，负责：
  - 用 `runIf(FUSIONKIT_MEDIA_E2E)` 控制是否运行；
  - `createTestRun`、quiet 窗口参数、`--user-data-dir`；
  - 在运行目录中用 lavfi 生成素材；
  - 对话框与 shell 打桩（`app.evaluate`）；
  - 用 DataTransfer 模拟拖放；
  - 设置测试开关的环境变量。

  后续任务在 `media-converter.electron.test.ts` 中追加各自的场景。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKBENCH-01-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 src/pages/Tools/Media/MediaConverter/registration.test.ts src/agent/capability-catalog.test.ts（检查路由、TOOL_META、ToolNameMap、分区是否随 supported 显示；能力目录测试仍然通过） | - |
| V-WORKBENCH-01-2 | static | required | pnpm run i18n:check 与 pnpm exec tsc --noEmit -p tsconfig.json；另外确认 i18n 清单中已追加 media 磁贴和 common:menu.media.converter 的键（清单是唯一的检查路径） | - |
| V-WORKBENCH-01-3 | browser | required | quiet Electron：(a) 打开 /tools，在 1280×800 下亮色、暗色各截一张图，确认分区标题、磁贴、计数和工具色，并与失败色对比；(b) 按 Esc 和返回按钮都回到 /tools，底部导航显示工具名；(c) 在 quiet 模式下运行 FUSIONKIT_TOOL_UI_E2E=1 npx vitest run test/tool-navigation.electron.test.ts 与 test/e2e.spec.ts 的目录断言，结果与 HEAD 基线一致；(d) 把 supported 设为 false 后，路由显示「平台不支持」页内状态 | - |

### T-WORKBENCH-02 控制器、偏好设置与设置面板

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKBENCH-03, R-WORKBENCH-05 |
| 验收 | AC-WORKBENCH-03-1, AC-WORKBENCH-03-2, AC-WORKBENCH-03-3, AC-WORKBENCH-03-4, AC-WORKBENCH-05-1, AC-WORKBENCH-05-2 |
| 依赖 | T-WORKBENCH-01, T-ENCODE-04 |
| 写集 | src/services/media-converter/controller.ts, src/services/media-converter/controller.test.ts, src/store/tools/media/useMediaConverterPreferences.ts, src/store/tools/media/useMediaConverterPreferences.test.ts, src/pages/Tools/Media/MediaConverter/index.tsx, src/pages/Tools/Media/MediaConverter/MediaConverterSettings.tsx, src/pages/Tools/Media/MediaConverter/EngineStatusBadge.tsx, src/pages/Tools/Media/MediaConverter/labels.ts, src/locales/zh/media.json, src/locales/en/media.json, src/locales/ja/media.json, src/locales/zh-Hant/media.json, test/media-converter/media-converter.electron.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 写前端代码前，先读 `.agents/skills/fusionkit-ui-design/SKILL.md`，按 design「设计基准」实现。
- 控制器（design「渲染进程架构」）：取快照、按 sequence 处理事件、`batch-finished` 时发通知、`setOptions`。
- 偏好设置 store：用 zod 清洗；「覆盖」不持久化；指定文件夹失效时回退到源文件旁。
- 设置面板：
  - 三种任务各自的字段与默认值；
  - 输出编码按用途命名，配三句兼容性说明；
  - 输出格式：自动 / MP4 / MKV；
  - 显卡加速开关的可用判断与 Tooltip（来自快照的 `resolvedEncoders`）；
  - CPU 弱编码器提示，以及「改用 AV1」；
  - 输出位置、同名文件（含覆盖提醒）、低占用模式（经 `set-options` 写到主进程）；
  - 面板过高时，折叠「输出与性能」。
- 引擎徽章：三种状态，加上「重新检测」及其忙碌时的禁用态。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKBENCH-02-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 src/services/media-converter/controller.test.ts src/store/tools/media/useMediaConverterPreferences.test.ts（事件按 sequence 去重，丢弃乱序事件；进度合并；batch-finished 只在窗口失焦时通知；偏好设置能往返恢复；非法值被清洗；「覆盖」不被持久化；失效文件夹回退到源文件旁） | - |
| V-WORKBENCH-02-2 | browser | required | quiet Electron，视口 1280×800、1024×700、786×540，亮色与暗色，zh 与 en。截图：三种任务的设置面板（含默认值）；三句兼容性说明；显卡加速禁用时的 Tooltip；CPU 弱编码器提示（FUSIONKIT_TEST_MEDIA_CAPS=cpu_only）；引擎徽章的检测中（detecting_ms）、就绪、不可用三种状态（unavailable:runtime_invalid）。测量 aside 高度，超出视口时确认已折叠。按 design 的审查顺序记录问题，修复后复验 | - |
| V-WORKBENCH-02-3 | static | required | pnpm run i18n:check 与 pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-WORKBENCH-03 添加文件、媒体信息、处理计划与损失警告

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKBENCH-02, R-WORKBENCH-03 |
| 验收 | AC-WORKBENCH-02-1, AC-WORKBENCH-02-2, AC-WORKBENCH-02-3, AC-WORKBENCH-02-4, AC-WORKBENCH-03-5, AC-WORKBENCH-03-6 |
| 依赖 | T-WORKBENCH-02 |
| 写集 | src/pages/Tools/Media/MediaConverter/index.tsx, src/pages/Tools/Media/MediaConverter/MediaQueue.tsx, src/pages/Tools/Media/MediaConverter/MediaQueueRow.tsx, src/pages/Tools/Media/MediaConverter/PlanSummaryView.tsx, src/pages/Tools/Media/MediaConverter/format.ts, src/pages/Tools/Media/MediaConverter/format.test.ts, src/pages/Tools/Media/MediaConverter/labels.ts, src/locales/zh/media.json, src/locales/en/media.json, src/locales/ja/media.json, src/locales/zh-Hant/media.json, test/media-converter/media-converter.electron.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 上传：
  - 用 `ToolFilePickerSurface`；点击后调用主进程对话框，可选视频、音频或全部；
  - 用页面级 `useToolFileDropTarget` 接收拖放；
  - 没有条目时用 stacked 布局，有条目后切到 horizontal，切换时有高度过渡；
  - 超过 100 个文件、拖入文件夹、拖入无法还原的临时副本、重复加入时，都给出提示。
- 队列行：基于 `StudioTaskQueueRow`，包含以下状态：
  - analyzing；
  - unsupported：原因码转成文案，并给出建议；
  - not_applicable：提供一键切换任务；
  - 元数据 chips、HDR 标记；
  - 一行损失警告。
- 处理计划：展开时请求，设置变化后防抖 300 ms 再请求；编码器显示友好名称。
- 格式化工具：体积按 1024 进制，标为 MB/GB；时长、码率、帧率、百分比按当前语言格式化。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKBENCH-03-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 src/pages/Tools/Media/MediaConverter/format.test.ts | - |
| V-WORKBENCH-03-2 | browser | required | quiet Electron。素材在运行目录中由 lavfi 生成：竖屏 HEVC、带 PGS 与样式 ASS 的 MKV、带封面的 FLAC、伪造的 mp4、超长文件名。分别通过对话框（打桩）和拖放加入，再拖入一个文件夹，最后一次加入 101 个文件。截图检查：analyzing、unsupported、not_applicable 三种行及切换按钮；元数据 chips 的换行；文件名中间省略与 Tooltip；行内损失警告；展开后的处理计划；重复与超量提示；文件夹提示。视口为 1280×800 与 786×540，亮色与暗色，zh 与 en。审查后修复并复验 | - |

### T-WORKBENCH-04 队列操作、开始前确认、进度与结果

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKBENCH-04, R-WORKBENCH-03, R-ENGINE-05 |
| 验收 | AC-WORKBENCH-04-1, AC-WORKBENCH-04-2, AC-WORKBENCH-04-3, AC-WORKBENCH-04-4, AC-WORKBENCH-03-6, AC-ENGINE-05-1 |
| 依赖 | T-WORKBENCH-03, T-ENGINE-07 |
| 写集 | src/pages/Tools/Media/MediaConverter/MediaQueue.tsx, src/pages/Tools/Media/MediaConverter/MediaQueueRow.tsx, src/pages/Tools/Media/MediaConverter/index.tsx, src/locales/zh/media.json, src/locales/en/media.json, src/locales/ja/media.json, src/locales/zh-Hant/media.json, test/media-converter/media-converter.electron.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 标题栏操作：
  - 全部开始：引擎检测中或不可用时禁用，并用 Tooltip 说明原因；
  - 全部取消：点击后弹出 `ConfirmDialog`；
  - 清除已完成。
- 开始前确认：合并以下几类内容——损失警告、有损转无损、将被覆盖的文件。每项可以「改为 MKV」或跳过。
- 行内操作按状态显示：开始、取消、重试、仍然转换、移除。
- 进度：用原生 `<progress>`；时长未知时为不确定状态。速度、剩余时间等数字用等宽数字，并预留宽度，避免数值变化时界面抖动。
- 结果：成功、部分完成、已跳过、失败（打开 `ErrorDetailModal`）、已中断、已取消、输入已变化。每种结束状态都通过 `aria-live` 播报。
- 汇总栏、离开页面提示、系统通知。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKBENCH-04-1 | browser | required | FUSIONKIT_MEDIA_E2E=1 npx vitest run test/media-converter/media-converter.electron.test.ts（quiet 模式；用随附的真实 ffmpeg 处理 2 s 小样，低优先级）。依次检查：加入 3 个文件后全部开始，开始前确认框列出带 PGS 的 MKV，点「改为 MKV」后计划随之变化；运行中进度递增；取消一个后，它的临时文件被删除；完成的行显示体积变化，点「在文件夹中显示」时 FUSIONKIT_TEST_MEDIA_REVEAL 记录到调用；用 FUSIONKIT_TEST_MEDIA_FAIL 注入失败后，详情弹窗显示错误码和脱敏日志（不含绝对路径），重试后成功；高度压缩的源显示「已跳过」，点「仍然转换」后成功；离开页面再回来、以及重载窗口后，进度继续；FUSIONKIT_TEST_MEDIA_CAPS=detecting_ms 期间「全部开始」处于禁用状态；aria-live 区域播报完成信息 | - |
| V-WORKBENCH-04-2 | browser | required | 渲染审查：30 个混合状态的条目（运行中、完成、部分完成、失败、跳过、中断），视口为 1280×800、1080×786、1024×700、786×540，亮色与暗色，zh 与 en，并滚动到底部。检查：列表密度；行内层级；靠角留白（用 DOM 测量，与转写队列对照）；AgentDock 是否遮挡；数值刷新时是否抖动（连续截 3 帧）。修复后复验 | - |
| V-WORKBENCH-04-3 | static | required | pnpm run i18n:check 与 pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-WORKBENCH-05 I1 集成验收材料

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-WORKBENCH-01, R-WORKBENCH-02, R-WORKBENCH-03, R-WORKBENCH-04, R-WORKBENCH-05 |
| 验收 | AC-WORKBENCH-01-1, AC-WORKBENCH-02-2, AC-WORKBENCH-03-2, AC-WORKBENCH-04-3, AC-WORKBENCH-05-1 |
| 依赖 | T-WORKBENCH-04, T-ENCODE-05 |
| 写集 | docs/features/media-converter/acceptance-I1.md |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 在集成版本上，按 brd 成功条件 1–4 整理用户场景，内容包括：步骤、预期、实际与证据（截图与校准报告）。场景须覆盖：
  - 用真实样片做压缩（包括 iPhone HEVC/HDR 样片）、转换、提取音频；
  - 默认输出的播放检查：iPhone 15 Pro 之前的机型（或其他 A16 及更早的设备）、一台 Android 手机、微信 PC 版与手机版的内置播放器、Windows「照片」/「媒体播放器」。逐项记录能否播放；
  - 低占用模式：开启后，统计 ffmpeg 的 CPU 时间与墙钟时间之比，确认占用不超过所分配的逻辑核数。
- 写明未覆盖的范围：Intel/AMD 硬件编码、macOS、I2/I3 的能力，以及 Q-04 许可事项的状态。
- 验收由用户执行并签字，Agent 不代签。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKBENCH-05-1 | manual | required | 用户按 acceptance-I1.md 在真实应用中逐项操作：用真实样片做压缩、转换、提取音频，在列出的设备与 App 上播放默认输出，记录结果文件与界面观察 | - |
