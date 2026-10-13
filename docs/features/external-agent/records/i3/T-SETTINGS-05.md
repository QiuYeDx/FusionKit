# 实施记录：T-SETTINGS-05

| 字段 | 值 |
| --- | --- |
| 任务 | T-SETTINGS-05 |
| 日期 | 2026-10-13 |
| 验证版本 | 工作树快照：分支 v0.5.0，基于 ab031e0，含桌面版客户端与 Cursor 一键添加改动（2026-10-13 05:30） |
| 环境 | Windows 11 Pro 10.0.26200；Node 20.19.4；Electron 41.10.6；vitest 2.1.9；Electron 测试为 quiet 窗口模式、临时用户数据目录与临时 HOME |
| 任务指纹 | fdf92e852561034c027f29c56915553d18f027db967e498d6e7f08f8621047f8 |

## 实际结果

按 Cursor 官方文档（cursor.com/docs/mcp/install-links、cursor.com/docs/context/mcp）实现「添加到 Cursor」：`cursorInstallLink` 生成 `cursor://anysphere.cursor-deeplink/mcp/install?name=fusionkit&config=…`（服务器项 JSON 按 UTF-8 编码后 base64，再做 URL 编码）；主进程 IPC `open-client-install` 只接受 Cursor、在主进程生成链接并校验前缀后由系统打开；Cursor 标签的按钮组以「添加到 Cursor」为首，指引改为安装确认、全局与项目 mcp.json、侧边栏 Customize 中启用（4 种语言）；README（中英）与 feature README 的 Cursor 说明同步更新。单测解码链接与服务器项一致（含中文路径）。端到端在主进程替换 `shell.openExternal` 记录链接：点击后恰好打开一次，前缀正确，解码为当前地址与 `Bearer` 令牌；指引含 Customize。截图 screenshots/settings-cursor-zh-light-1280.png 审阅：主按钮、次按钮与文件夹按钮层级清楚，三步指引完整换行，无需修改。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SETTINGS-05-1 | 通过 | file:records/i3/cursor-tests.txt |
| V-SETTINGS-05-2 | 通过 | file:records/i3/cursor-tests.txt |
| V-SETTINGS-05-3 | 通过 | file:records/i3/ui-review.md |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SETTINGS-03-6 | 通过 | V-SETTINGS-05-1, V-SETTINGS-05-2, V-SETTINGS-05-3 |

## 风险与未执行项

本机未安装 Cursor，没有实际打开 Cursor 的安装确认；链接格式依据官方文档，需用户验收确认。论坛报告过 Cursor 网页版生成器的链接双重编码问题，这里只使用 cursor:// 深链接并只编码一次。
