# Changelog

本项目的所有重要更改都将记录在此文件中。

## [0.3.0] - 2026-08-23

### 新增

- 新增独立的本地字幕转写工具：支持批量添加 1～100 个音频或视频、媒体探测与音轨选择、managed Whisper 模型、原文转写或翻译为英语、可选 VAD，以及 SRT/LRC 导出
- 新增本地模型、VAD 和 Windows CUDA 候选加速包的受管资源生命周期，覆盖固定 manifest、续传下载、大小与 SHA-256 校验、占用门禁、删除和启动孤儿清理；模型与可选资源不进入默认安装包
- 本地字幕结果支持源目录或自定义目录、自动编号或安全覆盖、分页预览、复制、定位文件、结构化错误详情、取消与重试，并可选择仅导出、加入字幕翻译队列或加入后立即开始翻译
- 字幕 AI 翻译任务新增模型 API 实际 Token 用量累计与费用显示；失败、重试和检查点恢复会保留已发生用量，并与剩余预估明确区分
- DeepSeek Chat Completions 字幕翻译新增 Thinking 模式开关，任务编辑、自动字幕导入和检查点恢复均保留任务创建时的选择

### 优化

- 本地转写任务队列按真实 FIFO 执行顺序稳定展示；字幕翻译任务改为“进行中、未开始、已完成”的优先级排序，避免运行任务沉到待处理任务之后
- 本地转写进度只在耗时的转写阶段显示单一百分比，并统一分片数量、进度条和百分比的数据来源，移除容易误解的阶段/整体双百分比
- 分离“任务列表源文件去重”和“输出字幕冲突策略”：同一路径文件在可见队列中拒绝重复添加，源媒体名称不再提前追加编号；仅在写出同名字幕时执行自动编号或安全覆盖
- 改进稀疏语音、长静音和 ASMR 类音频的字幕时间线整形及质量判定；可恢复的转写/后处理异常会进行受控重试，并向错误详情保留安全、可定位的诊断信息
- 统一工具配置中的分段选择器、布尔开关和折叠面板交互，补充本地环境资源状态、运行后端预览和 About/README 的实际 Electron 构建信息
- 更新 DeepSeek V4 Flash / Pro 默认 Token 单价为官网 2026-08-22 高峰 cache-miss 价格；非高峰价格为默认值的一半，用户可按实际使用时段调整模型 profile

### 修复

- 修复从 Windows 资源管理器拖入文件时 shell 临时代理路径导致授权立即过期的问题；安全桥会恢复并绑定原始文件身份，文件选择与拖拽现在使用一致的任务授权链路
- 修复开发重启、preload 能力差异和会话重建后可能出现 `invalid_ipc_request`、`authorization_expired` 或安全覆盖组件被错误降级的问题
- 修复普通 WAV/长音频在后处理阶段被过严质量规则误判为 `transcript_quality_failed`、相同文件重试结果不稳定，以及错误详情缺少实际失败原因的问题
- 修复转写已完成且预览可见、但字幕文件未落盘或输出名称被错误编号的问题，并完善自动编号与原子覆盖事务的恢复和清理
- 修复自动字幕翻译交接中的 `invalid_content`、`owner_released` 和所有权提前释放问题，保证“转写 → 导出 → 加入翻译任务 → 精确启动新增任务”的链路使用不可变回执完成交接
- 修复任务列表显示顺序与实际执行顺序不一致、转写进度分子分母与百分比不对应，以及已完成任务状态更新后排序不稳定的问题
- 修复模型/VAD/CUDA 下载取消、瞬态网络失败、资源占用、严格模式重复探测和 WDDM 冷启动预算等场景下的卡住、误报或残留资源问题

### 安全与隐私

- 本地推理默认离线；媒体、字幕、时间戳和真实路径不上传，Renderer 持久化与公开 IPC 不暴露真实路径、模型 identity、临时 WAV、授权 token 或完整诊断
- 文件、目录、输出和字幕交接采用绑定 renderer owner 的 capability；自动翻译只消费一次性 artifact token、冻结的翻译配置快照和不可变新增 taskId 回执
- 资源下载仅接受内置 `resourceId`、固定 host allowlist、预期体积与 SHA-256，不允许 Renderer 提交任意下载 URL、可执行文件、路径或后端标志

### 测试与文档

- 新增本地字幕转写 Final Design、Execution Plan、逐工作包实施记录与发布说明，覆盖资源体积、磁盘、隐私、恢复、卸载保留、平台证据和第三方许可边界
- 扩展本地字幕 domain/IPC、文件与目录授权、Windows 拖拽、资源下载、媒体规范化、字幕整形/导出、队列与进度、GPU admission、翻译交接、恢复和原子覆盖事务的自动化测试矩阵
- 新增字幕翻译实际用量、DeepSeek Thinking、任务排序、翻译配置快照和 path-free 自动导入链路的回归测试

### 依赖

- Electron 更新并固定为 `41.10.6`，新增 preload bundle 完整性检查，同时同步 README、About 页和构建元数据测试中的运行时信息

### 限制

- Windows CUDA 12.4 候选包的第三方许可状态仍为 `pending`，禁止对外分发；Linux、Windows arm64 和 macOS x64 不在本地字幕首版范围
- Windows x64 installer/目标 NVIDIA、macOS arm64 签名与公证、Electron 四语言与可访问性、长时稳定性和最终隐私/许可扫描仍需在正式发布前完成独立验收

## [0.2.11] - 2026-07-15

### 修复

- 修复字幕翻译任务因输出 token 上限（max_tokens）过低导致模型响应被截断（finish_reason=length）后任务直接失败、无法重试的问题
- 输出 token 上限不再按分片大小做比例计算，改为直接使用模型的实际最大输出能力（如 DeepSeek V4 Flash 384K、GPT-5.x 128K），从根本上避免截断
- 内置模型预设新增 `maxOutputTokens` 字段，补充 DeepSeek V4 / GPT-5 全系列的精确输出上限
- 自定义模型（Model.Other）支持在 profile 中显式设置最大输出 token 数；未设置时由 `inferMaxOutputTokens` 根据模型名称自动推断（覆盖 Claude、Gemini、Qwen、Mistral、Llama 等主流模型）
- 保留 `length_truncated` 自动翻倍重试作为兜底安全网，防止极端场景下仍然截断

### 新增

- 模型配置新增 API 格式选择，支持 OpenAI Responses API 与 Chat Completions / OpenAI Compatible 两种调用协议并存
- OpenAI profile 新建时默认使用 Responses API，DeepSeek 和 Other profile 默认继续使用 Chat Completions，旧配置升级后保持原有调用格式
- 新增统一模型运行时客户端，长文本翻译、字幕翻译、名称翻译和 HomeAgent 可按 profile 的 API 格式选择对应 adapter
- 长文本翻译、字幕翻译和名称翻译支持 Responses API 非流式文本调用，统一处理 `store:false`、usage、截断、空响应、限流和错误分类
- HomeAgent 新增 Responses API 工具循环支持，可处理流式文本、function call、tool result 回填、多步工具循环、取消和 usage 统计
- 设置页模型列表拉取改为基于规范化 base URL 派生 `/models`，兼容历史 `/chat/completions` 与 `/responses` endpoint 输入
- 新增音频工具箱首版，包含音频转文本、文本转音频、实时字幕和 Realtime/WebRTC 双向语音四个工具入口
- 设置页新增独立“音频”导航与 `fusionkit-audio-settings` 配置域，支持创建 OpenAI、MiMo 和自定义 OpenAI-compatible 音频 API；音频凭证不再依赖文本模型档案，并可分别为四类音频任务设置默认 API
- 音频 API 改为按任务和生成模式配置可信 route；同一 OpenAI API 可同时提供文件音频与 Realtime 能力，同一 MiMo API 可同时提供 ASR、预置音色、音色设计和音色复刻能力
- 音频转文本支持 OpenAI 官方 transcriptions 契约和 MiMo `mimo-v2.5-asr` adapter，并按当前 route 约束仅展示适用的语言、格式、prompt、时间戳和 stream 选项
- 文本转音频支持 OpenAI Audio TTS，以及 MiMo `mimo-v2.5-tts`、`mimo-v2.5-tts-voicedesign`、`mimo-v2.5-tts-voiceclone` 三种模式
- MiMo TTS 三模式接入非流式保存和 PCM16 低延迟流式播放链路，完成后保存为本地音频文件
- 实时字幕支持 OpenAI Realtime/WebRTC 麦克风字幕；MiMo 或非 Realtime profile 下提供分块近实时字幕，不伪装为原生 WebRTC
- 双向语音首版支持 OpenAI Realtime/WebRTC 的连接、断开、静音、打断回复、远端音频播放和 user / assistant 转写 timeline

### 安全与隐私

- Responses API 请求默认发送 `store:false`，降低模型服务端保存请求内容的风险
- 任务恢复清单、工作区 manifest 和事件日志不持久化 API Key、Authorization header 或完整模型请求体
- 模型运行时错误信息增加 API Key 脱敏与统一错误分类，避免敏感凭据泄露到 UI 或日志
- 音频工具页只读消费设置页的独立音频 API 与任务 route，不保存独立 provider、API Key、base URL、transport 或模型 ID
- OpenAI Realtime 长期 API Key 仅在 Electron 主进程用于创建 ephemeral credentials，Renderer 不接触长期凭据
- 音频运行时和 IPC 避免把本地音频 Base64、PCM chunk、完整请求体、Authorization 或 `api-key` header 写入 Zustand 持久化、任务恢复或错误详情
- 音频公开 IPC 改为精确 allowlist；文件、参考音频和输出目录使用绑定 renderer owner、带有效期的 capability token，参考音频 token 单次消费，公开结果仅返回 output token
- 音频任务通过 sender-bound 配置快照与 revision 解析可信 route，Renderer 无法覆盖凭证、transport、模型 ID 或任意本地路径
- 音频取消、离页和 renderer 销毁会回收请求、媒体、临时文件及未消费授权；供应商错误详情按敏感字段、Bearer、路径、Data URI 和长 Base64 内容脱敏
- README 补充音频隐私提示：本地音频文件、录音片段和麦克风内容会发送到用户选择的第三方音频 API 服务

### 优化

- 更新 OpenAI 模型预设列表，新增 `gpt-5.5`、`gpt-5.5-pro`、`gpt-5.4`、`gpt-5.4-pro`、`gpt-5.4-mini`、`gpt-5.4-nano`，并校准 GPT-5.5 / GPT-5.4 / GPT-5 系列默认上下文窗口与价格
- 校准 DeepSeek V4 Flash / Pro、`deepseek-chat`、`deepseek-reasoner` 默认上下文窗口为 1M，并修正 DeepSeek V4 Pro 与兼容别名默认价格
- 长文本翻译配置页的上下文预算提示、进度条、超限判断和任务参数改为跟随当前模型上下文窗口，避免 1M 上下文模型被固定 32K 默认值误导
- 优化文件名翻译路径选择入口，将原“文件/文件夹”按钮拆分为明确的“文件”和“仅文件夹”，避免 Windows/Linux 原生选择弹窗无法混选时误导用户
- 优化文件名翻译清空当前选择体验，清空路径和预览时保留输出模式、语言、命名风格、冲突策略等用户配置
- 优化文件名翻译预览表格，左侧显示长文本 Tooltip，加宽新名称列，将操作列固定在右侧，并为固定列左侧增加渐变过渡遮罩
- 优化文件名翻译左侧已选路径列表，增加最大高度、内部纵向滚动和上下边缘渐变遮罩，并修复长文件名/路径导致的横向溢出
- 优化文件名翻译计划警告与高风险确认体验：警告按计划/具体条目标明来源并完整换行展示，确认弹窗新增警告详情、风险说明和固定 Header/Footer 的可滚动布局
- 接入 qiuye-ui `ThemeTransitionToggle` 与 `SmoothCorners`，更新底部主题切换、工具卡片、配置面板、统计栏和文件拖拽区的视觉表现，并移除旧截图遮罩主题切换链路
- 更新 qiuye-ui CodeBlock、ImageViewer、Markdown 表格容器与 Mermaid 渲染适配，改善代码、图片和复杂 Markdown 内容的交互与展示
- 优化音频 API 首次配置流程：第一条 API 可自动分配尚未配置的兼容任务，支持安全撤销；route 编辑、使用中删除和替换 assignment 采用原子校验，工具页可精确跳转设置并返回
- 文本转音频按当前 provider 和生成模式只展示有效字段，支持模式草稿恢复、可用 route 自动回退、Voice Clone 文件重新授权，以及 MiMo 三模式直接切换
- 音频转文本、实时字幕和双向语音全面迁移到独立 assignment 与 route 约束，语言、格式、voice、stream 等选项由共享 Provider Registry 统一决定
- 四个音频工具和字幕文件翻译复用 `ToolRadioButtonGroup`，统一按钮组视觉、方向键、Home/End、roving tabindex 和窄屏布局
- 四个音频工具 Store 仅持久化清洗后的用户偏好，不再恢复任务状态、错误、媒体会话、文件授权或转写结果

### 修复

- 修复 React 19 与 Zustand 因派生 selector 快照引用不稳定导致四个音频工具页无限更新并白屏的问题
- 修复音频任务在配置同步、文件授权、快速双击、取消、route 切换或 SPA 离页期间可能复用一次性 token、迟到派发、遗留运行态或泄漏远端请求的问题
- 修复 OpenAI Realtime GA 事件、模型与格式合同不一致的问题，区分字幕与双向语音模型，并正确处理 response 完成、播放缓冲结束和打断清理
- 修复 TTS 首包丢失、尾音未播放完即结束、取消后残留输出、严格 Base64/音频格式校验不足，以及流式输出发出 delta 后错误重试可能重复计费的问题
- 修复 ASR 在不同 OpenAI/MiMo 模型下响应格式、时间戳、prompt、stream、语言和文件限制不准确的问题，并完善输出保存与临时文件清理
- 修复长文本 Markdown 翻译因模型遗漏、重复、乱序或改写受保护占位符而导致分片失败的问题；校正重试后可确定性修复占位符漂移，并支持继续部分完成任务和查看失败分片详情
- 修复文件名翻译的超长无空格警告撑破应用卡片或 Radix ScrollArea、导致内容横向溢出的问题，以及高风险确认弹窗只显示“包含警告”而不展示具体警告的问题
- 修复音频 API 旧配置跨 Zustand key 迁移可能因 hydration 顺序、损坏数据、重复 ID 或写入失败而静默丢失凭证、route 或 assignment 的问题
- 修复 MiMo HTTP 402 余额不足仅显示通用拒绝提示的问题；参数错误会在安全白名单内标明具体字段，MiMo 预置音色改用官方 allowlist 并在 Renderer、主进程和 adapter 三层校验
- 移除没有测试入口支撑的音频 API“未验证”状态和失败门禁；MiMo 分块实时字幕遇到成功但为空的静音片段时继续录音，普通文件空转写仍保持失败语义
- 修复实时字幕和双向语音在麦克风授权悬置、WebRTC 启动失败、远端 track 无 streams、配置变化、清空对话或播放失败时可能遗留媒体资源或丢失打断入口的问题

### 测试与文档

- 新增 v0.2.11 文件名翻译体验修复设计文档、执行计划和实施记录
- 新增清空选择保留配置的 store 单测，覆盖路径清空不重置用户配置的行为
- 新增文件名翻译警告详情聚合与换行合同测试，并通过暗色 `786×540` Electron 场景验证摘要、确认弹窗和内部 ScrollArea 无横向溢出
- 新增 OpenAI 新旧 API 格式兼容设计文档、执行计划、fake server fixture、运行时 adapter 测试和逐工作包实施记录
- 新增 Chat / Responses 双格式回归测试矩阵，覆盖模型 endpoint normalization、profile v3 迁移、长文本翻译、字幕翻译、名称翻译和 HomeAgent 工具循环
- 新增模型预设与上下文窗口校准测试和验收修复文档，固定 OpenAI / DeepSeek 关键模型默认上下文窗口断言
- 新增音频工具箱 final design、execution plan、逐工作包实施记录和 fake audio API server
- 新增音频契约、音频 profile migration、endpoint normalization、OpenAI/MiMo ASR/TTS、MiMo 流式 TTS、Realtime session、IPC/service facade 和四个音频工具页面的自动化测试
- 新增 qiuye-ui 接入的设计文档、执行计划和实施记录，并完成 TypeScript、生产构建与旧主题截图链路引用检查
- 新增独立音频 API 配置与 UX 重构的 final design、execution plan、迁移/运行时/四页面实施记录，以及发布审计和逐项修复文档
- 新增源码翻译 key AST usage checker 与动态 key manifest，并将 `i18n:check` 扩展为 locale parity 和源码引用可解析性双重门禁
- 补齐音频设置、四个音频工具、OpenAI/MiMo route、三种 MiMo TTS 模式、文件/目录授权、取消与资源清理的单元测试、Electron 交互测试和宽窄窗口视觉回归
- 完成四个音频页面的发布审计，闭环白屏、IPC 信任边界、Realtime 生命周期、流式输出、供应商约束、可访问性和国际化问题；fixture、构建及多语言 Electron 矩阵通过

### 依赖

- 新增 `@qiuyedx/smooth-corners`，移除旧主题截图遮罩链路使用的 `html-to-image` 与 `@reactuses/core`

### 限制

- OpenAI/MiMo 真实供应商、Electron 麦克风/扬声器权限、OpenAI Realtime/WebRTC 远端音轨和 MiMo `voicedesign` / `voiceclone` 低延迟流式状态仍需发布前手工验收；fixture 与自动化矩阵不能替代真实供应商和设备验证
- 独立音频 API 配置重构的专项自动化门禁 `TEST-R01` 与真实环境验收 `QA-R02` 仍待完成
- MiMo Chat Audio 首版不提供原生 WebRTC 双向语音；双向语音页仅对配置了 `realtimeVoice` route 的音频 API 启用

## [0.2.10] - 2026-07-01

### 新增

- 新增通用长文本翻译工具入口，支持单个或多个 TXT / Markdown 文件、快速并发模式、有序项目和批量独立任务队列
- 新增长文本连贯串行翻译模式，支持语义记忆、跨文件记忆延续、文件前记忆重置、重翻过期分片和串行模式费用提示
- 新增长文本任务工作区、事件日志、分片结果落盘、暂停、取消、部分完成、恢复、重启、删除、打开工作区和打开输出文件能力
- 新增长文本输出模式：仅译文、TXT 双语简洁模式、TXT 双语标签模式，以及 Markdown 仅译文和 blockquote 双语模式
- 新增 Markdown 端到端翻译能力，包含 AST parser、保护占位符、模型响应协议映射、并发翻译、串行翻译、恢复与输出组装
- 新增文件编码探测、主进程文件读取、分片规划、上下文预算校验、输入 token 估算、费用估算和资源限制检查
- 新增 OpenAI Compatible 客户端、响应协议校验、重试策略和全局公平请求调度器，供长文本翻译执行链路复用
- 长文本翻译页面新增执行模式说明、恢复弹窗、项目排序、独立任务队列视图、任务状态统计和工作区型任务面板

### 优化

- 统一工具详情页 UI，字幕翻译、字幕转换、字幕语言提取、文件名翻译和长文本翻译迁移到共享布局、配置面板、统计栏、文件拖拽区和字段组件
- 长文本翻译详情页改为更紧凑的双栏布局，优化配置分组、任务密度、恢复入口、响应式表现和多语言文案
- 复用输出路径选择器，统一字幕工具与长文本翻译的输出目录选择体验
- 优化文件名翻译路径选择与应用摘要区域，修正工具详情页弹窗溢出和路径选择器交互细节
- 优化启动加载页视觉表现，补充主进程到 preload 的初始进度同步，并让加载页颜色更稳定地跟随主题
- 优化主题切换初始化和遮罩过渡初始化，减少启动后首次切换主题时的状态错位

### 安全与隐私

- 长文本翻译 Renderer 只传递文件路径和配置，不读取或通过 IPC 发送整本正文
- API Key 仅用于运行时请求，不写入长文本翻译工作区
- README 补充长文本翻译 Beta 范围、模型服务隐私提示和串行模式费用提示

### 修复

- 修复长文本翻译批量任务失败时可能缺少明确失败反馈的问题，失败会同步到任务状态、错误提示和 toast
- 修复长文本翻译事件订阅级联导致部分失败状态不稳定的问题
- 修复 OpenAI Compatible 请求失败时错误信息不易定位的问题
- 修复长文本翻译页面底部导航标题、Beta 残留文案和部分布局细节问题
- 修复启动加载页初始进度、主题颜色和视觉层级在部分启动场景下不稳定的问题
- 修复主题遮罩切换首帧初始化异常的问题

### 测试与文档

- 新增长文本翻译类型契约、IPC 契约、文件读取、编码探测、Markdown AST、输出组装、语义记忆、请求调度、模型响应协议和服务端到端测试
- 新增 fake OpenAI Compatible Server、资源策略探针和编码 / Markdown / 协议验证用例，覆盖长文本翻译关键链路
- 新增通用长文本翻译工具设计文档、执行计划、实施记录和修复记录
- 新增工具详情页 UI 标准化设计文档、执行计划和迁移记录
- 新增 FusionKit 项目避坑守卫 skill，沉淀 Electron 视觉 QA、前端服务清理和滚动弹窗使用规范
- 归档旧版批量文件名翻译、HomeAgent、字幕翻译和重构相关设计文档到 `docs/archrive`

### 依赖

- 新增 `chardet`、`iconv-lite`、`unified`、`remark-parse`、`remark-frontmatter` 和 `@types/mdast`，用于长文本编码识别与 Markdown 解析

### 限制

- 长文本翻译仍按 Beta 范围发布，建议在更多真实模型、超长文件和跨平台场景手工验收后再移出 Beta
- 连贯串行模式会显著增加输入 token，费用通常高于快速并发模式

## [0.2.9] - 2026-06-22

### 新增

- 重新设计应用启动加载页，新增 Reveal 过渡动画效果
- 文件名翻译新增双语输出模式，支持在翻译后的文件名中同时保留原语言和目标语言，可自定义分隔符和语言顺序
- 新增繁体中文（zh-Hant）国际化支持

### 性能优化

- 文件名批量翻译性能全面重构优化：
  - 新增 Planner 进度与耗时观测，规划过程可视化阶段进度条与取消入口
  - 翻译去重、快路径跳过与内存缓存，大幅减少模型请求数量
  - 受控并发翻译与自适应批次拆分，小批量（5+）不再串行等待单次模型响应
  - 批量目标路径存在性 IPC，减少 renderer/main 进程间往返
  - 扫描器 IO 优化，利用 Dirent 快路径减少不必要的 lstat 调用
  - 新增性能回归测试，不依赖真实模型网络
- Code Review 问题修复：
  - 修复 Dirent 快路径丢失 symlink 检测的安全问题
  - 修复 `checkRenameTargetsExist` 丢弃权限错误导致潜在文件覆盖的问题
  - 新增不完整 plan 的 apply 守卫，防止大批量任务静默丢失文件
  - 批量 path-check 两层 fallback 全部失败时增加诊断警告
  - 新增快路径规则独立单元测试（76 cases）
  - 性能测试阈值改为确定性结构断言，避免 CI flaky

### 优化

- 更新 CodeBlock 组件
- 优化删除操作提醒逻辑
- 优化卡片边距样式
- 升级 AI SDK 依赖（ai 6.0.206、@ai-sdk/openai-compatible 2.0.50）

### 修复

- 修复文件名翻译预览表格 Tooltip 交互问题

### 其他

- 移除 GitHub Actions CI 和构建工作流
- 更新 README

## [0.2.8] - 2026-06-04

### 新增

- 所有工具详情页新增 Tour 引导功能（字幕翻译、字幕转换、字幕语言提取、文件名翻译）
- 首次进入页面自动弹出分步引导，覆盖完整使用流程
- 页头右上角新增引导触发按钮，可随时手动重新查看引导
- 引导延迟至页面入场动画结束后触发，避免聚焦位置偏移
- 字幕翻译历史任务恢复功能：支持扫描输出目录或选择目录发现 `*.fusionkit.resume.json`，从历史恢复清单重建翻译任务并续跑
- 新增恢复历史任务弹窗（RecoveryDialog），支持扫描当前输出目录、选择目录、导入单个恢复清单三种入口
- 新增 `manifest_fragments` 恢复模式：源文件缺失或变化时，使用恢复清单中的原始分片继续翻译
- 新增 `validateManifestSelfContained` checkpoint 自校验，不依赖源文件验证 manifest 完整性
- 新增队列 `addRecoveredTask` / `addRecoveredTasks` API，支持 checkpointPath 联合去重
- 文件名批量翻译工具，支持通过 Agent 对话批量翻译文件名
- HomeAgent 支持拖拽文件/文件夹到输入框，自动识别路径并追加
- HomeAgent 输入框草稿缓存，跨页面导航保持输入内容

### 优化

- 字幕翻译任务列表进度显示增加已完成分片数/总分片数（n/N）
- 补充输入框上下元素的 layout 动画过渡效果

### 修复

- 修复 HomeAgent 工具调用结束时页面卡死的性能问题
- 修复名称翻译预览卡片在消息列表中重复出现两次的问题

### Agent

- HomeAgent 新增 `scan_subtitle_recovery_tasks` 和 `queue_recovered_subtitle_translate` 工具，支持通过自然语言恢复历史字幕翻译任务
- HomeAgent System Prompt 新增恢复任务操作区分规则和 Subtitle Recovery Workflow，禁止将 `*.fusionkit.resume.json` 误用为普通字幕文件
- 新增 recovery-batch 缓存模块，支持 `recoveryScanId` 分批入队、`recoverability` 过滤和有界 preview 返回
- 新增 `subtitle-recovery-intent` 意图分类辅助
- 会话日志新增 `subtitle_recovery_scan` / `subtitle_recovery_queue` 类型

### 文档

- 新增字幕翻译历史任务扫描与恢复开发设计文档
- 新增 HomeAgent 控制字幕翻译历史任务恢复设计文档
- 新增批量文件名翻译工具开发设计与实施文档
- 新增拖拽文件路径到 Agent 输入框实现文档

## [0.2.7] - 2026-05-19

### 优化

- 工具列表页和工具详情页 UI 改造，新增颜色变量，优化布局与交互体验
- 关于页和设置页 UI 改造
- 优化设置页导航切换动效
- 优化工具详情页配置选项侧边栏 sticky 和面包屑布局
- 优化 HomeAgent 的滚动相关逻辑和用户体验
- 完善 i18n 国际化配置

### 修复

- 修复取消翻译任务不能真正终止执行的 bug

### 文档

- 更新 README，使用新的 Banner 图片并完善项目介绍

## [0.2.6] - 2026-05-07

### 新增

- 字幕翻译新增费用预估 Tooltip，提升费用预估直观性
- 新增日语本地化执行确认消息
- Markdown 渲染升级改造

### 优化

- 修复测试按钮 Tooltip 文案颜色

### 修复

- 修复 LRC 字幕翻译分片因 API 响应 token 上限过低导致大段内容丢失的严重问题
- 修复自定义字幕切片长度的显示和 Agent 支持问题

### 文档

- 更新 README，补充 Faster-Whisper-GUI 集成使用说明

## [0.2.5] - 2026-05-05

### 新增

- 字幕翻译任务失败恢复与续跑逻辑

### 优化

- 拆分字幕翻译队列服务，明确 renderer 侧队列 service 和 IPC 执行 service 的拆分边界
- 修复批量添加大字幕文件时的 UI 卡顿问题
- 优化 Token 消耗预估卡片的边距等样式

### 修复

- 修复字幕预估分片漂移问题
- 修复字幕 Token 预估计算
- 修复 LRC 翻译结果为空时缺少重试的问题

## [0.2.4] - 2026-04-29

### 新增

- 新增 DeepSeek V4 系列模型选项，并在模型设置页支持选择
- 新增主题化应用加载页，支持自定义动画与平滑淡出效果
- 生产环境禁用刷新和开发者工具快捷键，降低误操作风险

### 优化

- 重构字幕语言提取逻辑，改为可配置的多语言下拉选择
- 统一配置与任务状态持久化层，接入 Zustand persist 并支持旧本地存储自动迁移
- 优化检查更新弹窗，精简关闭入口和交互流程
- 优化 HomeAgent 边框颜色与页面切换期间固定输入框的稳定性
- 清理遗留 demo 代码和旧注释，规范翻译常量文件命名
- 补充转换、提取和翻译模块注释及项目文档

### 修复

- 修复字幕工具重复选择文件时缺少拦截、提示和输入重置的问题
- 修复页面切换过渡期间 HomeAgent 固定输入框不稳定的问题

### 文档

- 新增 TODO 工作追踪文档和配置持久化重构实施计划

## [0.2.3] - 2026-04-09

### 新增

- 页面间切换过渡效果
- 增强 HomeAgent 对话输入框的换行输入和交互体验

## [0.2.2] - 2026-04-07

### 新增

- 字幕翻译支持多种源语言和目标语言设置
- 字幕翻译支持单语或双语输出模式
- 支持切片并发翻译，提升翻译效率
- 进行中任务的删除二次确认
- 打开所在文件夹按钮
- 编辑任务配置功能
- HomeAgent 支持日志记录与查看
- HomeAgent 支持会话导出导入
- HomeAgent 支持语义控制并发切片和同名覆盖逻辑

### 文档

- 补充 HomeAgent 文档

## [0.2.1] - 2026-03-16

### 新增

- Home Agent 会话支持中断
- 模型设置模块重构，支持多模型配置及模块分配
- Home Agent 新增统计相关逻辑和视图
- 增强工具调用管理，支持工具输入开始事件和参数更新

### 优化

- 优化 token 计算逻辑，提升准确度和效率
- 优化用户体验，Home Agent 调用 tool 时显示 Loading 态卡片
- 优化 macOS 窗口红绿灯位置

### 修复

- 修复 ModelMessage schema 报错问题

## [0.2.0] - 2026-03-12

### 新增

- 集成 AI SDK，支持流式对话和工具调用
- 新增 Home Agent 功能，支持自然语言交互添加任务
- 实现 Agent 三种执行模式：仅添加任务、询问后执行、自动执行
- 新增流式文本淡入效果，优化对话体验
- 添加窗口控制功能（最小化、最大化、关闭），适配 Windows 平台标题栏

### 优化

- 优化 Home Agent 页面样式、布局及交互体验
- 优化底部导航栏视觉效果
- 优化文件解析性能

### 修复

- 修复 Agent 添加翻译任务时缺少预估 Token 及 URL 错误的问题
- 修复滚动容器导致的宽度异常问题

## [0.1.12] - 2026-02-26

- 移除react-spring并替换为Motion
- 添加OpenAI模型Key获取功能并完善相关体验
- 添加更新日志功能，优化更新检查UI体验
- 添加可选的系统通知提醒功能，支持任务完成和失败的提示
- 优化 AppTitleBar 的视觉效果

## [0.1.11] - 2026-02-25

### 新增

- 新增代理设置功能，支持配置网络代理

### 优化

- 重构主页 UI
- 重构检查更新弹窗 UI
- 更新关于页面，添加个人网站和博客链接

### 变更

- 更换项目 Logo 和应用图标

## [0.1.10] - 2026-01-26

### 优化

- 完善检查更新的下载逻辑

## [0.1.9] - 2026-01-26

### 优化

- 完善更新弹窗交互

## [0.1.8] - 2026-01-26

### 优化

- 下载失败时显示打开发布页按钮，方便用户手动下载

## [0.1.7] - 2026-01-26

### 优化

- 完善检查更新相关内容

## [0.1.6] - 2026-01-26

### 新增

- 新增应用内检查更新功能

### 优化

- 完善模型设置

## [0.1.5] - 2026-01-21

### 新增

- 新增输出路径和重名处理选项

### 优化

- 重构语言管理逻辑，优化工具页面的国际化支持
- 添加对 Electron 24+ 的 webUtils 支持，优化文件路径访问
- 优化字幕转换和提取工具的用户体验

## [0.1.4] - 2025-12-27

### 新增

- 格式转换工具新增去除媒体类型后缀可选功能

### 变更

- 迁移至 `@reactuses/core`

## [0.1.3] - 2025-10-31

### 修复

- 修复历史 Modal 组件的渲染方式，确保正确传递 props

### 优化

- 更新依赖版本，优化 CSS 变量定义

## [0.1.2] - 2025-10-30

### 优化

- 更新多个 UI 组件，优化样式和交互

## [0.1.1] - 2025-10-21

### 优化

- 大幅优化 UI 组件样式
- 添加 ScrollArea 组件以改善滚动体验

## [0.1.0] - 2025-10-20

### 新增

- 使用 shadcn/ui 重构视图层
- 添加 VTT 字幕格式支持

### 优化

- 优化主题和语言设置

### 修复

- 修复字幕翻译列表在某些情况下的 bug

## [0.0.3] - 2025-08-08

### 新增

- 添加字幕语言提取工具
- 添加字幕格式转换功能
- 导出文件同名不覆盖逻辑
- 添加定时任务功能，支持防止系统睡眠
- 添加 macOS 应用图标支持

### 优化

- 完善多语言支持，优化输出路径选择对话框

## [0.0.2] - 2025-07-18

### 新增

- 字幕 AI 翻译功能
- 模型设置与 API Key 配置
- 预估 Token 消耗量展示和模型价格设置
- 适配深度思考类模型
- 单条任务的终止与删除
- 任务错误信息的记录与展示
- 输出路径设置与持久化
- 自定义 Electron 应用标题栏
- FadeMaskLayer 过渡动效组件
- 底部导航栏玻璃拟态效果
- i18n 国际化支持
- 深色模式支持

### 修复

- 修复 SRT 翻译的各种问题
- 修复 FadeMaskLayer 在 .app 中滚动进度不为 0 时的显示问题

## [0.0.1] - 2025-07-01

### 新增

- 项目初始化
