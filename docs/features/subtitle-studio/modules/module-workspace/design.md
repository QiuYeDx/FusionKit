# I1 实施设计

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

文本 planner 为每批冻结短 ID 映射、源修订、上下文、模型配置摘要和预算；内部任务持久化不存密钥。翻译默认一文档单活动任务、顺序批次，不做随机响应顺序对应。标记不匹配和结构错误走受限协议重试，最终错误保留已提交批次。

暂不接高级语义记忆系统、术语自动提炼或跨文档翻译缓存。必要提示包含用户翻译要求、有界前后原文与上一批已提交译文；用户要求进入任务配置快照。不同语言/模型可创建新译文轨，导出显式选轨。

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

## 验证与风险

单元与故障注入验证结构和事务；模拟模型验证协议/重试负例；配置可用时用明确允许发送的合成短字幕做一次真实模型链路。测试运行不能代替真实 API 结果，缺配置不自动使用任何私人素材。

Electron UI 验证等待全局 preload loading 退出，检查内层滚动区域；正常任务、失败恢复、重启无新请求导出均记录。用独立 userData，不清空真实 Store。启动 Vite/Electron 后本轮结束前关闭所起进程并核对，无持续监控任务。

采用根 Vite 配置同时构建 renderer/main/preload，不发明独立 main/preload 配置。相关 vitest、tsc、根构建、preload bundle、i18n 完整性和 source usage 检查按任务执行；基线失败需定位，不用删测试消除。I1 不声明原生转写或双资源打包验证通过。
