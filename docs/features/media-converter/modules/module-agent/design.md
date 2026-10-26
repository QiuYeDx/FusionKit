# agent 设计

本模块属于 I5。下面只记录设计方向，进入 I5 前再细化。

## 现状与约束

**外部 Agent**

- 工具目录：`src/agent/external/catalog.ts`。
- 主进程：`electron/main/external-agent/`，负责校验参数、判断信任档位、转发调用。
- 渲染进程：`src/agent/external/host.ts`，负责执行调用、确认弹窗（`confirmations.ts`）和活动记录。
- 长时间任务的做法：先返回任务 id，再由 Agent 轮询，参照 `start_studio_transcription` 与 `get_studio_tasks`。

**内置 Agent**

- 现代工具在 `modern-tools.ts` 中通过 `registerPreparedAction` 生成任务卡片。
- 路径权限由 `src/agent/user-intent-authority.ts` 判定。

## 方案与取舍

两类 Agent 都只做三件事：读取媒体信息、创建任务、查询或取消任务。它们与界面共用同一个主进程队列。外部 Agent 提交的文件路径，先经主进程的 `inputs.ts` 做与拖放相同的检查（必须是存在的普通文件、不是目录或符号链接），再登记为条目，然后才能使用。

## 代码落点

| 路径 | 内容 |
| --- | --- |
| `src/agent/external/catalog.ts` | 四个外部工具的定义 |
| `src/agent/external/tools/media.ts` | 工具实现 |
| `src/agent/modern-tools.ts` | 内置 Agent 的任务卡片 |
| `src/agent/capability-catalog.ts` | 能力登记 |
| `.agents/skills/fusionkit-app/SKILL.md` | 外部 Agent 使用说明 |
| `docs/features/external-agent/README.md` | 外部 Agent 文档 |

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-AGENT-01 | 内置 Agent 的任务卡片、路径授权、能力登记 |
| R-AGENT-02 | 外部工具目录、`media_files` 审批组、轮询方式 |

## 验证与风险

- **验证：** 沿用 external-agent 的工具测试与确认流程测试。
- **风险：** 外部 Agent 可能提交大量文件。沿用每次最多 50 个路径、200 个文件的上限。
