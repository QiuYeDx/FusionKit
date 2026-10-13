# 实施记录：T-SETTINGS-06

| 字段 | 值 |
| --- | --- |
| 任务 | T-SETTINGS-06 |
| 日期 | 2026-10-13 |
| 验证版本 | 工作树快照：分支 v0.5.0，基于 ab031e0，含桌面版客户端、Cursor 一键添加与 Skill 目录更正（2026-10-13 06:00） |
| 环境 | Windows 11 Pro 10.0.26200；Node 20.19.4；Electron 41.10.6；vitest 2.1.9；Electron 测试为 quiet 窗口模式、临时用户数据目录与临时 HOME |
| 任务指纹 | a64074a9895e50dffd2347b09c422bea8914a5a0d568c20d73276df02d9e42bc |

## 实际结果

按用户指正并核对 OpenAI Codex 文档（用户级 Skill 位于 `$HOME/.agents/skills`），把第二个安装目标由 `codex`（`~/.codex/skills/fusionkit-app/`）改为 `agents`（通用目录 `~/.agents/skills/fusionkit-app/`，Codex、Cursor 等共用）；Claude Code 仍为 `~/.claude/skills/fusionkit-app/`。同步修改契约类型、主进程安装与状态、设置页按钮「安装到通用目录（Codex、Cursor 等）」与说明（4 种语言）、feature README 与需求/设计。端到端：点击后界面显示 `~/.agents/skills/fusionkit-app/SKILL.md` 路径，且未创建 `~/.codex/skills`。截图 screenshots/settings-skill-zh-light-1280.png 审阅：说明两行、两个按钮与两条已安装路径排版正常。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SETTINGS-06-1 | 通过 | file:records/i3/skill-path-tests.txt |
| V-SETTINGS-06-2 | 通过 | file:records/i3/skill-path-tests.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SETTINGS-04-1 | 通过 | V-SETTINGS-06-1, V-SETTINGS-06-2 |

## 风险与未执行项

此前若已按旧版本装过 `~/.codex/skills/fusionkit-app/`，该副本不会被自动删除（Codex 不从该目录加载，留着无影响）；只在本机测试环境验证，真实 Codex、Cursor 加载 `~/.agents/skills` 留待用户验收。
