# 实施记录：T-ASRQ-06

| 字段 | 值 |
| --- | --- |
| 任务 | T-ASRQ-06 |
| 日期 | 2026-10-22 |
| 验证版本 | 工作树，基于 68ffd05（未提交）。新增：`src/subtitle-studio/transcription-model-profiles.ts`、`test/subtitle-studio/transcription-model-profiles.test.ts`、`test/subtitle-studio/model-profile-ui.test.ts`、`test/speech-resources/integration/new-models-real-import.test.ts`、本记录与 `records/T-ASRQ-06-{pins,unit,profiles,static,ui,ui-regression,import,broad}.txt`。修改：`resources/speech-resources/manifests/speech-models.v1.json`、`electron/main/speech-resources/engine/model-manifest.ts`、`resources/speech-resources/provenance/resource-engine-extraction.v1.json`、`test/speech-resources/engine/catalog.test.ts`、`electron/main/speech-resources/catalog-migration.ts`、`test/speech-resources/catalog-migration.test.ts`、`electron/main/network/download-sources.ts`、`test/network/download-sources.test.ts`、`electron/main/subtitle-studio/transcription/task-service.ts`、`src/pages/Tools/Subtitle/SubtitleStudio/{StudioTranscription.tsx,StudioTranscription.css,resource-names.ts,resource-names.test.ts}`、`src/locales/{zh,zh-Hant,en,ja}/studio.json`；写集外（见“偏离”）：`src/services/subtitle-studio/transcription-controller.ts`、`test/subtitle-studio/{transcription-controller,transcription-task-service}.test.ts`、`test/subtitle-studio/helpers/transcription-ui-runtime.ts`、`src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel{,.test}.ts`、`docs/features/asr-quality/design.md`（仅“界面设计基准·模型选择”一条） |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；vitest 2.1.9；vite 5.4.21 测试构建；Electron UI 在静默离屏窗口（FUSIONKIT_TEST_WINDOW=quiet）中运行；导入加载检查用开发运行时的 CPU whisper-server；模型文件只读取自 `D:/fusionkit-asr-eval/models/` |
| 任务指纹 | 30b03b095d1a79442b723166dee63f9b46d3be54a157eb409fd37f0bf552cc48 |

## 实际结果

### 固定条目与下载源

- 复核：三个文件都重新用 HF tree API 取 `size` 与 `lfs.oid`，再用 Range 0-47 读 ggml 头，与 design.md 模型表和 `D:/fusionkit-asr-eval/models/` 中本地副本的头完全一致（`file:records/T-ASRQ-06-pins.txt`）。
- 共享目录 `speech-models.v1.json` 与 `EXPECTED_MODELS` 在原两条之后按同一顺序追加三条，字段逐项相同：`large-v3-turbo-q8_0`（q8_0，MIT，`quantized-large-v3-turbo`）、`belle-large-v3-turbo-zh`（f16，Apache-2.0，`full-belle-large-v3-turbo-zh`，下载 `ggml-model.bin`、本地名 `ggml-belle-large-v3-turbo-zh.bin`；schema 与管理器只用 `fileName` 作本地文件名，不要求与 URL 末段相同）、`anime-whisper-q8_0`（q8_0，MIT，`quantized-anime-whisper`）。均 `defaultRecommended: false`、`multilingual: true`、`allowedDownloadHosts` 为 `huggingface.co` 与 `*.hf.co`；默认推荐仍只有 `large-v3-q5_0`，原有条目与顺序不变。
- 抽取 provenance：三个输出记录重算字节编辑（清单与 `model-manifest.ts` 各追加一个纯插入编辑，`catalog.test.ts` 作为 new 输出重写为整段插入），更新 `byteSize`/`sha256` 与原因；没有在抽取范围根目录下新建文件，输出数仍为 31。`catalog.test.ts` 改为把历史条目当作前缀比对，并断言三条新固定值。
- `catalog-migration.ts`：迁移只描述两个历史工具装过的模型；之后加入目录的模型没有历史来源，不进入迁移清单（避免每次启动对新模型目录做整文件校验，也避免其目录损坏时让共享服务因 `target_conflict` 进入 cleanupPending）。测试断言迁移资源仍是原四项、三款新模型不在其中。
- `download-sources.ts`：新增 `huggingface` 组，匹配 `https://huggingface.co/<owner>/<repo>/resolve/<rev>/<file…>`，候选为官方地址、再 `hf-mirror.com` 同路径加查询；`ggerganov/whisper.cpp` 组仍在前面先匹配（turbo 属于该组，ModelScope 的 viggocx、iceCream2025 两份副本对 turbo 返回相同大小与 LFS 哈希，cjc1887415157 返回 404，见 pins 证据）。下载传输与 SHA 校验未改动；“其他地址不处理”用例改为 datasets、blob、仓库页和 hf-mirror 自身等地址。

### 模型配置表与主进程校验

- 新文件 `src/subtitle-studio/transcription-model-profiles.ts`（不引入任何模块，渲染端与主进程共用）：按任务给定取值登记五个模型；未知模型取保守默认（整段转写、任意语言、可翻译、允许提示词）。提供 `transcriptionModelProfile`、`transcriptionModelSpeaks`、`transcriptionModelMismatch`（按“仅重识别 → 翻译 → 提示词 → 语言”给出第一项不符；锁定语言时 `auto` 也算不符；禁止提示词的模型连空提示词也不符，因为执行器会把空字符串照样发送）与 `fitTranscriptionConfig`（把英文输出改回原语言、语言改为模型自己的语言、去掉提示词，模型本身不改）。
- `task-service.ts` 在入队的 schema 校验之后、任何资源解析之前调用 `transcriptionModelMismatch`，不符时返回 `invalid_input`；执行器与冻结副本未改。

### 界面

- 资源面板：三款新模型显示中文名称（快速 / 中文普通话 / 日语动画·ASMR，括号内约略大小，与“标准”“最高精度”同一命名方式，即设计中的场景标签）、目录名、大小、状态；Belle 与 anime-whisper 另有“仅重新识别”“实验性”徽标；行内通栏两行说明：用途与推荐用法（先用其他模型转写，再逐句重新识别；anime-whisper 不使用提示词），以及许可提示（Belle：训练数据含非商用数据集；anime-whisper：训练数据禁止商用，仅供非商业用途）。仅重识别模型仍可下载与导入。
- 转写设置的模型下拉只列整段转写模型（标准、最高精度、快速），快速带一行用途说明；选中不能翻译的模型时“翻译为英语”为禁用选项并在字段下说明原因，控制器同时把输出改回“保留原语言”（保存与提交的都是改回后的值）。语言锁定（禁用其他语言并说明）与禁止提示词（禁用输入框并说明）已按通用方式实现，目前没有整段转写模型用到。控制器读取偏好时也做同样的回退；仅重识别模型若被直接设置（例如由 Agent 工具），就绪检查返回 `configuration_invalid`，不会提交。
- 旧版本地转写工具：`getReadyLocalSubtitleModels` 不再列出仅重识别模型；`createLocalSubtitleBatchRequest` 用同一个 `fitTranscriptionConfig`，turbo 选“翻译成英文”时提交的是原语言转写。`index.tsx`、`useLocalSubtitleTranscriberStore.ts` 等冻结源码未改，因此旧页面不显示禁用原因（见风险）。
- 实测与截图结论写入 design.md“界面设计基准·模型选择”。首轮截图发现两处问题并已修复复验：未安装行的用途说明挤在“下载 / 导入模型”旁，中文各剩一两个字折到第二行（改为行内通栏，中文各一行）；模型浮层固定为触发器宽度时英文模型名折行（改为不窄于触发器、最宽 22rem，英文名单行）。

### 冻结副本的运行时作用（任务要求的核查）

`electron/main/subtitle-studio/transcription/native/model-manifest.ts` 与 `electron/main/local-subtitle/model-manifest.ts` 仍只含两条，但生产组合里 Studio（`registerSubtitleStudio(speechResources)` → `createStudioSharedResources`）与旧版工具（`createLegacySharedResources`）都通过共享 `SpeechResourceService`（引擎 `model-manifest.ts`，已含新条目）解析、导入、列出模型；冻结副本在生产路径上只提供错误类（`LocalSubtitleModelError`）和各自旧根目录的启动清理定义，服务端进程契约、后端解析与任务服务都不按冻结清单校验模型 ID。没有运行时路径会拒绝新 ID，因此未改 `native/*`，也不需要协调者另排修改。隔离导入检查也证实三款模型经共享服务导入、校验并在 CPU 上加载成功（`file:records/T-ASRQ-06-import.txt`）。

### 偏离

- 任务步骤要求但不在 tasks.md 写集内的文件：`transcription-controller.ts`（任务要求控制器回退到转写）、`transcription-controller.test.ts` 与 `transcription-task-service.test.ts`（任务允许）、`localSubtitleTranscriberModel{,.test}.ts`（旧版工具的模型列表与提交，非冻结源码，未登记审计）、`test/subtitle-studio/helpers/transcription-ui-runtime.ts`（新增仅测试用的 `catalog-models` 控制命令，默认资源列表不变）、新测试 `test/subtitle-studio/{transcription-model-profiles,model-profile-ui}.test.ts`。
- 没有新增“场景标签”徽标：名称本身就是场景（快速 / 中文普通话 / 日语动画·ASMR），再加同义徽标会重复；用途与推荐用法写在说明行。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ASRQ-06-1 | 通过 | inline:证据文件 records/T-ASRQ-06-unit.txt；34 个文件通过、2 个跳过，293 项通过、4 项跳过；改动前同一命令为 290 通过、3 跳过，新增的是目录与镜像用例和一个门控的真实导入用例 |
| V-ASRQ-06-2 | 通过 | inline:证据文件 records/T-ASRQ-06-profiles.txt；模型配置表、入队拒绝仅重识别模型与 turbo 翻译且不解析任何资源、控制器回退与就绪检查、旧版工具模型列表与提交、偏好与任务契约、边界检查，8 个文件 152 项通过）。语言锁定与禁止提示词只能用合成配置在 `transcriptionModelMismatch` 单元测试中覆盖，当前没有整段转写模型用到 |
| V-ASRQ-06-3 | 通过 | inline:证据文件 records/T-ASRQ-06-static.txt；抽取校验 exact、31 个输出；tsc 退出 0；check-i18n 退出 0、四种语言各 4291 键；check-i18n-usage 40 个既有错误均在本任务以外的文件，与本任务开始前保存的结果相同；copy.mjs --check passed |
| V-ASRQ-06-4 | 通过 | inline:证据文件 records/T-ASRQ-06-ui.txt；真实 Electron 静默离屏，1280×800 与 1024×700、浅/深色、中英文：资源面板名称、大小、徽标、用途与许可说明，下拉只列整段转写模型，选中快速后“翻译为英语”禁用并说明、已提交请求为 transcribe；截图已逐张查看，首轮问题修复后复验通过）。语言锁定、禁止提示词的界面状态因没有可选的整段转写模型使用而未能渲染 |

补充证据：`file:records/T-ASRQ-06-broad.txt`（`test/app-update test/subtitle-studio src/pages/Tools/Subtitle src/services src/agent`，其中包含全部 `test/subtitle-studio-provenance`：195 个文件通过、57 个跳过，2735 项通过、70 项跳过；运行时同一工作树里也有并行任务 T-ASRQ-03/04 当时的改动）；`file:records/T-ASRQ-06-import.txt`（三款模型从本地文件导入隔离 userData，大小、SHA-256、ggml 头与 CPU 加载检查通过，结束后无 whisper-server 残留）；`file:records/T-ASRQ-06-ui-regression.txt`（同一测试构建上既有 UI 用例：audio-profile-ui 1 项、resources-dialog-ui 3 项通过；transcription-ui 1 项失败，见风险）。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ASRQ-04-1 | 通过 | V-ASRQ-06-1, V-ASRQ-06-3, V-ASRQ-06-4 |
| AC-ASRQ-04-2 | 通过 | V-ASRQ-06-2, V-ASRQ-06-4 |
| AC-ASRQ-04-3 | 通过 | V-ASRQ-06-2, V-ASRQ-06-4 |
| AC-ASRQ-04-4 | 通过 | V-ASRQ-06-1 |

## 风险与未执行项

- 2026-10-22 协调者修补：模型下拉最大宽度改为不小于触发器宽度，见 records/polish.md。
- AC-ASRQ-04-2 说明：turbo 的“翻译成英文”禁用并说明原因、主进程拒绝不一致提交已验证；语言锁定与禁止提示词的转写界面为通用实现，只有单元测试；中文/日语专用模型只用于重新识别，其对话框中的锁定与提示词处理属于 T-ASRQ-07
- AC-ASRQ-04-3 说明：anime-whisper（与 Belle）不出现在整段转写的模型选择中，资源面板说明推荐用法，已验证；在重新识别对话框中选择及其中的说明属于 T-ASRQ-07，本任务未验证
- AC-ASRQ-04-4 说明：单元层：候选顺序与地址映射；传输与 SHA 校验未改动且相关测试通过；未做真实镜像下载

- 重新识别对话框（`StudioCueRecognize.tsx`）列出全部已就绪模型，Belle 与 anime-whisper 一旦安装就能在那里选；现有重识别路径仍会发送用户填写的提示词、不发 `no_timestamps`，语言也不锁定。按冒烟结果，anime-whisper 走这条路径开头可能出现异常字符。需由 T-ASRQ-07 按模型配置表处理（`transcriptionModelSpeaks`、`profile.prompt`、`profile.timestamps` 已可复用）。
- 旧版本地转写工具的界面（冻结的 `index.tsx`）在选了 turbo 时仍可显示“翻译成英文”，实际提交为原语言转写，界面不说明原因；如需显示原因，要改冻结源码并登记 source audit。
- Agent 工具 `prepare_studio_transcription` 传 turbo 加 `translate_to_english` 时会被静默改为原语言转写；传仅重识别模型时提交失败（就绪检查 `configuration_invalid`），工具层没有专门的说明。
- 既有 `test/subtitle-studio/transcription-ui.test.ts`（`FUSIONKIT_STUDIO_T06_UI=1`）在“02-light-ready-media”截图前的左右留白断言失败（差 25.3px，容差 5px）。该状态使用默认模型，本任务在默认模型下不增加任何元素；未在 HEAD 构建上复跑，不能确认是否为既有问题。
  - 2026-10-23 整体回归已查明并修正（records/regression.md）：HEAD 导出副本上同一用例通过，工作树上失败，所以算本批改动引出的问题，但产品布局没有变化，问题在用例的等待条件。`capture()` 原来只等 `.studio-workspace-tabs` 内的动画结束，而路由切回字幕工作台时页面自身还有 300 ms 的滑入动画（App.tsx）。在 HEAD 上，标签区里恰好有一个 150 ms 的 `ToolSwitchRow` 颜色过渡（`transition-colors`，可能是指针停在该行上的悬停效果），用例等它结束时滑入已走到约 184 ms，左右留白差在容差内；工作树的设置栏多了音频类型字段等内容，这个过渡不再出现，测量落在滑入约 90 ms 处，留白差 22–33 px。修正只改 `test/subtitle-studio/transcription-ui.test.ts` 的 `capture()`：改为等待整页所有有限次动画结束后再量（`document.getAnimations()`），断言与容差不变。修正后该用例在工作树上通过（2 项）。
- 真实下载（官方源与 hf-mirror）没有执行；镜像只做了 1 字节 Range 探测（本机网络下 hf-mirror 308 回到 huggingface.co）。用户真实数据目录未改动。
- 新模型在 Studio 整段转写中的识别效果、turbo 的 CPU 速度与 Belle/anime-whisper 的重识别效果未测（T-ASRQ-10/07）；本任务只验证了导入、校验与 CPU 加载。
- 名称中的约略大小（如“约 0.8 GB”）与元数据中的精确大小（833.7 MB）单位不同，沿用了既有名称写法。
- 写集外改动与新增测试见“偏离”；`transcription-controller.ts` 与 T-ASRQ-02 的改动在同一文件中，提交时需一起审阅。
