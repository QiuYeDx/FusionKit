# 实施记录：T-ACTIVITY-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-ACTIVITY-04 |
| 日期 | 2026-10-15 |
| 验证版本 | snapshot-sha256:fe6b90fd09af56e3c3a82588aff2d0bc6babaacf72d7c8c96a8145ce62a6474b（基线 de422be + 未提交工作树） |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet），MCP 官方 SDK 客户端（external-agent 测试），临时用户数据与临时目录，无网络服务 |
| 任务指纹 | 0fc46382b0c6171ebb911b061ea8219b78390a0d33b721f082ea52fba9ad01d5 |

## 实际结果

外部 Agent 单元与全部 external-agent Electron 测试、全量回归通过（既有的 export-ui、library-ui 门控失败除外）；回归中发现并修复：设置页与基础 Electron 测试的旧断言（工具可读名、notices 字段、指示的悬停说明）、字幕工作台新增 sonner 依赖越过审计边界（改用工作台自己的提示）、活动记录单元测试在清理目录时与未完成写入竞争。CHANGELOG 0.5.0、README（中英）、外部 Agent README 验收第 8 项、官网说明、TODO 已更新。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ACTIVITY-04-1 | 通过 | file:records/i5/e2e.txt |
| V-ACTIVITY-04-2 | 通过 | file:records/i5/regression.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ACTIVITY-01-1 | 通过 | V-ACTIVITY-04-1 |
| AC-ACTIVITY-02-1 | 通过 | V-ACTIVITY-04-1 |
| AC-ACTIVITY-03-1 | 通过 | V-ACTIVITY-04-1 |

## 风险与未执行项

用户在真实外部客户端上的整体验收未进行（README 验收清单第 8 项）。
