<!-- spec-driven-ai-coding:generated:v2; DO NOT EDIT -->
# knowledge-v2 任务总览

由各模块 tasks.md 生成；它不是第二份任务状态来源。

规模：L；风险：high；当前批次：I3。

| 任务 | 模块 | 标题 | 状态 | 批次 | 需求 | 依赖 | 负责人 | 实施记录 | 集成版本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-AGENT-01 | AGENT | 资料工具、提示词与自动翻译参数 | 已完成 | I2 | R-AGENT-01, R-AGENT-02, R-AGENT-03 | T-DATA-06 | Claude（当前会话） | records/i2/T-AGENT-01.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-AGENT-02 | AGENT | 资料变更卡片与结果展示 | 已完成 | I2 | R-AGENT-02 | T-AGENT-01 | Claude（当前会话） | records/i2/T-AGENT-02.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-DATA-01 | DATA | FK-TK/2 协议与校验 | 已完成 | I1 | R-DATA-01 | - | Claude（当前会话） | records/i1/T-DATA-01.md | 473d58e + 未提交工作树（I1） |
| T-DATA-02 | DATA | 存储 format 3、版本不符归档与保留代数 | 已完成 | I1 | R-DATA-02, R-DATA-03 | T-DATA-01 | Claude（当前会话） | records/i1/T-DATA-02.md | 473d58e + 未提交工作树（I1） |
| T-DATA-03 | DATA | 服务、IPC 与预加载：增删改与撤销删除 | 已完成 | I1 | R-DATA-04 | T-DATA-02 | Claude（当前会话） | records/i1/T-DATA-03.md | 473d58e + 未提交工作树（I1） |
| T-DATA-04 | DATA | 导入与导出 | 已完成 | I1 | R-DATA-06 | T-DATA-03 | Claude（当前会话） | records/i1/T-DATA-04.md | 473d58e + 未提交工作树（I1） |
| T-DATA-05 | DATA | 执行解析 v3 与冻结快照 v2 | 已完成 | I1 | R-DATA-05 | T-DATA-01 | Claude（当前会话） | records/i1/T-DATA-05.md | 473d58e + 未提交工作树（I1） |
| T-DATA-06 | DATA | 提案构造 v2 | 已完成 | I1 | R-DATA-07 | T-DATA-03 | Claude（当前会话） | records/i1/T-DATA-06.md | 473d58e + 未提交工作树（I1） |
| T-DATA-07 | DATA | 生成产物与 v2 示例 | 已完成 | I1 | R-DATA-08 | T-DATA-01, T-DATA-04 | Claude（当前会话） | records/i1/T-DATA-07.md | 473d58e + 未提交工作树（I1） |
| T-PAGE-01 | PAGE | 页面骨架、数据流、侧栏与资料集 | 已完成 | I3 | R-PAGE-01, R-PAGE-04, R-PAGE-07 | T-DATA-04 | Claude（当前会话） | records/i3/T-PAGE-01.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-PAGE-02 | PAGE | 术语表、新增行、抽屉与批量粘贴 | 已完成 | I3 | R-PAGE-02 | T-PAGE-01 | Claude（当前会话） | records/i3/T-PAGE-02.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-PAGE-03 | PAGE | 说明 | 已完成 | I3 | R-PAGE-03 | T-PAGE-01 | Claude（当前会话） | records/i3/T-PAGE-03.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-PAGE-04 | PAGE | 多选、移动与删除撤销 | 已完成 | I3 | R-PAGE-04, R-PAGE-05 | T-PAGE-02, T-PAGE-03 | Claude（当前会话） | records/i3/T-PAGE-04.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-PAGE-05 | PAGE | 导入与导出 | 已完成 | I3 | R-PAGE-06 | T-PAGE-01 | Claude（当前会话） | records/i3/T-PAGE-05.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-PAGE-06 | PAGE | 引导、文案与渲染审查 | 已完成 | I3 | R-PAGE-01, R-PAGE-07 | T-PAGE-02, T-PAGE-03, T-PAGE-04, T-PAGE-05 | Claude（当前会话） | records/i3/T-PAGE-06.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-STUDIO-01 | STUDIO | 工作台契约与主进程：翻译、试译、批量、执行记录 | 已完成 | I1 | R-STUDIO-01 | T-DATA-05 | Claude（当前会话） | records/i1/T-STUDIO-01.md | 473d58e + 未提交工作树（I1） |
| T-STUDIO-02 | STUDIO | 工作台契约与主进程：自动翻译、偏好、一致性检查 | 已完成 | I1 | R-STUDIO-01 | T-STUDIO-01 | Claude（当前会话） | records/i1/T-STUDIO-02.md | 473d58e + 未提交工作树（I1） |
| T-STUDIO-03 | STUDIO | 渲染层服务与偏好：新选择结构与最近使用 | 已完成 | I2 | R-STUDIO-02 | T-STUDIO-02 | Claude（当前会话） | records/i2/T-STUDIO-03.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-STUDIO-04 | STUDIO | 资料选择器、预设与自动翻译设置 | 已完成 | I2 | R-STUDIO-02, R-STUDIO-03 | T-STUDIO-03 | Claude（当前会话） | records/i2/T-STUDIO-04.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-STUDIO-05 | STUDIO | 试译、执行记录、失败报告与问题文案 | 已完成 | I2 | R-STUDIO-03, R-STUDIO-05 | T-STUDIO-04 | Claude（当前会话） | records/i2/T-STUDIO-05.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |
| T-STUDIO-06 | STUDIO | 记入资料确认即生效 | 已完成 | I2 | R-STUDIO-04 | T-STUDIO-03 | Claude（当前会话） | records/i2/T-STUDIO-06.md | 473d58e + 未提交工作树（knowledge-v2 I2/I3，2026-10-12） |

## 批次与批准

| 批次 | 名称 | 状态 | 范围批准 | 整体验收 |
| --- | --- | --- | --- | --- |
| I1 | 数据层 v2：协议、迁移、存储服务、执行解析、冻结快照、导入导出 | verifying | approved | pending |
| I2 | 消费方接入：字幕工作台与 Agent | verifying | approved | pending |
| I3 | 翻译资料页重做 | verifying | approved | pending |
| I4 | 收尾：Skill 文档、文案、文档、测试清理与全量回归 | planning | pending | pending |
