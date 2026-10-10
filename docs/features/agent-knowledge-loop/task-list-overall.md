<!-- spec-driven-ai-coding:generated:v2; DO NOT EDIT -->
# agent-knowledge-loop 任务总览

由各模块 tasks.md 生成；它不是第二份任务状态来源。

规模：L；风险：medium；当前批次：I4。

| 任务 | 模块 | 标题 | 状态 | 批次 | 需求 | 依赖 | 负责人 | 实施记录 | 集成版本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-AGENT-01 | AGENT | 资料检索增强与目录工具 | 已完成 | I1 | R-AGENT-01 | - | Claude（当前会话） | records/i1/T-AGENT-01.md | 45a88e0 + 未提交工作树（I1） |
| T-AGENT-02 | AGENT | 准备资料变更工具与确认执行 | 已完成 | I1 | R-AGENT-02, R-AGENT-03 | T-KNOWLEDGE-02, T-AGENT-01 | Claude（当前会话） | records/i1/T-AGENT-02.md | 45a88e0 + 未提交工作树（I1） |
| T-AGENT-03 | AGENT | 资料变更卡片、行摘要与四语言文案 | 已完成 | I1 | R-AGENT-03 | T-AGENT-02, T-KNOWLEDGE-03 | Claude（当前会话） | records/i1/T-AGENT-03.md | 45a88e0 + 未提交工作树（I1） |
| T-AGENT-04 | AGENT | Agent 指引与背景对话端到端复现 | 已完成 | I1 | R-AGENT-04, R-AGENT-03 | T-AGENT-03 | Claude（当前会话） | records/i1/T-AGENT-04.md | 45a88e0 + 未提交工作树（I1） |
| T-AGENT-05 | AGENT | 修订应用事件与 Agent 跟进 | 已完成 | I2 | R-AGENT-05 | T-STUDIO-02 | Claude（当前会话） | records/i2/T-AGENT-05.md | 45a88e0 + 未提交工作树（I2） |
| T-AGENT-06 | AGENT | Agent 发起一致性检查 | 已完成 | I3 | R-AGENT-06 | T-STUDIO-04 | Claude（当前会话） | records/i3/T-AGENT-06.md | 45a88e0 + 未提交工作树（I3） |
| T-AGENT-07 | AGENT | Agent 联网工具与带来源的资料 | 已完成 | I4 | R-AGENT-07 | T-WEB-02 | Claude（当前会话） | records/i4/T-AGENT-07.md | 45a88e0 + 未提交工作树（I4） |
| T-KNOWLEDGE-01 | KNOWLEDGE | 原子批量保存 saveRecords | 已完成 | I1 | R-KNOWLEDGE-01 | - | Claude（当前会话） | records/i1/T-KNOWLEDGE-01.md | 45a88e0 + 未提交工作树（I1） |
| T-KNOWLEDGE-02 | KNOWLEDGE | 资料变更提案构造与预检 | 已完成 | I1 | R-KNOWLEDGE-02 | T-KNOWLEDGE-01 | Claude（当前会话） | records/i1/T-KNOWLEDGE-02.md | 45a88e0 + 未提交工作树（I1） |
| T-KNOWLEDGE-03 | KNOWLEDGE | 翻译资料页 Agent 上下文与定位 | 已完成 | I1 | R-KNOWLEDGE-03 | - | Claude（当前会话） | records/i1/T-KNOWLEDGE-03.md | 45a88e0 + 未提交工作树（I1） |
| T-KNOWLEDGE-04 | KNOWLEDGE | 批量记入对话框 | 已完成 | I2 | R-KNOWLEDGE-04 | - | Claude（当前会话） | records/i2/T-KNOWLEDGE-04.md | 45a88e0 + 未提交工作树（I2） |
| T-STUDIO-01 | STUDIO | 修订请求携带资料并返回可沉淀译法 | 已完成 | I2 | R-STUDIO-01, R-STUDIO-02 | - | Claude（当前会话） | records/i2/T-STUDIO-01.md | 45a88e0 + 未提交工作树（I2） |
| T-STUDIO-02 | STUDIO | 修订对话框资料行、预览提示与应用后提示条 | 已完成 | I2 | R-STUDIO-01, R-STUDIO-02, R-STUDIO-03 | T-STUDIO-01, T-KNOWLEDGE-04 | Claude（当前会话） | records/i2/T-STUDIO-02.md | 45a88e0 + 未提交工作树（I2） |
| T-STUDIO-03 | STUDIO | 一致性检查契约、服务与 IPC | 已完成 | I3 | R-STUDIO-04 | - | Claude（当前会话） | records/i3/T-STUDIO-03.md | 45a88e0 + 未提交工作树（I3） |
| T-STUDIO-04 | STUDIO | 一致性检查窗口、统一与撤销 | 已完成 | I3 | R-STUDIO-04, R-STUDIO-05 | T-STUDIO-03 | Claude（当前会话） | records/i3/T-STUDIO-04.md | 45a88e0 + 未提交工作树（I3） |
| T-WEB-01 | WEB | 主进程联网服务、来源适配器与安全守卫 | 已完成 | I4 | R-WEB-01, R-WEB-02 | - | Claude（当前会话） | records/i4/T-WEB-01.md | 45a88e0 + 未提交工作树（I4） |
| T-WEB-02 | WEB | 联网查询设置 | 已完成 | I4 | R-WEB-03, R-WEB-02 | T-WEB-01 | Claude（当前会话） | records/i4/T-WEB-02.md | 45a88e0 + 未提交工作树（I4） |

## 批次与批准

| 批次 | 名称 | 状态 | 范围批准 | 整体验收 |
| --- | --- | --- | --- | --- |
| I1 | Agent 检索与维护翻译资料 | verifying | delegated | pending |
| I2 | 修订后沉淀译法与修订参考资料 | verifying | delegated | pending |
| I3 | 术语一致性检查 | verifying | delegated | pending |
| I4 | 联网查证资料 | verifying | delegated | pending |
