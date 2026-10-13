# 实施记录：T-SETTINGS-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-SETTINGS-02 |
| 日期 | 2026-10-13 |
| 验证版本 | 工作树快照：分支 v0.5.0，基于 2d9f88c，含 I1–I3 全部未提交改动（2026-10-13 04:10） |
| 环境 | Windows 11 Pro 10.0.26200；Node 20.19.4；Electron 41.10.6；vitest 2.1.9；@modelcontextprotocol/sdk 1.30.1；Electron 测试为 quiet 窗口模式、临时用户数据目录与临时 HOME |
| 任务指纹 | 67a70ae2ddae7fa23a01d4ef2940fa6300992bea52131be66dd897e90bec1c63 |

## 实际结果

新增设置分区 `src/pages/Setting/components/ExternalAgentConfig.tsx`（`?tab=external`）：开关与状态（运行地址 / 关闭 / 端口占用）、三档权限、端口（非法就地提示）、令牌（遮挡、显示、复制、重置二次确认）、客户端与方式两组分段按钮 + 代码块与复制、当前连接（最近操作与断开）、Skill 安装；标题栏应用名前的连接圆点；4 种语言文案。端到端（临时 HOME）逐项验证：非法端口提示、改端口后开启运行、令牌显示与复制（读主进程剪贴板）、Claude Code / Codex / stdio / Cursor 片段内容与复制、两个连接与最近操作、标题栏圆点「2 个外部 Agent 已连接」、切到只读后外部写入被拒、断开后该客户端请求失败、端口占用状态与恢复、重置令牌后连接清空与圆点消失、两处 Skill 安装且内容与仓库一致；英文深色 900×700 下页面无横向滚动而代码块可滚动。渲染审查发现 4 处问题均已修复并复拍（ui-review.md）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SETTINGS-02-1 | 通过 | file:records/i3/full-suite.log |
| V-SETTINGS-02-2 | 通过 | file:records/i3/ui-review.md |
| V-SETTINGS-02-3 | 通过 | file:records/i3/static.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SETTINGS-01-1 | 通过 | V-SETTINGS-02-1, V-SETTINGS-02-2 |
| AC-SETTINGS-01-2 | 通过 | V-SETTINGS-02-1, V-SETTINGS-02-2 |
| AC-SETTINGS-01-3 | 通过 | V-SETTINGS-02-1 |
| AC-SETTINGS-01-4 | 通过 | V-SETTINGS-02-1 |
| AC-SETTINGS-01-5 | 通过 | V-SETTINGS-02-1, V-SETTINGS-02-2 |
| AC-SETTINGS-02-1 | 通过 | V-SETTINGS-02-1, V-SETTINGS-02-2 |
| AC-SETTINGS-02-2 | 通过 | V-SETTINGS-02-1 |
| AC-SETTINGS-03-1 | 通过 | V-SETTINGS-02-1, V-SETTINGS-02-3 |
| AC-SETTINGS-03-3 | 通过 | V-SETTINGS-02-1, V-SETTINGS-02-2 |
| AC-SETTINGS-04-1 | 通过 | V-SETTINGS-02-1 |

## 风险与未执行项

日文与繁体中文界面未截图审阅（文案已过 i18n 检查，长度与中文/英文相近）；标题栏圆点在 macOS 交通灯布局下未实测。 全量回归中 3 项与本功能无关的计时用例在并发负载下失败，单独重跑全部通过（见 full-suite.log）。
