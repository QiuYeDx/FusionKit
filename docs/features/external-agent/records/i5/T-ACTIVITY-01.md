# 实施记录：T-ACTIVITY-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-ACTIVITY-01 |
| 日期 | 2026-10-15 |
| 验证版本 | snapshot-sha256:fe6b90fd09af56e3c3a82588aff2d0bc6babaacf72d7c8c96a8145ce62a6474b（基线 de422be + 未提交工作树） |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet），MCP 官方 SDK 客户端（external-agent 测试），临时用户数据与临时目录，无网络服务 |
| 任务指纹 | f90f6a2218ef33160483de65946ea7c0a97d61d103c8cd36e18bb8e2805fbd50 |

## 实际结果

共享契约 `src/agent/external/activity.ts`（记录、补充、更新、分页请求的 zod schema 与上限；改动 / 问题 / 未询问判定）。主进程 `ActivityLog`（`electron/main/external-agent/activity-log.ts`）：`activity.jsonl` 逐行事件（call / update / session / end / undone），追加经串行队列，写失败只警告一次、不影响调用；加载时跳过坏行与超长行、折叠更新、按 30 天与“改动 2000 / 读取 1000”裁剪并重写；单条超过 8 KB 时先去条目再去补充。`index.ts` 为每次调用写记录（含只读档在主进程的拒绝、窗口不可用、取消、等待确认），会话 / 客户端 / 工具取自主进程自己的调用信息；`RendererBridge` 解析并校验窗口补充，不合法时丢弃补充、保留结果，补充不回传客户端。通道：分页列表、连接汇总、清空（保留当前连接）、标记已撤销、延后确认的结果上报（只更新 pending 记录）、推送。设置新增 `notices`（默认开，旧文件补默认值）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ACTIVITY-01-1 | 通过 | file:records/i5/unit-main.txt |
| V-ACTIVITY-01-2 | 通过 | file:records/i5/static.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ACTIVITY-01-2 | 通过 | V-ACTIVITY-01-1 |
| AC-ACTIVITY-01-4 | 通过 | V-ACTIVITY-01-1 |
| AC-ACTIVITY-01-5 | 通过 | V-ACTIVITY-01-1 |

## 风险与未执行项

记录文件只在本机，不加密（与设置文件同一目录、0600 权限）。
