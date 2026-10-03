# 总体设计与现状盘点

## 正式范围
以 src/pages/Tools/index.tsx 的 CLASSIC_TOOLS / FEATURED_TOOLS 分组为准，不能以 toolMeta.status=stable 推断。

| 工具 | 改造 | 限制 |
| --- | --- | --- |
| 经典字幕翻译/转换/提取/恢复 | 保留入口，精确启动本次任务，补状态 | 不启动整个队列 |
| 经典本地字幕转写 | 环境/任务查询、配置准备、工具页交接 | 文件仅由真实 File 授权，不伪造、不跨用工作台 token |
| 字幕工作台 | 文档分页查询、原生导入、翻译准备执行、转写准备执行、任务查询 | 固定 picker，内部读取模型，不把密钥/endpoint 交给模型 |
| 翻译资料 | 有界搜索、状态摘要、资料投影及导航 | 不自动采纳/删除，不全量发送私库 |
| 既有名称翻译 | 保留并加固确认 | 预览后下一轮明确肯定或用户 UI 确认 |
| 其他实验工具 | 不新增 | 排除文本与音频/实时工具 |

## 契约与取舍
- AgentSession.plan 可选，AgentPlan={id,goal,steps,updatedAt}，step={id,title,status,dependsOn,detail?}。status 为 pending/in_progress/completed/blocked；最多12步、无环依赖、最多一项进行中，依赖完成才可进行/完成。update_agent_plan 支持多轮修订；计划完成不等于后台任务完成。
- runtime 同步认领 turn/session，所有事件和finally带所有权检查，工具串行且传 AbortSignal。旧 executor 在 picker/授权/入队前检查取消。已经受理的任务不伪称被撤销，回执保留。
- PendingExecution 冻结本次实际新任务引用，auto/confirm 禁止 startAllTasks。转换/提取仍按独立执行通道串行调度，旧任务及同名重新创建任务不混入；get_classic_subtitle_tasks 提供有界状态回读。重命名保存创建时用户消息ID，否定/疑问/同轮确认不执行，UI和工具共用同步claim。
- 重命名自然语言确认只接受完整的简短肯定指令，例如“确认执行”“应用刚才的重命名计划”“Apply this rename plan”；含否定、条件、引用或解释性文字的消息不授予执行权，用户也可使用可信计划卡片确认。恢复任务的能力清理异步返回后再校验会话，旧日志不写入新会话，已入队事实仍作为回执返回。
- prepared-actions.ts 提供 usePreparedActionsStore {actions,confirmAction(id),dismissAction(id)}。action={id,sessionId,title,summary,toolKey,status,error?,result?}，status=ready/running/completed/failed/dismissed。回调/授权仅内存保留；会话变化失效，确认同步claim，未知提交不盲重试。auto_execute可启动；queue_only和ask_before_execute保持ready，用户手动确认准备动作。结果明确区分prepared/queued/running/completed。
- 新能力目录由 capability-catalog.ts 统一供模型和UI消费；modern-tools.ts 导出 modernAgentTools，root在tools.ts组合。参数schema严格限界，不新增特权IPC。工作台API负责revision/批次所有权，复用任务总览接收回执。
- 历史原子保存call/result，中断保存已知回执，未知调用标明interrupted；裁剪完整用户轮次、结果有界摘要，保留原始可导出记录。adapter对工具错误、截断、步数预算有一致可观察语义。
- 导入严格校验有效v1及兼容升级数据、8MiB体积/枚举/统计；生成新的sessionId、status归idle、执行模式降为queue_only，进行中的计划步骤归pending，不恢复执行权。仅执行模式自动持久化，显式会话导出导入保留。

## UI基准
遵循 fusionkit-ui-design。保留首页单列聊天/InputCapsule，增加消息流内紧凑计划、输入旁能力目录、准确待执行范围。复用 Button/Badge/Accordion/ScrollableDialog，中性语义色，12px面板内距，长文本自然换行。不把工具详情壳层强套首页，不固定大计划面板遮挡输入。

验收1280×860和786×660，浅深色、四语言、长目标/阻塞/待确认/失败及能力弹层与键盘交互；计划12步骤上限、停止/清空/导入隔离另由单元测试覆盖。视口调整为实际桌面窗口与更窄窗口，未放宽无遮挡标准。等待preload loading退出，实际查看截图，检查底部导航遮挡，清理本次服务。

## 写集协调
root：types/store/plan/旧executor/tools.ts/session导入/全部台账；audit_runtime：orchestrator/runtime/上下文与guarded-tools；audit_tools：catalog/modern-tools/prepared-actions；audit_ui：HomeAgent/四语言home.json/QA脚本。基线共享aab39c9a，源码开发必须在ready与授权登记之后。

## 风险与证据
不新增依赖。单元mock只证明边界和调度，Electron隔离profile证明渲染与固定bridge；不把未执行的真实供应商计费、长媒体转写、其他OS矩阵当成通过。
