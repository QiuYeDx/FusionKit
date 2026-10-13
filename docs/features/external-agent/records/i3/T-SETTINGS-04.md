# 实施记录：T-SETTINGS-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-SETTINGS-04 |
| 日期 | 2026-10-13 |
| 验证版本 | 工作树快照：分支 v0.5.0，基于 ab031e0，含桌面版客户端改动（2026-10-13 05:00） |
| 环境 | Windows 11 Pro 10.0.26200；Node 20.19.4；Electron 41.10.6；vitest 2.1.9；Electron 测试为 quiet 窗口模式、临时用户数据目录与临时 HOME |
| 任务指纹 | 9f844c278aa3d71a2a57fc724552ac6457b10196ff3207b92bd666750bda38dc |

## 实际结果

按用户「Codex 和 Claude Code 可能是桌面端」的要求，先查证各桌面版的配置方式（见 changes/2026-10-13-desktop-clients.md），再实现：客户端新增「Claude 桌面端」（仅 stdio，`clientTransports`）；每个客户端改为三步指引，分别写明终端版与桌面版的配置位置、菜单与生效方式；主进程 `client-config-writer.ts` 为 Claude 桌面端、Codex、Cursor 提供「写入配置文件」（JSON 只设 `mcpServers.fusionkit`、TOML 替换 `[mcp_servers.fusionkit]` 及子表、写前备份为 `.fusionkit-backup`、无法解析拒绝写入）与「打开所在文件夹」、配置状态；「其他客户端」逐项列出地址 / 请求头或命令 / 参数 / 环境变量。端到端（临时 HOME）：Claude 桌面端无 HTTP 选项且指引含「设置 → 开发者 → 编辑配置」；写入预置的 claude_desktop_config.json 后原有服务器保留、新增项与片段一致、备份存在；预置的 config.toml 写入后原表保留、只出现一次 fusionkit 表且地址正确；损坏的 mcp.json 提示无法解析且文件不变；其他客户端显示地址与请求头。README（中英）与 feature README 更新为终端/桌面版接入表。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SETTINGS-04-1 | 通过 | file:records/i3/desktop-tests.txt |
| V-SETTINGS-04-2 | 通过 | file:records/i3/desktop-tests.txt |
| V-SETTINGS-04-3 | 通过 | file:records/i3/ui-review.md |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SETTINGS-03-4 | 通过 | V-SETTINGS-04-2, V-SETTINGS-04-3 |
| AC-SETTINGS-03-5 | 通过 | V-SETTINGS-04-1, V-SETTINGS-04-2 |

## 风险与未执行项

2026-10-13 R-SETTINGS-03 追加 Cursor 一键添加（AC-SETTINGS-03-6），本任务指纹随之变化；在追加后的代码上重跑相关单元与设置端到端测试全部通过（见 cursor-tests.txt），本任务交付内容不变。

真实的 Claude 桌面端、Claude Code 桌面版与 Codex 桌面版本机未安装，配置文件路径与菜单名称依据官方文档（Claude Desktop 配置路径与菜单为第三方资料）实现，需用户验收确认；macOS 路径只有单测覆盖。
