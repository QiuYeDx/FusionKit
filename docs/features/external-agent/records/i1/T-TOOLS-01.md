# 实施记录：T-TOOLS-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-TOOLS-01 |
| 日期 | 2026-10-13 |
| 验证版本 | 工作树快照：分支 v0.5.0，基于 2d9f88c，含本增量全部未提交改动（2026-10-13 02:20） |
| 环境 | Windows 11 Pro 10.0.26200；Node 20.19.4；Electron 41.10.6；vitest 2.1.9；@modelcontextprotocol/sdk 1.30.1；Electron 测试为 quiet 窗口模式、临时用户数据目录 |
| 任务指纹 | 4bf512416a1031cd534306bf0a3330e8538e49da8c8324c8b8ae3fbc6803a9ed |

## 实际结果

实现 `src/agent/external/host.ts`（安装时订阅调用/取消/状态并声明就绪；二次校验、未知工具、ExternalToolError 保留错误码、异常转 tool_failed 并以已配置 API Key 脱敏、截断 600 字符；取消触发工具中止信号）、`store.ts`（每会话最近 50 条活动，会话结束即清除）、`errors.ts`；无界面组件 `src/pages/AgentDock/ExternalAgentHost.tsx` 挂在 `App.tsx`。端到端：应用启动后主进程收到就绪，外部客户端调用得到窗口回传的真实数据。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TOOLS-01-1 | 通过 | file:records/i1/unit.txt |
| V-TOOLS-01-2 | 通过 | file:records/i1/e2e.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TOOLS-01-1 | 通过 | V-TOOLS-01-1, V-TOOLS-01-2 |
| AC-TOOLS-01-2 | 通过 | V-TOOLS-01-1 |
| AC-TOOLS-01-3 | 通过 | V-TOOLS-01-1 |
| AC-TOOLS-01-4 | 通过 | V-TOOLS-01-1 |

## 风险与未执行项

活动记录在真实应用中尚无界面可见（I3 的连接指示读取它），本增量以单测验证其内容与上限；活动记录的内容与上限以 V-TOOLS-01-1 单测为准。
