# 转写质量与复杂音频支持 批次验收（I1）

日期：2026-10-22（整体回归 2026-10-23）
批次：I1 可选复杂音频模式、质量复核与新模型
集成版本/工作树快照：工作树，基于 68ffd05（未提交）；包含 T-ASRQ-01..08、T-ASRQ-10 应用路径与 records/polish.md 的协调者修补
环境与测试数据：Windows 11、RTX 4070 Ti SUPER、whisper.cpp v1.9.1 CUDA；真实样本见 records/T-ASRQ-09-listening.md 的“样本音频”表；新模型文件在 `D:\fusionkit-asr-eval\models\`
执行人：用户（听审与界面验收）；Agent 只提供材料与自动化证据，不代签

## 用户场景与端到端验证

| 场景 / AC | 前置条件与步骤 | 预期 | 实际与证据 | 结果 |
| --- | --- | --- | --- | --- |
| 默认行为不变（AC-ASRQ-01-1） | 不改任何设置转写一个文件 | 与改动前一致（请求字段逐项相同） | 旧版对拍与执行器回放通过：records/T-ASRQ-02.md、records/regression.md | 自动化通过，待用户确认 |
| 音频类型预设（AC-ASRQ-01-2..5） | 转写设置 → 音频类型 → 选“低音量·耳语”或“嘈杂·音乐音效”；关闭语音检测看是否回到标准；看任务行标签 | 选项带“实验性”标记与说明；关 VAD 回到标准并提示；任务行显示类型 | records/T-ASRQ-02.md（界面截图）、records/polish.md 第 1 项 | 待用户确认 |
| 预设是否值得用（AC-ASRQ-07-2/3） | 按 records/T-ASRQ-09-listening.md 听 40 个区间，填写“结论”列 | 由用户判断；负对照 B-noise 上两个预设都编造了文字，因此只作为“实验性”提供 | records/T-ASRQ-09.md（B-noise 两个预设都出字，标准无字） | 待听审 |
| 门控增益（AC-ASRQ-02-*） | 随“低音量·耳语”生效 | 安静人声被提升、噪底提升 ≤ 6 dB、失败回退原音 | records/T-ASRQ-03.md；真实对照中 70 个窗口有 13 个被提升 | 自动化通过 |
| 逐句置信度与复核栏（AC-ASRQ-03-*） | 打开一份新转写的文档 → 工具栏“待复核” → 按原因筛选、上一个/下一个、播放、重新识别、折叠重复、忽略 | 只列出被标记的句子；原因清楚；不自动删改；撤销可恢复 | records/T-ASRQ-04.md、records/T-ASRQ-05.md（截图）；阈值经 T-ASRQ-09 校准一次 | 待用户确认 |
| 新模型（AC-ASRQ-04-*） | 资源面板下载/导入 turbo、Belle、anime-whisper；转写模型下拉只出现可整段转写的模型；turbo 不能选“翻译成英文” | 名称、大小、场景、许可提示正确；限制生效 | records/T-ASRQ-06.md（截图、真实导入与加载）；records/model-smoke.md | 待用户确认 |
| 两遍式重新识别（AC-ASRQ-05-*） | 用标准模型转写 → 复核栏或多选 → 重新识别 → 选 anime-whisper（日语）或 Belle（中文）→ 对比后逐句采用 | 只取本句文字、低音量剪辑增益、可疑结果有提示、不自动应用 | records/T-ASRQ-07.md；应用路径 records/T-ASRQ-10.md | 待用户确认 |
| 仅重识别模型的效果（AC-ASRQ-04-5） | 按 records/T-ASRQ-10-listening.md 听 28 句（可直接播放剪辑），填写“结论”列 | 由用户判断是否比 large-v3 原文更准 | records/T-ASRQ-10.md；修补后的复跑见 records/T-ASRQ-10.md 风险节 | 待听审 |
| 失败任务重试（AC-ASRQ-06-*） | 让一个任务失败或无内容（例如非语音文件）→ 点“重试”/“改用低音量·耳语重试”/“改用 CPU 重试”；复制诊断 | 不用重新选文件；文件改动时提示重新添加；诊断不含路径 | records/T-ASRQ-08.md（截图） | 待用户确认 |

## 适用的专项检查

- 界面：各 UI 任务在真实 Electron（静默离屏）1280×800 与 1024×700、浅/深色下截图并逐张审阅，修补后的界面由整体回归复核，见各任务记录与 records/regression.md。
- 兼容：旧文档（无置信度）可打开并只按文本规则复核；默认路径请求与窗口字节不变。
- 隐私：对照与冒烟只读样本与已安装模型，不上传任何音频；诊断不含路径。
- 未覆盖：CPU 与 macOS 上的预设/新模型实测；DTW/接缝修复在新模型上的表现（新模型走普通路径）。

## 集成检查与风险

- 整体回归（records/regression.md，独立复核通过）：tsc、4 个 provenance 检查、check-i18n、check_spec 全部通过；check-i18n-usage 的 40 条与 HEAD 逐行相同。全量 vitest 5908 项中 5787 通过、1 项失败（transcription-task-service 的一个用例在满载时超时，单独运行在本工作树与 HEAD 都约 11–14 s，属既有的负载超时）；26 个 Studio 相关 UI 套件 20 通过、6 失败，失败的 experience-transcription-ui、interaction-queue-ui、acceptance-queue-overview-ui、export-ui、speech-resources/shared-ui 以及 tool-spacing/tool-file-drop/tool-navigation 在 HEAD 基线上以相同断言失败；新的 cue-review-ui 只在大批并行时偶发丢失窗口句柄，单独运行两次通过。本批改动引起的唯一问题是 transcription-ui 截图助手在页面滑入动画未结束时就测量，已改为等待全部动画后测量。
- 修补界面复核：音频类型“实验性”标记、模型下拉宽度、重识别默认模型的截图均已逐张查看（records/regression.md 第 5 节），无裁切、无错位。
- 待用户决定：仅重识别剪辑的填充现在止于相邻字幕（records/polish.md 第 5 项）。真实复跑（records/T-ASRQ-10-recheck.txt）中，原先 7 句带进上一句词的情况全部消失；代价是与上一句首尾相接时，跨在边界上的词可能两边都听不全（28 句中 1 句：anime-whisper A #5 少了「うん」），另有 3 句用词变化。T-ASRQ-10-listening.md 是修补前的剪辑，修补后的剪辑在 `test-results/asr-quality-recognize/run-olRvTt/clips/`；若听审认为损失大于收益，可改为在相接一侧保留几十毫秒余量。
- 已知限制：两个预设会在非语音声音上编造文字；高置信度的编造句（如 B-noise 上 0.876 的句子）复核规则抓不到；复核在主进程同步计算（10 万句约 0.7 s）；仅重识别模型依赖已有字幕的时间轴，漏掉的句子不能补回。
- 回退方式：本批改动全部在工作树中且默认关闭；不提交即可完整回退。

## 验收结论

待验证：等待用户听审（records/T-ASRQ-09-listening.md、records/T-ASRQ-10-listening.md）与界面确认。确认人、来源与结论由用户填写。
