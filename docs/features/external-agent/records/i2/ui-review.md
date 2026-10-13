# 确认对话框渲染审查（T-TOOLS-03 / V-TOOLS-03-3）

环境：Windows 11，Electron 41.10.6，quiet 测试窗口；样本由 `test/external-agent-tools.electron.test.ts` 生成，截图位于 `screenshots/`（与最终代码对应，2026-10-13 最后一次运行）。

| 截图 | 状态 / 视口 / 主题 / 语言 | 观察 |
| --- | --- | --- |
| screenshots/confirm-import-zh-light-1280.png | 10 个路径（含深层长路径），1280×860，浅色，中文 | 每行先显示文件夹名，下方小号灰字为完整路径；8 行后显示「另有 2 项」；内容区可滚动，底部渐隐；默认焦点在「拒绝」 |
| screenshots/confirm-translation-zh-light-1280.png | 新建译文轨道，带本次连接放行复选框 | 一行显示新轨道名，下方为文档与语言；复选框与按钮同行 |
| screenshots/confirm-overwrite-zh-light-1280.png | 覆盖导出（destructive），自动档 | 红色警示「同名文件会被覆盖，无法撤销」；允许按钮为 destructive 变体；无放行复选框 |
| screenshots/confirm-queue-zh-light-1280.png | 3 个请求排队 | 标题右侧「还有 2 个请求」，与关闭按钮同一行不重叠 |
| screenshots/confirm-knowledge-zh-light-1280.png | 资料变更 4 项 | 每行左侧种类标签（新资料集 / 术语），译法为主文本，资料集名为副文本 |
| screenshots/confirm-import-en-dark-900.png | 2 个路径，900×700，深色，英文 | 英文复选框文案换为两行，按钮保持同一行；深色对比正常 |
| screenshots/confirm-overwrite-en-dark-900.png | 覆盖导出，900×700，深色，英文 | 警示两行换行正常，按钮配色可读 |
| screenshots/studio-agent-track-zh-light-1280.png | 外部 Agent 写入后的字幕工作台 | 轨道选择器显示 claude-code；两句译文可见、无复核标记；撤销按钮可用（名称「撤销：外部 Agent 写入 2 条译文」） |

## 发现与修复

1. 导入对话框 → 完整路径逐行 break-all 断词、各行难以区分 → 条目只有一段文本 → 条目改为 `{ text, detail, tag }`，路径显示末段名 + 完整路径副文本 → 复拍 confirm-import-*，可读性改善。
2. 路径末段提取 → Windows 路径未拆分（编辑时反斜杠丢失）→ 正则字符类缺少 `\` → 修正并增加 `pathItem` 单测 → 复拍确认显示「subtitles」「Subtitles (Japanese)」。
3. 新建轨道对话框 → 列表重复描述里的文档名 → 先改为不显示列表后出现页脚下方空白（动画高度测量与无内容区不匹配）→ 恢复内容区，改为显示新轨道一行（名 + 文档 · 语言）→ 复拍无空白。
4. 资料变更对话框 → 新资料集与术语外观相同 → 增加种类标签（4 种语言）与资料集副文本 → 复拍确认。
