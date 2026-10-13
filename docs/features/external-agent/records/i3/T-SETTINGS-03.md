# 实施记录：T-SETTINGS-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-SETTINGS-03 |
| 日期 | 2026-10-13 |
| 验证版本 | 工作树快照：分支 v0.5.0，基于 2d9f88c，含 I1–I3 全部未提交改动（2026-10-13 04:10） |
| 环境 | Windows 11 Pro 10.0.26200；Node 20.19.4；Electron 41.10.6；vitest 2.1.9；@modelcontextprotocol/sdk 1.30.1；Electron 测试为 quiet 窗口模式、临时用户数据目录与临时 HOME |
| 任务指纹 | 508a7ac260dd8c480dac6361de5085c3b4edb56ccd0f8424eb993a64db981c3e |

## 实际结果

README.md 与 README.en.md 在「FusionKit Agent」后新增「外部 Agent 接入（MCP）/ External agents (MCP)」小节（开启、复制配置、Skill、三档权限、确认与撤销、只监听本机与令牌、默认关闭），并在隐私表增加一行；新增 `docs/features/external-agent/README.md`（接入步骤、工具表、安全边界、用户最终验收清单）。`test/projectMetadata.test.ts` 通过。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SETTINGS-03-1 | 通过 | file:records/i3/full-suite.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SETTINGS-04-3 | 通过 | V-SETTINGS-03-1 |

## 风险与未执行项

2026-10-13 R-SETTINGS-04 更正 Skill 通用安装目录（`~/.codex/skills` → `~/.agents/skills`，见 T-SETTINGS-06），本任务指纹随之变化；在更正后的代码上重跑相关测试全部通过（见 skill-path-tests.txt）。

README 截图未更新（新功能在设置页内，现有截图仍准确）；如需展示设置页截图，可用 scripts/readme-screenshots 重新生成。 全量回归中 3 项与本功能无关的计时用例在并发负载下失败，单独重跑全部通过（见 full-suite.txt）。
