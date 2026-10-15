<!-- spec-driven-ai-coding:generated:v2; DO NOT EDIT -->
# external-agent 任务总览

由各模块 tasks.md 生成；它不是第二份任务状态来源。

规模：L；风险：high；当前批次：I5。

| 任务 | 模块 | 标题 | 状态 | 批次 | 需求 | 依赖 | 负责人 | 实施记录 | 集成版本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-ACTIVITY-01 | ACTIVITY | 主进程记录与保存 | 已完成 | I5 | R-ACTIVITY-01 | - | Claude（当前会话） | records/i5/T-ACTIVITY-01.md | - |
| T-ACTIVITY-02 | ACTIVITY | 渲染端补充与放行方式 | 已完成 | I5 | R-ACTIVITY-01 | T-ACTIVITY-01 | Claude（当前会话） | records/i5/T-ACTIVITY-02.md | - |
| T-ACTIVITY-03 | ACTIVITY | 活动页面、标题栏指示、轻提示与设置入口 | 已完成 | I5 | R-ACTIVITY-02, R-ACTIVITY-03, R-ACTIVITY-04 | T-ACTIVITY-02 | Claude（当前会话） | records/i5/T-ACTIVITY-03.md | - |
| T-ACTIVITY-04 | ACTIVITY | I5 回归与文档 | 已完成 | I5 | R-ACTIVITY-01, R-ACTIVITY-02, R-ACTIVITY-03, R-ACTIVITY-04 | T-ACTIVITY-03 | Claude（当前会话） | records/i5/T-ACTIVITY-04.md | - |
| T-BRIDGE-01 | BRIDGE | 共享契约、设置存储与设置 IPC | 已完成 | I1 | R-BRIDGE-01 | - | Claude（当前会话） | records/i1/T-BRIDGE-01.md | 未提交工作树（基于 2d9f88c） |
| T-BRIDGE-02 | BRIDGE | 本机 HTTP 端点与 MCP 会话 | 已完成 | I1 | R-BRIDGE-02, R-BRIDGE-03 | T-BRIDGE-01 | Claude（当前会话） | records/i1/T-BRIDGE-02.md | 未提交工作树（基于 2d9f88c） |
| T-BRIDGE-03 | BRIDGE | 工具调用转发到渲染进程 | 已完成 | I1 | R-BRIDGE-04 | T-BRIDGE-02 | Claude（当前会话） | records/i1/T-BRIDGE-03.md | 未提交工作树（基于 2d9f88c） |
| T-BRIDGE-04 | BRIDGE | 端点发现文件与 stdio 桥 | 已完成 | I3 | R-BRIDGE-05, R-BRIDGE-06 | T-BRIDGE-03 | Claude（当前会话） | records/i3/T-BRIDGE-04.md | 未提交工作树（基于 2d9f88c） |
| T-SETTINGS-01 | SETTINGS | 配置片段、Skill 与安装能力 | 已完成 | I3 | R-SETTINGS-03, R-SETTINGS-04 | T-BRIDGE-04 | Claude（当前会话） | records/i3/T-SETTINGS-01.md | 未提交工作树（基于 2d9f88c） |
| T-SETTINGS-02 | SETTINGS | 设置分区与连接指示 | 已完成 | I3 | R-SETTINGS-01, R-SETTINGS-02, R-SETTINGS-03, R-SETTINGS-04 | T-SETTINGS-01 | Claude（当前会话） | records/i3/T-SETTINGS-02.md | 未提交工作树（基于 2d9f88c） |
| T-SETTINGS-03 | SETTINGS | 说明文档 | 已完成 | I3 | R-SETTINGS-04 | T-SETTINGS-02 | Claude（当前会话） | records/i3/T-SETTINGS-03.md | 未提交工作树（基于 2d9f88c） |
| T-SETTINGS-04 | SETTINGS | 桌面版客户端指引与一键写入配置 | 已完成 | I3 | R-SETTINGS-03 | T-SETTINGS-02 | Claude（当前会话） | records/i3/T-SETTINGS-04.md | 未提交工作树（基于 ab031e0） |
| T-SETTINGS-05 | SETTINGS | Cursor 桌面版一键添加 | 已完成 | I3 | R-SETTINGS-03 | T-SETTINGS-04 | Claude（当前会话） | records/i3/T-SETTINGS-05.md | 未提交工作树（基于 ab031e0） |
| T-SETTINGS-06 | SETTINGS | Skill 通用安装目录更正 | 已完成 | I3 | R-SETTINGS-04 | T-SETTINGS-01 | Claude（当前会话） | records/i3/T-SETTINGS-06.md | 未提交工作树（基于 ab031e0） |
| T-TOOLS-01 | TOOLS | 外部工具宿主与活动存储 | 已完成 | I1 | R-TOOLS-01 | T-BRIDGE-03 | Claude（当前会话） | records/i1/T-TOOLS-01.md | 未提交工作树（基于 2d9f88c） |
| T-TOOLS-02 | TOOLS | 首批读取工具 | 已完成 | I1 | R-TOOLS-02 | T-TOOLS-01 | Claude（当前会话） | records/i1/T-TOOLS-02.md | 未提交工作树（基于 2d9f88c） |
| T-TOOLS-03 | TOOLS | 信任判定与应用内确认 | 已完成 | I2 | R-TOOLS-03 | T-TOOLS-02 | Claude（当前会话） | records/i2/T-TOOLS-03.md | 未提交工作树（基于 2d9f88c） |
| T-TOOLS-04 | TOOLS | Studio 外部 Agent 轨道与 AI 译文写入 | 已完成 | I2 | R-TOOLS-06 | - | Claude（当前会话） | records/i2/T-TOOLS-04.md | 未提交工作树（基于 2d9f88c） |
| T-TOOLS-05 | TOOLS | 文档读取、导入与译文工具 | 已完成 | I2 | R-TOOLS-04, R-TOOLS-05, R-TOOLS-06 | T-TOOLS-03, T-TOOLS-04 | Claude（当前会话） | records/i2/T-TOOLS-05.md | 未提交工作树（基于 2d9f88c） |
| T-TOOLS-06 | TOOLS | 导出与本地转写工具 | 已完成 | I2 | R-TOOLS-07, R-TOOLS-08 | T-TOOLS-05 | Claude（当前会话） | records/i2/T-TOOLS-06.md | 未提交工作树（基于 2d9f88c） |
| T-TOOLS-07 | TOOLS | 翻译资料、任务进度与打开页面 | 已完成 | I2 | R-TOOLS-09, R-TOOLS-10 | T-TOOLS-03 | Claude（当前会话） | records/i2/T-TOOLS-07.md | 未提交工作树（基于 2d9f88c） |
| T-TOOLS-08 | TOOLS | 经典工具：转换、提取与任务 / 页面 | 已完成 | I4 | R-TOOLS-11, R-TOOLS-13 | - | Claude | records/i4/T-TOOLS-08.md | - |
| T-TOOLS-09 | TOOLS | 经典工具：按外部 Agent 的名称重命名 | 已完成 | I4 | R-TOOLS-12 | T-TOOLS-08 | Claude | records/i4/T-TOOLS-09.md | - |
| T-TOOLS-10 | TOOLS | I4 端到端、说明与文档 | 已完成 | I4 | R-TOOLS-11, R-TOOLS-12, R-TOOLS-13 | T-TOOLS-09 | Claude | records/i4/T-TOOLS-10.md | - |

## 批次与批准

| 批次 | 名称 | 状态 | 范围批准 | 整体验收 |
| --- | --- | --- | --- | --- |
| I1 | 最小端到端链路：本机 MCP 端点、鉴权、会话、转发与首批读取工具 | verifying | approved | pending |
| I2 | 工具面与应用内确认：外部 Agent 当译者 | verifying | approved | pending |
| I3 | 接入体验：设置页、连接指示、配置片段、stdio 桥、Skill 与文档 | verifying | approved | pending |
| I4 | 经典工具：转换、提取、按外部 Agent 的名称重命名、任务与页面 | verifying | approved | pending |
| I5 | 活动记录：外部 Agent 做了什么——本机记录、活动页面、标题栏指示与提示 | verifying | approved | pending |
