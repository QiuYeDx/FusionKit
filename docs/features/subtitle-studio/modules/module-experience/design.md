# I5 第二轮体验完善设计

## 现状与约束

3855c2c已按用户要求先提交推送，远端OID一致，之后记录十项截图问题。为保留I3已完成任务及证据，新增I5体验完善作为当前批次；I4原有编辑计划保持后置，不重新编号。当前完整实现用户十项范围，不推进打包或ASR算法。

## 方案与取舍

保留现有任务与文档边界，按可信File桥、主进程幂等交接、持久偏好、静默读取和共用列表分别改进；具体方案与权衡见以下各节。

## 前端设计基准

沿用FusionKit紧凑ToolPanel/ToolField/ToolConfigDisclosure、ScrollableDialog、StudioFileName/StudioIconButton及现有批量列表。根据五图修正共同布局，保持浅深主题和当前工具色，工作区常用间距12px、字段16px；不放大表单或新增大型卡片。队列停止按钮在行hover背景上显示独立destructive色反馈，focus/disabled仍清晰。环境状态信息与重新检查同一flex行，长状态自然换行。

导出保存位置、内容、格式、回退与文件名以统一两列网格按语义组织；窄窗自适应。已选文档与多轨选择合并为表单末尾的一个默认折叠模块。单轨直接使用唯一ID，不显示选择或冗余说明；多轨按文档选择，明确错误ID不得静默换轨。无任何轨且未指定trackId时，source-fallback允许只输出原文并报告回退；对其他明确错轨仍阻断。

从StudioBatchItems既有实现提取StudioScrollFade，遮罩位于实际滚动viewport外的固定兄弟层，同时观察viewport和content尺寸，pointer-events:none、aria-hidden，按边缘和主题显示。统一StudioDocumentList/Row的名称、摘要、操作与详情slots，可选compact/detail；StudioSelectedDocuments保持兼容，StudioPlanDocuments控制末尾折叠。翻译选择/预览/结果、导出、总览和根操作结果复用；转写草稿/队列仍保留任务语义，只采用合适行/滚动原语。消除总览弹窗双重padding，不重复列表或嵌套同轴外层滚动。

译文工具条分为左侧选择器与清除组、右侧状态与操作组；右组占剩余空间并对齐边缘，空操作不生成占位，窄容器按组换行。验收1280×860浅色与786×540深色、长名称、focus/hover/disabled、等待/失败/完成、折叠与多轨/无轨；实际Electron截图审阅后修复复验。

## 媒体拖入与来源

root新增固定preload dropTranscriptionMedia(File[])，同步获取原生File路径，最多20项，固定内部通道不列入public invoke。main复用Studio冻结Windows Shell源解析器，未证明真实源的Temp代理失败，不猜路径。按钮与拖入共用authorize/probe逐文件逻辑，失败仍返回已发出的handle以便重试或撤销；每个async边界复核owner，路径不回renderer。前端控制器选入单飞，拖入与picker共用草稿处理和去重，不因UI卸载遗留新授权。

## 转写偏好与自动翻译

扩展既有Studio preferences存储，提取纯preferences-contract避免controller/store循环。按版本和strict schema读取，只保存合法transcriptionConfig和默认false的autoTranslation偏好、profileId/目标语言/无密钥参数；确保controller第一次读取前完成hydration，存储失败可继续。不得保存文件token、草稿、运行状态或新增API key副本。

enqueue新增可选autoTranslation:{config,apiKey}，未启用完全省略。renderer从既有模型store取得profile并校验，提交时快照；主进程二次验证，只将key持于私有内存闭包。成功文档通过createConfirmed将无密钥automaticTranslation意图与文档同一次发布，字段在DocumentSnapshot，包含稳定intentId/sourceTaskId/generation及配置/状态/关联翻译任务ID。没有启用时保持原创建路径。

新增main协调器交给TranslationService的main-only startAutomatic，repo事务原子检查意图、创建或复用唯一翻译task并链接身份；已admitted乃至completed重放仍返回原task，内存singleflight只是优化。发布前取消无翻译；发布后晚取消不能将成功文档改成转写失败，翻译有自己的状态与取消恢复。离开SPA继续，真实窗口关闭和应用shutdown按现有fence/join清理。

重启不恢复ASR队列、不保存key、不重发不确定供应商请求；未admitted意图转成可见needs_configuration翻译任务/checkpoint，已有任务沿用interrupted与现有resume恢复入口。若实现需要独立意图恢复API，必须具有可见UI并由root接线，不保留无入口的隐藏pending。保证的是一个本地逻辑任务，不能宣称网络请求exactly-once。删除文档或取消意图不能被迟到回调复活。

移除关联翻译任务或清除其译文轨时，同一个仓库事务将意图标为cancelled并保留原任务身份作为撤销标记；admitted仍必须指向真实任务，不放宽持久化校验。应用关闭先同步阻止新交接并等待已开始的交接，再停止翻译执行，原生转写清理按既有生命周期并行完成。

## 进度静默刷新

根页面将后台事件与前台互斥动作分开。轻量refresh coordinator合并事件、单飞读取，读取中更晚事件保证追读；后台不设置全页activity、不清error/export/copied等反馈，保留已呈现数据。只在当前文档revision变化或用户明确切换时读取正文，旧query/revision/删除/lifecycle屏障保留。

真实前台import/select/page/delete/export等仍有局部正确busy并优先执行；遇到后台读取先加入等其settle，不能因为operation.current静默丢点击。后台不重置滚动、焦点、译轨、视图或已开弹窗，其他文档进度不重复读取当前同revision内容。恢复与取消继续由真实任务状态和自身pending保护。

文件拖入是调度边界的例外：固定preload File桥在原生drop事件内同步捕获路径，并立即吸收Promise拒绝；只把处理结果排入读队列，不能先等后台读取结束再接触File，也不在重试闭包保存File。

## 代码落点

四任务唯一状态在tasks，公共ipc-contract、preload、main index/runtime、组合来源审计及docs由root独占。admission_design负责转写UI/controller、偏好、自动翻译snapshot/事务/service/sink和其测试；ipc_design负责根页面静默刷新、studio.css/译文状态条及其测试；windows_baseline负责导出/翻译/总览弹窗及共用列表、无轨原文回退planner与四locale。root定义媒体桥后通知转写owner接入；新列表交由相关owner采用，不跨写集直接覆盖。agent新增文案通过windows_baseline统一四语。

## 验证与风险

先跑每组有意义的单元/真实文件系统与并发反例，再构建实际Electron验收十项UI；受控翻译响应/ASR runtime用于确定性状态，不冒称真实质量。新增自动交接测试覆盖原子发布、双回调、重放、前后取消、关闭join、重启和缺配置、密钥不落盘；静默刷新以MutationObserver记录busy和disabled变化而非只截静态图。两套生产TS、验收测试TS、i18n、真实边界/当前来源审计、spec/diff均需通过。Node20直调，Vitest≤2 workers，UI1；服务用隔离profile并检查退出。保留当前冻结ASR和已接受来源/格式保护，不改lockfile。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-EXPERIENCE-01 | 转写按钮状态与环境对齐 |
| R-EXPERIENCE-05 | 转写按钮状态与环境对齐 |
| R-EXPERIENCE-02 | 原生媒体桥、源解析与共同草稿流程 |
| R-EXPERIENCE-03 | 偏好版本校验、意图原子发布及幂等翻译衔接 |
| R-EXPERIENCE-04 | 偏好版本校验、意图原子发布及幂等翻译衔接 |
| R-EXPERIENCE-06 | 默认值、无轨回退、单一末尾折叠清单与紧凑网格 |
| R-EXPERIENCE-07 | 默认值、无轨回退、单一末尾折叠清单与紧凑网格 |
| R-EXPERIENCE-08 | 工具条分组和后台静默单飞读取 |
| R-EXPERIENCE-09 | 工具条分组和后台静默单飞读取 |
| R-EXPERIENCE-10 | 共用文档行、渐变容器、确认/结果/总览一致 |
