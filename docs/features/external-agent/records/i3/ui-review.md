# 设置分区渲染审查（T-SETTINGS-02 / V-SETTINGS-02-2）

环境：Windows 11，Electron 41.10.6，quiet 测试窗口；样本由 `test/external-agent-settings.electron.test.ts` 生成，截图在 `screenshots/`（最后一次源码修改后的运行）。参照：`src/pages/Setting/components/AgentConfig.tsx`。

| 截图 | 状态 / 视口 / 主题 / 语言 | 观察 |
| --- | --- | --- |
| screenshots/settings-off-zh-light-1280.png | 关闭，1280×860，浅色，中文 | 与 Agent 分区同构：开关行、三档权限列表（推荐标注）、端口与「开启后生成」、片段区提示；左侧导航新增「外部 Agent」 |
| screenshots/settings-on-zh-light-1280.png | 开启，Claude Code HTTP | 状态行绿色圆点 + 等宽地址；客户端与方式两行分段按钮；代码块内横向滚动 |
| screenshots/settings-connections-zh-light-1280.png | 两个连接 | 令牌显示中；连接行「刚刚连接 · 最近：list_studio_documents 成功」+ 断开按钮；标题栏应用名前绿点 |
| screenshots/settings-port-busy-zh-light-1280.png | 端口被占用 | 状态行红字「端口 N 已被其他程序占用，请换一个端口。」 |
| screenshots/settings-skill-zh-light-1280.png | 两处 Skill 已安装 | 已安装路径以小字换行显示；成功 toast |
| screenshots/settings-on-en-dark-900.png、settings-stdio-en-dark-900.png、settings-connections-en-dark-900.png | 900×700，深色，英文 | 英文提示换行正常；stdio 长路径只在代码块内滚动，页面无横向滚动（测试断言 scrollWidth） |

## 发现与修复

1. 900×700 stdio → 长命令把整列撑宽，卡片横向滚动、提示不换行 → 设置页 ScrollArea 内容按 table 布局，`whitespace-pre` 代码块的最小内容宽度决定列宽 → 代码块容器 `w-0 min-w-full`，不参与固有宽度 → 复拍：只在代码块内滚动，测试增加页面无横向滚动、代码块可滚动的断言。
2. 代码块复制按钮 → 压在代码文字上 → 绝对定位无底色 → 按钮外层加边框与半透明背景 → 复拍可辨识。
3. 客户端标签与连接方式标签同一行 → 看起来像 6 个选项且有两个选中 → 两组放在同一 flex 行 → 改为上下两行 → 复拍分组清楚。
4. 端口占用截图未包含状态行（测试滚动目标不对）→ 改为把状态行滚到视口中央后截图 → 复拍可见红字状态。

## 桌面版客户端（T-SETTINGS-04 / V-SETTINGS-04-3，2026-10-13）

| 截图 | 状态 / 视口 / 主题 / 语言 | 观察 |
| --- | --- | --- |
| screenshots/settings-claude-desktop-zh-light-1280.png | Claude 桌面端，写入后 | stdio JSON；「写入配置文件」「打开所在文件夹」；绿色「已写入」与灰色备份路径 |
| screenshots/settings-other-fields-zh-light-1280.png | 其他客户端 HTTP | 三步指引、JSON、逐项「地址 / 请求头」与复制按钮 |
| screenshots/settings-claude-desktop-en-dark-900.png | Claude app，900×700 深色英文 | 只有 stdio 时以一行说明代替方式切换；四步指引换行正常 |

发现与修复：英文 900×700 下五个等宽分段按钮中「Claude Desktop」被截断 → 分段按钮按等宽列分配，最长标签略超列宽（改为全宽后仍不足）→ 英文/日文标签改为较短的「Claude app / Claude アプリ」，说明行与指引中保留「Claude Desktop」名称 → 复拍完整显示。

## Cursor 桌面版（T-SETTINGS-05 / V-SETTINGS-05-3，2026-10-13）

| 截图 | 状态 / 视口 / 主题 / 语言 | 观察 |
| --- | --- | --- |
| screenshots/settings-cursor-zh-light-1280.png | Cursor，HTTP，1280×860 浅色中文 | 按钮组以主按钮「添加到 Cursor」开头，其后为描边「写入配置文件」与文字按钮「打开所在文件夹」，层级清楚；三步指引（安装确认、全局 / 项目 mcp.json、Customize 中启用）换行正常；配置文件路径显示在按钮下方。无需修改。 |
