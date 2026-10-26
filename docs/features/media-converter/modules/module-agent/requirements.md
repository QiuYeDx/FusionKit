# agent 需求

需求行为只在这里定义；业务目标来源于 [brd.md](../../brd.md)。本模块属于 I5，目前只写目标，进入 I5 前再细化验收标准。

## 目标与范围

让内置的 FusionKit Agent 和外部 Agent（MCP）都能调用媒体转换功能。这个功能不需要 API Key，符合外部 Agent 只开放「不需要 Key 的能力」的决策（external-agent A-06）。

## 范围外

- 不让 Agent 直接拼接 ffmpeg 参数，也不让它执行任意命令。
- 不开放高级参数中的白名单外文本。
- 未经用户确认，不覆盖已有文件。

## 需求

### R-AGENT-01 内置 Agent 准备转换任务

| 字段 | 值 |
| --- | --- |
| 来源 | BR-08 |
| 状态 | deferred |
| 批次 | I5 |
| 优先级 | P1 |

#### 说明

内置 Agent 根据用户亲手输入的文件路径，生成「媒体转换」任务卡片，卡片内容包括任务类型、档位与编码。用户确认后，任务加入转换队列。

- 路径授权沿用 `userMentionedPath`。
- 覆盖文件沿用 `userRequestedOverwrite`。
- 在 `AGENT_CAPABILITIES` 中登记能力，相应更新能力目录测试。

### R-AGENT-02 外部 Agent 媒体工具

| 字段 | 值 |
| --- | --- |
| 来源 | BR-08 |
| 状态 | deferred |
| 批次 | I5 |
| 优先级 | P1 |

#### 说明

新增四个工具：

| 工具 | 类别 | 用途 |
| --- | --- | --- |
| `inspect_media_files` | 读取 | 返回媒体摘要 |
| `start_media_conversion` | 写入 | 发起转换，使用新审批组 `media_files` |
| `get_media_tasks` | 读取 | 查询任务状态 |
| `cancel_media_task` | 写入 | 取消任务 |

其他要求：

- 覆盖已有文件属于破坏性操作，在任何信任档位下都要确认。
- 长时间任务返回任务 id，由外部 Agent 轮询进度。
- 同步更新以下内容：
  - 外部 Agent 的权限码；
  - 确认文案；
  - 活动记录说明；
  - `instructions.ts`；
  - `open_fusionkit_page`；
  - `.agents/skills/fusionkit-app/SKILL.md`；
  - `docs/features/external-agent/README.md`。

## 约束

- 工具的描述用英文（面向外部模型），参数用严格的 zod schema。
- 执行时复用 engine 的队列和授权，不另建一条执行路径。
