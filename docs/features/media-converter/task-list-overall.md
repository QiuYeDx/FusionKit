<!-- spec-driven-ai-coding:generated:v2; DO NOT EDIT -->
# media-converter 任务总览

由各模块 tasks.md 生成；它不是第二份任务状态来源。

规模：L；风险：medium；当前批次：I1。

| 任务 | 模块 | 标题 | 状态 | 批次 | 需求 | 依赖 | 负责人 | 实施记录 | 集成版本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-ENCODE-01 | ENCODE | 兼容矩阵、任务矩阵、流规划与参数骨架 | 未开始 | I1 | R-ENCODE-01, R-ENCODE-06 | T-ENGINE-01 | - | - | - |
| T-ENCODE-02 | ENCODE | 视频编码器选择链与参数表 | 未开始 | I1 | R-ENCODE-02, R-ENCODE-01 | T-ENCODE-01 | - | - | - |
| T-ENCODE-03 | ENCODE | 视频正确性：旋转、色彩、HDR、VFR、隔行 | 未开始 | I1 | R-ENCODE-03 | T-ENCODE-02 | - | - | - |
| T-ENCODE-04 | ENCODE | 音频转换、提取与视频内音频 | 未开始 | I1 | R-ENCODE-04, R-ENCODE-05 | T-ENCODE-03 | - | - | - |
| T-ENCODE-05 | ENCODE | 真实样片校准与端到端验证 | 未开始 | I1 | R-ENCODE-02 | T-ENCODE-04, T-ENGINE-07 | - | - | - |
| T-ENGINE-01 | ENGINE | 运行时校验与媒体探测 | 未开始 | I1 | R-ENGINE-01, R-ENGINE-02 | - | - | - | - |
| T-ENGINE-02 | ENGINE | 进程封装与进度 | 未开始 | I1 | R-ENGINE-04 | T-ENGINE-01 | - | - | - |
| T-ENGINE-03 | ENGINE | 编码能力探测（真实参数） | 未开始 | I1 | R-ENGINE-03 | T-ENGINE-02, T-ENCODE-02 | - | - | - |
| T-ENGINE-04 | ENGINE | 安全输出 | 未开始 | I1 | R-ENGINE-06 | T-ENGINE-01 | - | - | - |
| T-ENGINE-05 | ENGINE | 主进程队列、持久化与生命周期 | 未开始 | I1 | R-ENGINE-05 | T-ENGINE-02, T-ENGINE-04, T-ENCODE-01 | - | - | - |
| T-ENGINE-06 | ENGINE | IPC、预加载 API、注册与审计登记 | 未开始 | I1 | R-ENGINE-07, R-ENGINE-01, R-ENGINE-05 | T-ENGINE-07 | - | - | - |
| T-ENGINE-07 | ENGINE | 执行器：单个条目的端到端执行 | 未开始 | I1 | R-ENGINE-03, R-ENGINE-04, R-ENGINE-06 | T-ENGINE-03, T-ENGINE-05, T-ENCODE-02, T-ENCODE-03, T-ENCODE-04 | - | - | - |
| T-WORKBENCH-01 | WORKBENCH | 工具注册、目录分区、文案骨架与 UI 测试骨架 | 未开始 | I1 | R-WORKBENCH-01 | T-ENGINE-06 | - | - | - |
| T-WORKBENCH-02 | WORKBENCH | 控制器、偏好设置与设置面板 | 未开始 | I1 | R-WORKBENCH-03, R-WORKBENCH-05 | T-WORKBENCH-01, T-ENCODE-04 | - | - | - |
| T-WORKBENCH-03 | WORKBENCH | 添加文件、媒体信息、处理计划与损失警告 | 未开始 | I1 | R-WORKBENCH-02, R-WORKBENCH-03 | T-WORKBENCH-02 | - | - | - |
| T-WORKBENCH-04 | WORKBENCH | 队列操作、开始前确认、进度与结果 | 未开始 | I1 | R-WORKBENCH-04, R-WORKBENCH-03, R-ENGINE-05 | T-WORKBENCH-03, T-ENGINE-07 | - | - | - |
| T-WORKBENCH-05 | WORKBENCH | I1 集成验收材料 | 未开始 | I1 | R-WORKBENCH-01, R-WORKBENCH-02, R-WORKBENCH-03, R-WORKBENCH-04, R-WORKBENCH-05 | T-WORKBENCH-04, T-ENCODE-05 | - | - | - |

## 批次与批准

| 批次 | 名称 | 状态 | 范围批准 | 整体验收 |
| --- | --- | --- | --- | --- |
| I1 | Windows 端到端主链路：探测、能力、队列、安全输出、压缩/转换/提取音频（简单模式） | implementing | approved | pending |
| I2 | 智能压缩：目标大小、VMAF 画质目标、压缩前预估、预览对比与画质报告 | planning | pending | pending |
| I3 | 高阶设置：码控与编码器参数、滤镜与音频处理、自定义预设、GIF/WebP 与无损裁剪 | planning | pending | pending |
| I4 | macOS 媒体引擎与平台支持 | planning | pending | pending |
| I5 | Agent 接入（内置 + MCP）与 0.6.0 发布收尾 | planning | pending | pending |
