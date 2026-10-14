# 确认对话框渲染审查（I4：T-TOOLS-09 / V-TOOLS-09-2）

环境：Windows 11，Electron（quiet 测试窗口）；样本由 `test/external-agent-classic.electron.test.ts` 在临时目录中生成（2026-10-14，最终代码），截图位于 `screenshots/`。

| 截图 | 状态 / 视口 / 主题 / 语言 | 观察 |
| --- | --- | --- |
| screenshots/confirm-convert-zh-light-1280.png | 文件夹（2 个 ASS + 1 个 SRT）转 SRT，1280 浅色中文 | 标题“claude-code 请求转换字幕文件”；摘要“把 2 个字幕文件转换为 SRT，保存在各自原文件旁，重名时自动编号”；只列出两个 ASS（文件名 + 完整路径副文本）；有本次连接放行复选框 |
| screenshots/confirm-rename-zh-light-1280.png | 3 项重命名，1280 浅色中文 | 每行弱化灰色旧名 → 新名，下方为所在文件夹；摘要说明由深到浅执行、失败自动还原、完成后可撤销；没有放行复选框（总是确认） |
| screenshots/confirm-rename-many-zh-light-1280.png | 25 项重命名 | 摘要“把下面 25 个文件或文件夹……”；列出 8 行，内容区出现细滚动条，底部渐隐，滚动到底为“另有 17 项”（端到端断言该文字） |
| screenshots/confirm-rename-en-dark-900.png | 900 深色英文 | 2 项；英文摘要三行换行正常；弱化旧名 → 新名在深色下可区分；默认焦点在 Decline |

## 发现与修复（状态/位置 → 现象 → 原因 → 改动 → 复验）

1. 重命名行 → 旧名与新名同为主文本，难以分辨方向 → 条目只有 text → `ConfirmationItem.from` 以弱化色显示旧名 + “→” → 复拍 rename 三张。
2. 转换确认框 → 文件夹中已是 SRT 的 Bilingual.srt 也列在“把 3 个字幕文件转换为 SRT”中，条数与实际转换不符 → 同格式文件在确认后才跳过 → 确认前分出同格式文件，只列需要转换的文件；全部同格式时不请求确认，直接返回跳过结果（规格纠正、批准摘要已刷新；单元测试与端到端断言更新）→ 复拍 confirm-convert-zh-light-1280，列出 2 项。
