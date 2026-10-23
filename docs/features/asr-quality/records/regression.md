# 整体回归：转写质量 I1（T-ASRQ-01..08、T-ASRQ-10 应用路径与 polish 修补）

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-23 00:00–00:45（同一步骤的前一次尝试在 2026-10-22 21:56–22:32 跑过一轮，见“修复”） |
| 验证版本 | 工作树，基于 68ffd05（未提交），包含 records/polish.md 第 1–5 项（第 5 项 `cueRecognizePadBounds` 在 2026-10-22 23:51 落盘，本轮全部检查都在它之后） |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；Playwright 1.58.2；RTX 4070 Ti SUPER 16 GB（驱动 610.88）；UI 用例 `FUSIONKIT_TEST_WINDOW=quiet`（离屏、不抢焦点） |
| HEAD 对照 | `git archive HEAD \| tar -x -C test-results/asrq-head-baseline`，其中 `scripts/translation-knowledge/build-artifacts.mjs` 的 zod LICENSE 路径改为 `../../node_modules`，`npx vite build --mode=test`；与 HEAD 逐文件比对（CRLF 归一）只有这一处不同。在该目录下运行失败用例，结束后已删除 |

## 1. 静态检查

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `node scripts/subtitle-studio-provenance/copy.mjs --check` | passed（120 个文件） |
| `node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check` | passed（1 个文件，26 个依赖） |
| `node scripts/subtitle-studio-provenance/shared-resource-integration.mjs` | exact: true（11 条） |
| `node scripts/subtitle-studio-provenance/shared-resource-extraction.mjs` | exact: true（29 源、31 输出、197 处编辑） |
| `node scripts/check-i18n.mjs` | exit 0 |
| `node scripts/check-i18n-usage.mjs` | exit 1，40 条：About 3、Help 8、PromptTemplates 11 与 `src/agent/prompt-templates.ts` 6、Setting 2、ToolTile 4、Tools 6。在 HEAD 对照目录运行同一脚本也是 40 条，逐行相同（含行号），没有新增 |
| `python …/check_spec.py docs/features/asr-quality --stage ready --require-approval` | 0 error，0 warning（编辑本轮记录后复查同样） |

## 2. 构建与全量单元/集成

- `npx vite build --mode=test`：exit 0，56 s。
- `npx vitest run --maxWorkers=4 --minWorkers=1`（后台，510 s）：文件 538 个，1 失败、443 通过、94 跳过；用例 5908 个，1 失败、5787 通过、120 跳过。跳过的主要是需要环境变量的 Electron 界面用例，见第 3 节。
- 唯一失败：`test/subtitle-studio/transcription-task-service.test.ts` 的“reclaims clean released-owner task history…”超时（15 s），分类见第 4 节。
- 不需门控的 Electron 用例在全量中都通过，包括以前在本机失败过的 `help.electron` 与 `external-agent-settings.electron`（剪贴板往返这次正常）。

## 3. 门控界面用例

命令：在仓库根目录设置 `FUSIONKIT_TEST_WINDOW=quiet` 与下列门控变量后 `npx vitest run --maxWorkers=4 --minWorkers=1 <文件…>`（227 s）。

门控变量：`FUSIONKIT_STUDIO_E2E`、`FUSIONKIT_STUDIO_I5_TRANSCRIPTION_UI`、`FUSIONKIT_STUDIO_T06_UI`、`FUSIONKIT_STUDIO_AUDIO_PROFILE_UI`、`FUSIONKIT_STUDIO_MODEL_PROFILE_UI`、`FUSIONKIT_STUDIO_RETRY_UI`、`FUSIONKIT_STUDIO_TRANSCRIPTION_UI`、`FUSIONKIT_STUDIO_RESOURCE_UI`、`FUSIONKIT_STUDIO_I6_QUEUE_UI`、`FUSIONKIT_STUDIO_I3_QUEUE_UI`、`FUSIONKIT_TRANSCRIPTION_EMPTY_UI`、`FUSIONKIT_STUDIO_T09_UI`，均为 1。

| 用例文件 | 结果 |
| --- | --- |
| subtitle-studio/audio-profile-ui | 通过 |
| subtitle-studio/model-profile-ui | 通过 |
| subtitle-studio/transcription-ui | 通过（2 项；修复见第 5 节） |
| subtitle-studio/cue-recognize-ui | 通过 |
| subtitle-studio/cue-recognize-models-ui | 通过 |
| subtitle-studio/transcription-retry-ui | 通过 |
| subtitle-studio/cue-find-ui | 通过（2 项） |
| subtitle-studio/cue-editing-ui | 通过 |
| subtitle-studio/transcription-document-ui | 通过 |
| subtitle-studio/resources-dialog-ui | 通过（3 项） |
| integration/transcription-empty-result-ui | 通过（2 项） |
| subtitle-studio/cue-audio-ui、cue-audio-track-ui、cue-listening-ui（2 项）、cue-shift-ui（2 项）、cue-split-insert-ui | 通过 |
| subtitle-studio/preview-expansion-ui、remove-translation-ui、translation-recovery-ui、recovery-batch-ui | 通过 |
| subtitle-studio/cue-review-ui | 失败（负载），单独复跑 2 次通过 |
| subtitle-studio/experience-transcription-ui | 失败，HEAD 相同 |
| subtitle-studio/interaction-queue-ui | 失败，HEAD 相同 |
| subtitle-studio/acceptance-queue-overview-ui | 失败，HEAD 相同 |
| subtitle-studio/export-ui | 失败，HEAD 相同 |
| speech-resources/shared-ui | 失败，HEAD 相同 |

合计：文件 26 个，6 失败、20 通过；用例 34 个，6 失败、28 通过。

另跑了工具页的门控用例（`FUSIONKIT_TOOL_UI_E2E=1`，`--maxWorkers=3`）：`tool-spacing`、`tool-file-drop`、`tool-navigation` 三个都失败，HEAD 对照上三个以相同断言失败。T-ASRQ-06 改过旧版本地转写工具的模型列表，所以一并确认。

## 4. 失败分类

| 用例 | 分类 | 证据 |
| --- | --- | --- |
| transcription-task-service › reclaims clean released-owner task history… | 负载导致的超时，既有 | 全量中 15 s 超时。单独运行整个文件：工作树 14.6 s、10.8 s 通过，HEAD 11.05 s 通过。只跑这一项，工作树与 HEAD 交替各 3 次：工作树 14.0 / 11.7 / 11.2 s，HEAD 11.9 / 11.1 / 11.2 s，全部通过。两边耗时相同，都接近 15 s 上限；每批第一次偏慢 |
| cue-review-ui（T-ASRQ-05 新用例） | 负载不稳定，非回归 | 26 个文件一起跑时，第 323 行 `size()` 的 `win.evaluate`（主进程 BrowserWindow 句柄）报 “Execution context was destroyed”。单独复跑 2 次都通过（49.9 s、49.7 s）；前一次尝试的 16 文件批次中也通过。新用例在 HEAD 上不存在，无法对照 |
| experience-transcription-ui:103 | 既有 | 工作树与 HEAD 都在第 103 行失败：`studio-transcription-media-row` 期望 1、实际 0。这一步是 Radix Select 选择后紧接的拖入，关闭动画期间页面其余部分带 `aria-hidden`，拖放范围不接收文件 |
| interaction-queue-ui:208（HEAD 为 206） | 既有（本机） | 两边都在“取消任务”提示处失败（`getByRole('tooltip')` 未找到）。工作树多出的 2 行在第 156–163 行，是 T-ASRQ-08 的新断言（可复制诊断、清理中不能重试），失败点之前它们都已通过 |
| acceptance-queue-overview-ui:177 | 既有（本机） | 两边相同：`getByRole('tooltip')` strict mode 解析到 2 个元素（“批量翻译”与“翻译任务…”） |
| export-ui:140 | 既有 | 两边相同：Esc 关闭导出对话框后，期望“下载”按钮获得焦点，元素未找到 |
| speech-resources/shared-ui | 既有（测试构建问题） | 两边相同：esbuild 打包时报 `electron/main/external-agent/skill.ts:4:18: No loader is configured for ".md" files`，用例 0.2 s 内失败 |
| tool-spacing / tool-file-drop / tool-navigation | 既有（本机） | 两边断言相同：tool-spacing 为 `subtitle-studio-light-1280 tool-panel-header` 的内边距 6/6/6/12 px 对 8/12/8/12 px；tool-file-drop 在第 156 行定位到 0 个元素；tool-navigation 停在 `#/external-agent` |

结论：本轮没有由 ASRQ 改动造成、且仍未修复的失败。

## 5. 修复（前一次尝试做出，本轮复核）

同一回归步骤的前一次尝试（2026-10-22 21:56–22:32，被中断）发现以下 3 个工作树失败，并只改了测试。本轮的最终运行中三者都通过。

1. `test/subtitle-studio/transcription-ui.test.ts`：工作树失败、HEAD 通过，属于 ASRQ 改动引出的问题，但产品布局没有变化。“02-light-ready-media”截图前的左右留白差为 22–33 px，容差 5 px。探针比对两边的动画后查明：页面切回字幕工作台时有 300 ms 的滑入动画（App.tsx）。`capture()` 原来只等 `.studio-workspace-tabs` 内的动画。HEAD 上那里恰好还有一个 150 ms 的 `ToolSwitchRow` 颜色过渡，测量因此推迟到滑入约 184 ms 处；工作树的设置栏布局变了，这个过渡不再出现，测量落在滑入约 90 ms 处。修复：`capture()` 改为等待整页所有有限次动画（`document.getAnimations()`），断言与容差不变。已写入 records/T-ASRQ-06.md 的风险节。
2. `test/subtitle-studio/audio-profile-ui.test.ts`：按 polish 第 1 项更新断言，不是回归。选项文字现在含“实验性”标记，初跑结果为 `['标准','低音量·耳语实验性','嘈杂·音乐音效实验性']`。`options()` 改为只取名称，并断言标记。见 records/T-ASRQ-02.md。
3. `test/subtitle-studio/cue-recognize-models-ui.test.ts`：按 polish 第 3 项更新断言，不是回归。对话框默认模型由转写设置的“标准”变为文档转写稿记录的“最高精度”（large-v3）。见 records/T-ASRQ-07.md。

本轮没有再改任何产品代码或测试；没有改动受审计的 native/*、transcript-executor.ts 或组合文件，审计记录不需要更新。

## 6. 界面复核（records/polish.md 第 1–3 项）

截图来自本轮门控运行（`test-results/studio-t06-ui/controlled-yF5MzI`：音频类型；`controlled-We4BvF`：模型；`test-results/studio-cue-recognize-models/run-hrB5kU` 与 `test-results/studio-cue-recognize/`：重识别）。嘈杂预设的提示在套件中没有截图，另用一次性探针补拍（`controlled-6xUyG8`，复制 audio-profile-ui 后只加了“选嘈杂并截图”两处，跑完已删除探针文件）。均用 Read 逐张查看。

| 状态 / 位置 | 观察 |
| --- | --- |
| 音频类型下拉，浅色 1280×800（asrq02-light-1280-options） | 三项。“低音量·耳语”“嘈杂·音乐音效”名称后有描边小标记“实验性”，与名称同一行、垂直居中；说明在下一行。列表与触发器同宽（294 px），没有裁切或溢出；标准项的勾在右侧，不与标记相碰 |
| 同上，浅色 1024×700（asrq02-light-1024-options） | 选中“低音量·耳语”，勾在右侧，标记完整；列表盖住下方的提示属于下拉正常遮挡 |
| 同上，深色 1280×800（asrq02-dark-1280-options） | 标记在深色背景下清楚，名称与说明对齐不变 |
| 同上，深色 1024×700 英文（asrq02-dark-1024-english-options） | “Quiet · whispers”“Noisy · music & effects”后的“Experimental”标记与名称在同一行，说明一行放下，无裁切 |
| 低音量提示，浅色 1280 中文（asrq02-light-1280-quiet） | “实验性：放宽语音检测…请用“待复核”逐句检查。”共 3 行，左缘与触发器对齐，行距与其他字段提示一致 |
| 低音量提示，深色 1024 英文（asrq02-dark-1024-english） | 4 行，正常断词，不溢出 |
| 嘈杂提示，浅色 1280 中文（探针 asrq02-probe-light-1280-noisy） | 3 行；探针量得宽 294 px，与触发器相同，`scrollWidth` 不超出 |
| 嘈杂提示，深色 1024 英文（探针 asrq02-probe-dark-1024-english-noisy） | 5 行，不溢出。英文句中的全角「」两侧留白偏宽，这是全角字形本身的宽度，可接受，未改 |
| 模型下拉，浅色 1280 / 浅色 1024 / 深色 1280（asrq06-*-model-options） | 列表宽 294 px，等于触发器；三个名称各一行，“快速”的说明在第二行，没有裁切。5 个状态的 `noHorizontalOverflow` 都为 true |
| 模型下拉，深色 1024 英文（asrq06-dark-1024-english-model-options） | 列表宽 338.7 px，比触发器宽，左缘超出触发器 22.5 px，仍在视口内；名称各一行，说明完整。“不窄于触发器”成立 |
| 重识别对话框默认模型（run-hrB5kU/01-models-1280-light） | 文档转写稿记录 large-v3，本会话尚未选择，默认显示“最高精度（约 2.9 GB，较慢）”，没有用转写设置的“标准”。下拉中中文普通话与日语动画·ASMR 带“仅重新识别”“实验性”两个标记，说明换行，没有裁切 |
| 原有重识别用例（studio-cue-recognize--01-results-1280-light） | 转写稿为 large-v3-q5_0，默认“标准（推荐，约 1.0 GB）”，结果列表与“应用 3 条”正常 |
| 其他 | 1024 宽时标题栏的“FusionKit”胶囊压在上传区标题上，这是既有标题栏行为，T-ASRQ-02 已记录，未处理 |

未覆盖：640–1023 px 双栏布局中模型字段占满一行时的宽触发器情形，本轮没有截图。CSS 用 `max(var(--radix-select-trigger-width), …)`，按构造不会窄于触发器。

## 7. 真实音频复跑（records/polish.md 第 5 项）

命令：`FUSIONKIT_ASR_AB=1 FUSIONKIT_KEEP_TEST_RUNS=1 npx vitest run --maxWorkers=1 --minWorkers=1 test/asr-quality/recognize-smoke.test.ts`，2026-10-23 00:26–00:27，65 s，一次通过。运行目录 `test-results/asr-quality-recognize/run-olRvTt`，备份在 `D:/fusionkit-asr-eval/recognize-runs/run-olRvTt`。`failures=[]`，两个服务进程都已退出，运行前后 `whisper-server` 都是 0 个。原文与对照见 records/T-ASRQ-10-recheck.txt。

与 run-0fDn3f 相比：

| 句 | 修补前 | 修补后 | 是否仍以上一句的词开头 |
| --- | --- | --- | --- |
| Belle #4 | 所以爱丽丝。 | 爱丽丝 | 否 |
| Belle #6 | 你你就修改了它。 | 你就修改了他。 | 否 |
| Belle #8 | 当然，A班的杰奎琳同学拜托我的。 | A班的杰奎琳同学拜托我的。 | 否 |
| Belle #15 | 可是这是贝尼尼教授的得意之作。 | 这是贝尼尼教授的得意之作。 | 否 |
| Belle #17 | 而且还是校董定制的私人肖像。 | 还是校董定制的私人肖像。 | 否 |
| anime-whisper A #4 | め…いや、なんかさ、ちょっと徒歩で向かっててさ… | いや、なんかさ、ちょっと徒歩で向かっててさ | 否 |
| anime-whisper C #2 | な、なんか触り方に情緒がない… | なんか触り方に情緒がない | 否 |

副作用：样本里的字幕多为首尾相接，修补后剪辑普遍短了 200–400 ms。A #5 丢了原文也有的「うん、」，它可能跨在两句的边界上，两边都没听全。A #2 的「あ、」只在 A #1 末尾出现一次，修补前是同一个音出现在两句。C #3 不再有「いえ」，large-v3 原文本来也没有。另有几处识别波动：A #1「来た」→「した」，A #5「二駅」→「二息」，Belle #1「家」→「加」。逐句说明已追加到 records/T-ASRQ-10.md 风险节（2026-10-23）。

## 8. 清理

- HEAD 对照目录 `test-results/asrq-head-baseline` 已删除（含前一次尝试留下的 3 个探针文件）。本轮的探针 `test/subtitle-studio/zz-asrq-noisy-hint-probe.test.ts` 跑完即删。
- 运行结束后没有残留的 Electron、whisper-server 进程；`%TEMP%` 下没有 `asrrr-*`、`asrab-*`。没有结束过任何不是本轮启动的进程（另一个项目 motion-3d-lab 的 vite 开发服务器未动）。
- 保留：`test-results/asr-quality-recognize/run-olRvTt`（复跑证据，含用户素材剪辑，git 已忽略）以及本轮门控运行的截图目录。

## 9. 风险与未执行项

- transcription-task-service 那一项单独运行就需要 11–14.6 s（每批第一次偏慢；2026-10-23 00:42 独立复核单跑为 14.3 s），离 15 s 上限很近，全量负载下会继续偶发超时（HEAD 相同）。
- cue-review-ui 在大批量并行时偶发 Playwright 句柄失效，原因没有查明，单独运行稳定。
- 仅重识别剪辑不再越过相邻字幕后，边界正好在词中间的句子可能丢掉这个词（28 句中 1 句）。是否在相接的一侧留几十毫秒余量，需要听审后决定，本轮没有改。听审清单 records/T-ASRQ-10-listening.md 仍是修补前的结果。
- 全量与门控用例都在离屏静默窗口中运行，没有在真实前台窗口复核。
- 未提交。
