# I1 实施设计

## 2026-09-11 文档库与批量处理设计基准

本节对应 R-WORKSPACE-09，来源为用户本轮明确要求，属于进入 I2 前的 I1 改进。保留其他已验收契约；不迁移坏文档、不实施转写。根任务为集成负责人，实际共享写集在 T08 登记。

- 工作流：原生多选导入 → 全库查询/分页 → 复选框跨页选择 → 一次配置批量翻译或导出 → 逐项结果。点击名称只改变右侧预览；选择范围单独可见，搜索/筛选变化清空，排序/分页保留。一次最多 100 份，库默认每页 20 份，有跳页与选择全部匹配结果（超限明确告知）。
- 全选跟进（2026-09-11 用户反馈）：顶部主复选框直接选择所有页的匹配文档，未筛选时即整个库；部分选中时补齐、全选时取消当前范围。旁边小菜单提供幂等“选择本页”、全选与全局清空，显示真实数量。顶部与逐项复选框共享选择列起点（后续视觉收敛为20px，见下方行表面设计），文件名也共用文字起点；全选态由与主进程相同的筛选谓词计算，后台任务移出筛选不误判或误清隐藏选择。100份批次上限保持，菜单说明且超限在库内可关闭提示，不截断为前100份。
- 布局：保留 ToolDetailLayout 的 320px 左库和右预览。将独立编码设置合并入库设置菜单以保留列表高度。左库上部紧凑搜索/排序筛选，中部列表独立滚动；底部45px固定一行，未选择时正常分页，选择后同一行呈现计数、翻译/下载/更多与compact分页（仍可数字跳页）。更多菜单承载继续/取消/删除/清空，取消原有顶部多选卡片；选择前后列表位置、高度和滚动保持。786px 窗口通过文档库按钮打开同一组件的弹窗，批量流程完整可达。
- 组件：ToolPanel 12px 标题内边距；Input h-8；筛选复用 Popover/Select；Checkbox 选择集合；列表 StudioFileName 与既有 4px 相邻间隔；StudioPagination 复用数字跳页。预览主操作统一 ghost/icon-sm + Tooltip/aria-label，下载复用 DropdownMenu，现有导出检查仍为 ScrollableDialog。使用语义色与现有圆角，不改共享全局 token。
- 行表面与对齐（用户三图跟进）：搜索框/列表行共用12px外边距；行内8px内边距使复选框起点20px、文件名和主选择标签起点44px。hover、current、multiselected统一由li绘制一个整行背景，内部预览button透明；current仍由右侧勾号说明，键盘焦点框覆盖整行，离散行间4px。底栏局部使用28px图标按钮、8px上下留白，根部批量控制器常驻不变；短计数和完整状态Tooltip兼顾不同语言。
- 批量配置中的范围预览：翻译与导出复用 `StudioSelectedDocuments`，默认折叠、原生summary键盘语义。单一轻边框表面内为集合图标、短标题、数量Badge及展开箭头；展开后用序号、可查看完整名称的单行文件名、格式标识构成紧凑行。列表有独立高度上限及内部滚动，100份不会线性撑高弹窗；不加入选择/搜索等管理功能，计划/结果和译轨列表仍按各自业务呈现。
- 异常恢复：列表返回失败项受控 id/token、应用管理目录和原因；提示短文案，查看入口和关闭并列。偏好保存失败集合指纹，关闭后管理入口仍可见，新集合重新提示。定位由主进程从令牌解析目录；清除前在弹窗确认仅删除工作台副本，重新证明仍不可恢复且未变更。正常文档删除继续已有墓碑/任务取消语义，不操作原始外部文件。
- 批量服务：新增严格、有界、owner 绑定的批量契约，保持旧单文件方法。计划缓存仅存有界引用、配置和摘要，不积累各文档全量输出；批量翻译执行逐项重验 revision 后持久创建任务，沿用请求级 FIFO/并发上限 2。批量导出一次授权目录，逐项重验 revision/选项/损失并 indexed 发布，后台更新使该项需重查，单份冻结修订语义不变。错误逐项返回，不把部分成功写成全部成功。
- 状态：列表显式显示原文/部分译文/已有译文及活动/失败任务；正在提交操作避免重复。文档变更事件使查询刷新、选择元数据更新；删除事件移除选择与预览。批量取消/继续读取最新文档并使用原任务模型配置，无凭据/配置变化逐项待修复。
- 验收样本：大于一页的中英长短文件名、混合 SRT/LRC、无匹配搜索、部分损坏/不可翻译、已有任务/不同译轨、同名输出、陈旧计划。真实开发版 Electron 和隔离 profile，1280×860 浅色及 786×540 深色；打开下载/筛选菜单和异常管理，键盘焦点/遮挡/滚动/靠角边距实际截图审阅后修复复验。仅对话框返回与模型 loopback 使用受控测试，不能称为手工原生对话框或真实供应商验收。

## 现状与约束

整体契约见 [architecture.md](../../architecture.md)，业务验收只在 [requirements.md](requirements.md)。本批新增工具，不迁移旧任务。

已核对的复用与差异：

| 现有代码 | 当前能力/差异 | 新版处理 |
| --- | --- | --- |
| `src/utils/subtitleCueProtocol.ts` | 分片作用域 ID、原格式 prefix 与模型 JSON 校验 | 参考策略，复制必要代码后改为文档稳定身份；不 import |
| `src/utils/subtitleTranslationPrompt.ts` | 本次待译文已不带时间；参考上下文仍是格式化字符串 | 全部从新版文本投影生成，避免误宣称本次才首次实现纯文本翻译 |
| `electron/main/translation/class/base-translator.ts`、`checkpoint.ts` | 字符串分片、格式化译文与输出模式绑定，完成清理恢复文件 | 新版文档/轨道持久化，导出不进入翻译身份，不迁移旧 checkpoint |
| `src/type/localSubtitle.ts` | Transcript 已有 segment、词时间、来源和模型 | I2 独立副本通过 adapter 生成文档，I1 不依赖该类型 |
| `electron/main/ai/model-runtime-client.ts` | 应用通用模型调用入口 | 审计传递依赖和 retry 语义后复用 |

## 方案与取舍

T-WORKSPACE-01 先提供一个最小真实入口：用户选择 SRT/LRC → 主进程授权读取 → 新版解析 → 保存文档 → 只读预览 → 原文导出。UI 可简洁，但不以固定 fixture 冒充生产路径。此时尚未具备的翻译/ASS/转写/编辑不显示可操作入口。T-WORKSPACE-02 随后完成持久化故障与 IPC 边界，之后接模型；不先把所有 common 层做完再第一次使用。

## 代码落点

2026-09-08 T-WORKSPACE-01 实际落点：`src/subtitle-studio/domain.ts`（类型与校验）、`formats/import.ts`（两个格式解析）、`ipc-contract.ts`；主进程为 `input-service.ts`、`document-repository.ts`、`export-service.ts`、`index.ts`。本阶段仓库只创建不可变 generation 和 current 指针，不将其描述为 T-WORKSPACE-02 的完整故障恢复实现。输入只使用主进程原生 picker，不接受 renderer 文件路径；公开 bridge 只有已实现的四个固定方法。

资源边界补充：最多 200000 个原节点（空行也计数），在对象分配前检查，避免只检查字节仍产生过多对象。原节点与 cue 各自分页，确保 LRC 元数据与无时间正文可查看。新版偏好仅保存经过校验的编码；运行文档不进入前端 Store。

复用审计：UI 仅经 ToolPageHeader/ToolBadge/toolMeta、Button、lib/utils；这些传递依赖通过新版 checker。toolMeta/router 为共存组合贡献，未引入旧实现。第三方 iconv-lite 用于严格往返解码与源格式导出，Zod 用于边界校验，TypeScript AST 只在开发期边界检查使用；未新增依赖或修改 lockfile。

拟议纯代码：`src/subtitle-studio/domain.ts`、`validation.ts`、`formats/srt.ts`、`formats/lrc.ts`、`formats/preservation.ts`、`translation-protocol.ts`、`export-plan.ts`、`ipc-contract.ts`。Node FS、密钥、进程不能进入此目录。

拟议主进程：`electron/main/subtitle-studio/{index,ipc,document-repository,document-service,input-service,translation-service,export-service}.ts` 及 planning/、persistence/；后续转写目录单独接入。实际拆文件由实现决定，职责与禁止依赖不变。

文档 directory id 由 main 生成，路径不接受 renderer 拼接。磁盘 generation 包含文档、该文档任务检查点和 schema，内容上限在序列化前验证。索引可重建。文档分页快照和更新事件带 documentRevision；订阅先于 snapshot，缓冲事件按版本归并，删除墓碑不能被旧 snapshot/晚到事件覆盖。跨会话事件不是持久存储。

2026-09-08 T-WORKSPACE-02 实际实现：同一仓库根共享串行队列；严格 document/tasks 快照写入不可变 generation，文件 sync 后发布带 SHA-256 的 current 指针。发布前保存最后一个有效指针到 previous；读取只尝试这两个已发布指针，不扫描孤立 generation。兼容 T01 无 digest 指针，后续提交补齐摘要。列表直接从自有 UUID 目录重建，不依赖 index.json；两个指针都损坏时报错，不冒充空文档库。

删除先发布独立 `.deleted/<documentId>.json` 墓碑，再取消内存活动并清理自有文档目录。墓碑永久保留，同 ID 的晚到提交/重建被拒绝；清理失败通过墓碑与残留目录保留待办，列表刷新/重启读取时自动重试。源文件、用户导出和 v1 数据不属于清理目录。源导出发布与删除共用串行队列，并在对话框返回后重新核对存在性与修订。owner 在发布指针前再次检查，避免异步 I/O 期间的导航撤权遗漏。

桥增加 deleteDocument、removeTask 和固定 subscribe；事件只传文档 ID、修订、序列和删除标记，preload 不传 Electron event 或私有 capability。主进程核对已挂接 WebContents、主 frame、精确应用 URL、私有 capability、严格 DTO、文档 grant 和修订。UI 订阅先于列表读取，持续保留跨页修订观察与删除墓碑；过旧列表重新读取，过旧详情不进入视图。删除入口复用 StudioIconButton 和 ScrollableDialog，初始焦点在取消，取消后返回触发按钮。

源修订/hash、目标轨修订与 task generation 在同一提交事务核对；新文档建立稳定 cue ID，不复用分片序号。删除任务保留文档，删除文档才执行停机和墓碑流程。

## 导入能力矩阵与资源边界

I1 实现：

| 内容 | 策略 |
| --- | --- |
| 普通 SRT | 多行、BOM/换行、不连续编号、重叠时间；编号/时间原表示保留 |
| 普通 LRC | 元数据、空行、多标签、同时间条目、offset；保留分组和原标签精度 |
| SRT 简单成对 b/i/u 标签 | 解析为安全 span，翻译使用有界可验证保护标记，正文可跨视觉行翻译；保真投影保留嵌套结构 |
| 未闭合/复杂未知内联标签、增强型 LRC、ASS | 诊断并禁止相应翻译；若结构足够可保存仅供源文查看/原样导出，否则拒绝导入。绝不 strip 后假装支持 |
| 编码 | 默认严格 UTF-8（可带 BOM），失败可由用户选择 GB18030/Shift_JIS/UTF-16LE 等实际支持编码；编码表与解码器来自新版输入层或已审计公共依赖 |

默认导入上限拟定为单文件 16 MiB、100000 个 cue、单 cue UTF-8 文本 64 KiB；这是 I1 的保守工程限额，不是实测性能指标。解析器在创建大量对象之前以及展开多标签后都执行限制。文档扩展不得无限膨胀；保存快照设 128 MiB 上限，超限在提交前失败并保留上一有效版本。后续增加译文轨时按限额明确提示，可通过新配置版本调整，不静默丢掉旧轨。模型响应另按实际请求输出预算设限。

无正文文件显示可读诊断，不派发空 AI 请求；空文档可查看和源导出。输入权限由新版 picker/drop capability 建立，复用现有原生桥的通用部分前确认不跨旧字幕命名空间。

## AI 和导出

双语导入跟进（T07）：`bilingual.ts` 本地分析候选与原文顺序，主进程 `previewBilingual` 分页返回原译文候选，`applyBilingual` 根据相同选项重算并在 revision 事务内提交，拒绝已有任务/译轨或已整理文档。界面沿用 ScrollableDialog、Select、Checkbox 与紧凑工具按钮；单行拆分默认关闭，逐条可跳过或选空格位置，不引入模型检测。只有至少三组且占候选 80% 的稳定语言顺序/结构证据才在新导入时自动打开可取消预览，已有文档提供手动入口。同时间配对仅用于不同节点的单行正文；本身双行的 SRT 分别拆分，同节点重复 LRC 标签保持原样。同行混排、同文/字种不明和偏离主要语言顺序的候选进入复核筛选。最多 1000 项人工覆盖，超限保留有效预览并允许撤回已有选择。

导入轨显示来源，不误标 AI。`removeTranslationTrack` 原子移除指定轨和关联终态任务：任意轨有 queued/running 任务，或选中轨有 interrupted/needs_configuration 任务时拒绝，防止修订冲突和恢复写回。公开 removeTask 同样禁止在同文档有 queued/running 时清除历史任务。当前 exportSource IPC 继续输出原文件，UI 改称“下载原文件”；T05 负责真实 source/target/bilingual 序列化。整理确认后暂不重解释；需更改方向时重新导入原文件，I4 再提供编辑/历史。

混合布局修复：结构配对与行内拆分不是互斥分支。启用空格拆分后，检查 same_time/lines 两侧是否有空白分隔、与对侧完整正文逐字相同的尾段；在双方字种不同且可识别时，或纯汉字双方有文档级稳定中日双语证据时，只收缩带重复内容一侧的源范围，对侧保持不变并标记需确认。不对部分相同、无分隔、普通同语言后缀或无语言证据的内容做猜测删除。预览和提交共用同一范围解释；原节点/原文件不变，sourceSide 切换仍只交换解释后的双方。旧版已整理文档需重新导入原文件使用修复，不静默改写已有译轨。

2026-09-09 T03 实际设计：`translation-protocol.ts` 将正文投影为短 ID 与局部 `<mN>` 样式标记，SHA-256 与源修订映射保留在 main。`translation-planner.ts` 使用通用两个 adapter 的同一 body builder 做完整 JSON 预算；tokenizer 为本地估算，64 token 协议余量，输出预留与前文译文预留单独计入。前后原文最多各两条、各 256 tokens；前文 AI 译文最多两条、512 tokens，进一步按完整请求序列化检查，超限整条移除可选上下文，不截正文。

`translation-service.ts` 保存 owner 绑定、15 分钟有效的内存计划；开始翻译须提供同 owner 计划及匹配文档 revision。主进程冻结配置，API key 仅进入当前执行闭包；文档快照新增可选 translation 进度以兼容 T02 快照。通用客户端内部重试固定为 0，新服务每批最多两次尝试，整批校验后与检查点一起提交。实际 usage 累加，缺失或非法值记 null；修订冲突也保留已收到的用量。重启恢复、取消控制与跨文档调度完整契约仍由 T04 负责。

DeepSeek Chat 的缺省 thinking 在主进程规划入口显式设为 false，再统一用于预算、计划快照和执行；显式布尔配置保留，其他模型/API 格式不变。避免供应商默认深度思考消耗正文输出预算，通用 adapter 的默认行为不改。供应商 `length_truncated` 或 Chat `finish_reason: length` 归类为 `translation_output_limit`，不提交半批、不按相同预算重试，已收到的用量照常累计；已明确收到截断响应不新增未知执行标记。UI 显示调整每批字幕数量或输出上限的固定文案，不透传响应内容或私有错误详情。

UI 以现有工作台/ToolPanel 和 `qiuye-ui-quality`、`fusionkit-ui-design` 为依据：header 仅新增 outline/sm 翻译按钮，使用 ScrollableDialog 配置模型、语言、翻译要求和折叠预算；计划预估后才显示开始动作。模型取应用公共 useModelStore，不新增密钥偏好。选择译文轨及状态栏仅在产生轨道后出现；桌面原译文并排，窄窗口在同一行单元内上下显示，长文按实际内容增长。原始内容和分页继续使用原布局；后台提交刷新保留当前滚动位置。状态按所选轨道关联，模型结果标明未经人工复核。验证覆盖多行、长文本、错误后重新规划、未知用量、深浅主题、1280/786 窗口和原有纵向空间回归。

公共依赖审计：精确允许两个通用 adapter、model-runtime-client/errors、provider-error-classification、proxy、模型类型/常量/Store 与音频类型；tokenizer/axios 使用现有依赖。通用 useModelStore 导入时有应用级音频配置兼容初始化，传递链不含 v1 字幕实现；未改该初始化或访问旧字幕目录。两个 adapter 仅导出原 body builder 并增加可选响应字节上限，默认请求行为不变，已有模型客户端回归已验证。实际写集包含这三处通用文件、preload allowlist/API 和新版边界清单。

文本 planner 为每批冻结短 ID 映射、源修订、上下文、模型配置摘要和预算；内部任务持久化不存密钥。翻译默认一文档单活动任务、顺序批次，不做随机响应顺序对应。标记不匹配和结构错误走受限协议重试，最终错误保留已提交批次。

暂不接高级语义记忆系统、术语自动提炼或跨文档翻译缓存。必要提示包含用户翻译要求、有界前后原文与上一批已提交译文；用户要求进入任务配置快照。不同语言/模型可创建新译文轨，导出显式选轨。

### T04 恢复、取消与并发设计（2026-09-10）

持久检查点增加可选 version=1 的冻结批次清单：整文 cue 身份/源修订/hash 摘要、期望轨修订，以及每批固定 id、cueIds、前后文与预算。恢复用现存原文投影重建相同短 ID 与保护标记，再验证摘要和批次映射，不对剩余正文重新切批。原 T03 快照缺此清单时仍可预览/下载已有结果，但不能猜测恢复；界面引导创建新翻译。

服务 initialize 幂等地将遗留 queued/running 转 interrupted、增加 generation，保存原进度，不自动联网。恢复只能继续 failed/interrupted/needs_configuration 的任务，保留 taskId/trackId、已提交批次和冻结参数，创建新 generation；对源摘要、期望轨修订和当前任务状态做事务验证。所有派发、结果、错误收尾及内存句柄清理绑定执行代次，取消先发布 cancelled 和 generation 栅栏，再 abort；不等待不合作的网络响应才返回，迟到响应无权写入。退出时拒绝新任务，启动修复覆盖强制退出而未完成 dispose 的场景。

每次请求派发前持久 inFlightBatchId，结果和 completedBatchIds 同事务发布；启动发现残留 in-flight 记入 uncertainBatchIds/累计 uncertainAttempts。后续成功可解决未提交批次，但不能抹掉历史未知计费次数。提交结果若出现已发布但调用失败的窗口，先读实际发布检查点，禁止重发已提交批次或重复累计用量。实际 usage 无法确定时保持 unknown。

应用内最多两个模型请求并发；等待队列不占仓库串行锁，等待/退避可取消，实际未结束的请求仍占用并发名额。每文档只允许一个 queued/running 任务；通用客户端 retry 固定 0，由新版服务负责有限退避，Retry-After 是等待下限。超过短等待上限时保留 notBefore，用户继续也不能绕过供应商时限。

resumeTask 输入只含 documentId/revision/taskId、当前对应模型身份及内存 apiKey；cancelTask 使用 documentId/revision/taskId，仍经过精确 owner/文档 grant/schema 保护。恢复只按冻结 profileId 匹配配置，统一 DeepSeek thinking 默认值后比较 endpoint/modelKey/apiFormat/outputTokenParameter/thinking，密钥轮换允许；缺失或路由变化保存 needs_configuration，禁止回退默认模型，API key 不持久化。

前端沿用 StudioTranslationStatus 的紧凑状态条、Button ghost/outline sm 与现有 ScrollableDialog/模型设置入口：进行中提供取消，已中断/失败提供继续翻译，配置不符提供明确修复入口，已取消保留结果且不提供原任务恢复。状态与操作按当前译轨任务绑定；显示已提交批次数、实际用量和未知尝试提示，窄窗自然换行。异步回调只刷新同一文档，不让旧操作关闭新文档弹窗。以真实 Electron 合成三批字幕、重启、慢响应/取消、配置删除/变化、长状态文案为样本；1280×860 和 786×540、深浅主题审查有效工作区、按钮可达和焦点。

### T05 导出计划与界面（2026-09-10）

保留下载原文件（original）的独立入口；新增导出字幕 source/target/bilingual。原文始终从当前 cue.source 序列化，不能复用 rawText 夹回旧译文。选中 imported 或 AI 轨均按 sourceRevision/hash 判断有效。选项固定格式、轨、双语顺序、编码/BOM/换行、不完整策略和缺失结束时间策略，完全不调用模型。

planExport 在 main 验证当前修订，生成有界冻结输出字节与诊断，缓存 owner 绑定的限时计划；返回计划 ID、条数、字节数、诊断数量和少量预览，不传文件路径或整份文档。exportDocument 接受计划 ID 与确认的损失类别，打开原生保存框；保存期间新译文提交不影响所选字节，删除墓碑和 owner 撤权仍拒绝发布。原生对话框不能占仓库串行锁；最终发布仅在短时存在性保护内进行。

缺失/过期译文默认阻止 target/bilingual；明确选择 skip 或 source-fallback 后保留不完整标记，无轨时仍拒绝。LRC→SRT 估算须显式启用，使用完整源时间集合中严格更晚起点，末组时长默认 2000ms 且可调整，不修改任何源时间/provenance。LRC 输出使用毫秒精度、实际起点和零 offset，避免重复应用原 offset；负时间或超出格式范围拒绝。SRT 保留 b/i/u 安全 span，LRC 样式、多行折行、未计时元数据及不能无歧义表达的正文分别诊断；编码必须严格往返，不能静默替换字符。

UI 参照现有工作台按钮、ToolField/Select、ScrollableDialog 与 12px 内间距。约 600px 弹窗首层两列模式/格式；仅相关时出现译轨与双语顺序。编码/BOM/换行置更多选项；阻断诊断紧接对应修复选项，计划摘要展示输出条数与格式影响。显式接受时长估算和不完整策略后重新计划，其余损失统一勾选确认且绑定当前计划；无损计划无需额外确认。底栏取消和保存字幕，原生取消保持当前计划可重试。后台译文变化保留已选快照并提示可重新检查，选项改变才使计划失效。以 1280×860/786×540、深浅主题、长文案、缺失/清轨/导出中并发提交为验证样本。

export planner 固定 revision，先检查缺失、过期、结束时间和格式损失，再执行本地 serializer。具体双语、LRC→SRT 推导和不完整导出策略见整体架构第 6 节。目标语言视觉折行可重排，时间轴不因字数被重新发明。

发布默认索引命名，采用新版自有临时文件、内容校验和最终发布；取消/失败清理只作用于当前操作拥有的文件。主动覆盖经原生保存选择，Windows 锁定/替换失败保留旧目标。I1 不借用 local-subtitle overwrite-native。

## IPC 与前端

拟议公开方法：importSubtitle、listDocuments、readDocumentPage、createTranslation、cancelTask、resumeTask、planExport、exportDocument、removeTask、deleteDocument、subscribe。每方法采用精确 DTO、输入上限和错误枚举，私有路径解析和能力转换不公开到通用 invoke。

错误至少区分 invalid_input、unsupported_feature、encoding_required、limit_exceeded、revision_conflict、needs_configuration、translation_protocol_invalid、interrupted、export_loss_requires_choice、output_write_failed；用户可操作说明经 i18n 映射，供应商原始消息脱敏。

前端仅持久化新版偏好，任务/文档由 main 仓库恢复。布局复用应用已存在的 ToolLayout/配置控件和 ScrollableDialog；若具体控件传递依赖 v1，则复制纯 UI 部分或选择通用组件。不要复制旧字幕页面 Store。

列表支持创建、选择、清理任务和明确的删除文档操作。详情读表显示源与目标，翻译设置、运行状态和导出设置分别组织。内容只读；首次页采用分页，不提前实现整套编辑器/虚拟时间线。窄窗口可纵向组织原译文，不能靠隐藏列丢信息。所有正文转义，普通标签按安全 span 显示。

新增工具涉及应用组合位置：`src/App.tsx`、`src/constants/router.ts`、`src/pages/Tools/index.tsx`、`src/pages/Tools/_shared/toolMeta.ts`、`electron/main/index.ts`、`electron/preload/index.ts`、`electron/electron-env.d.ts` 和新版 i18n 资源注册。逐处增加新贡献；不改旧路由/协议。共享文件增量必须有对照证据。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-WORKSPACE-01 | 独立根/命名空间、应用壳接线、依赖反例与移除演练 |
| R-WORKSPACE-02 | 安全格式解析、原节点映射、编码/资源边界 |
| R-WORKSPACE-03 | generation 仓库、重建索引、任务与文档分离 |
| R-WORKSPACE-04 | 文本投影、短 ID、实际预算和完整批次校验 |
| R-WORKSPACE-05 | 持久检查点、源/轨/任务修订、单重试拥有者 |
| R-WORKSPACE-06 | 导出计划、固定快照、格式能力和原子发布 |
| R-WORKSPACE-07 | 分页预览、精确 IPC、转义与 owner 检查 |
| R-WORKSPACE-08 | 双语候选分页确认、importedPair 保真映射、导入译轨与清轨事务、原文件/原文轨导出区分 |
| R-WORKSPACE-09 | 全库分页查询与跨页选择、异常身份令牌/显式清除、批量metadata计划/逐项结果、原生目录授权、统一图标菜单与窄窗文档库 |

## 验证与风险

2026-09-10 T07 补充：两个结构侧若为完全相同的混排正文，显式开启行内拆分后可按可识别且不同的字种分界取第一侧前段和第二侧后段；保留双方原节点范围与方向切换，标为需确认，并提供可选分界/保持原样。普通同语同文、纯汉字且无明确分界的内容不猜测删除。候选与提交仍由同一分析函数产生；真实样本逐页核对预览正文与最终结果，不能仅验证整理后的表格。

本轮 UI 参照工作台现有 StudioPagination、StudioIconButton（ghost/icon-sm）和 ScrollableDialog：给共享分页增加可传 pageSize，弹窗使用 20 条/页，主表继续默认 100 条。底栏左侧保留条目范围并增加“当前页输入 / 总页数”，Enter 跳转，越界/无效输入不发请求，失焦回到当前页；筛选/配置变化返回第一页，翻页后候选滚动区回顶部。复用现有 page_number/previous/next 文案及 28px 输入，底栏保持 12px 内边距和必要窄窗换行。验证桌面 1280×860、窄窗 786×540、深浅主题，真实大文件多位页数、页尾、过滤后页数更新，以及相同混排结构预览/方向/跳过/确认后的正文一致性。

单元与故障注入验证结构和事务；模拟模型验证协议/重试负例；配置可用时用明确允许发送的合成短字幕做一次真实模型链路。测试运行不能代替真实 API 结果，缺配置不自动使用任何私人素材。

Electron UI 验证等待全局 preload loading 退出，检查内层滚动区域；正常任务、失败恢复、重启无新请求导出均记录。用独立 userData，不清空真实 Store。启动 Vite/Electron 后本轮结束前关闭所起进程并核对，无持续监控任务。

采用根 Vite 配置同时构建 renderer/main/preload，不发明独立 main/preload 配置。相关 vitest、tsc、根构建、preload bundle、i18n 完整性和 source usage 检查按任务执行；基线失败需定位，不用删测试消除。I1 不声明原生转写或双资源打包验证通过。
