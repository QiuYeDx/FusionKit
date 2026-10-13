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
