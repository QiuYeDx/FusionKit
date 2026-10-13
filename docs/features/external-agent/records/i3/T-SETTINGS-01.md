# 实施记录：T-SETTINGS-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-SETTINGS-01 |
| 日期 | 2026-10-13 |
| 验证版本 | 工作树快照：分支 v0.5.0，基于 2d9f88c，含 I1–I3 全部未提交改动（2026-10-13 04:10） |
| 环境 | Windows 11 Pro 10.0.26200；Node 20.19.4；Electron 41.10.6；vitest 2.1.9；@modelcontextprotocol/sdk 1.30.1；Electron 测试为 quiet 窗口模式、临时用户数据目录与临时 HOME |
| 任务指纹 | 5122b7404510acb463101bdc4871420da033d59b8542e62d77293807445ddc31 |

## 实际结果

新增 `src/agent/external/client-configs.ts`（Claude Code 命令、Codex TOML、Cursor / 通用 mcp.json；HTTP 与 stdio；含反斜杠的路径在 shell 中加引号、TOML 用字面量字符串、含撇号时转义）；`electron/main/external-agent/skill.ts` 以 `?raw` 内联随附 Skill，安装到 `<home>/.claude|.codex/skills/fusionkit-app/SKILL.md`（临时文件后替换）并报告是否为当前版本，IPC install-skill / skill-status；编写 `.agents/skills/fusionkit-app/SKILL.md`（前提、信任档位、翻译流程六步、确认与错误处理，不复述工具参数）与 `agents/openai.yaml`。静态审阅：frontmatter 含 name: fusionkit-app 与 description；正文覆盖接入前提、工作流、confirmation_pending / declined_by_user / read_only 处理与常见错误。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SETTINGS-01-1 | 通过 | file:records/i3/full-suite.log |
| V-SETTINGS-01-2 | 通过 | inline:审阅 .agents/skills/fusionkit-app/SKILL.md：frontmatter name/description 齐全；章节为 Before you start / Translate subtitles / When FusionKit asks the user / Errors；单测 skill.test.ts 断言其包含 “Settings → External Agent” 与 get_confirmation_result |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SETTINGS-03-2 | 通过 | V-SETTINGS-01-1 |
| AC-SETTINGS-04-1 | 通过 | V-SETTINGS-01-1 |
| AC-SETTINGS-04-2 | 通过 | V-SETTINGS-01-1, V-SETTINGS-01-2 |

## 风险与未执行项

各客户端配置格式（尤其 Codex 的 http_headers 与 Cursor 的 url 写法）依据当前已知文档生成，需用户用真实客户端验收确认；如格式在新版客户端变化，只需调整 client-configs.ts。 全量回归中 3 项与本功能无关的计时用例在并发负载下失败，单独重跑全部通过（见 full-suite.log）。
