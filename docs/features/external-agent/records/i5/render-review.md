# 活动页面、标题栏指示与提示渲染审查（I5：T-ACTIVITY-03 / V-ACTIVITY-03-3）

环境：Windows 11，Electron（静默测试窗口，临时用户数据），真实 MCP 客户端；样本由 `test/external-agent-activity.electron.test.ts` 生成（2026-10-15，最终代码），预置两天前 codex 连接的记录（长路径转换、带长原因的失败、被拒绝的资料修改、读取）。截图位于 `screenshots/`。

| 截图 | 状态 / 视口 / 主题 / 语言 | 观察 |
| --- | --- | --- |
| screenshots/activity-notice-zh-light-1280.png | 已放行后连续写入 3 次，首页，1280×860 浅色中文 | 标题栏应用名左侧出现“● claude-code 3”胶囊，应用名仍居中；右上角一条“claude-code 做了 3 项改动 · 查看”，没有重复提示 |
| screenshots/activity-changes-zh-light-1280.png | 点指示进入，claude-code，筛选“改动” | 左侧全部连接 12、claude-code（连接中、9、问题红点）、codex（已结束、10/13 结束）；右侧概况“连接中 · 刚刚连接 · 当前权限：修改前询问 · 断开”；“今天”分组下 9 条：只读拒绝（译文图标、红色标签、次行只有耗时）、你拒绝了、你已确认、本次连接已放行（蓝色）各自可辨；进入后提示已消失、数字清零 |
| screenshots/activity-expanded-zh-light-1280.png | 展开转换与重命名 | 转换：文件名 + 完整路径、“写出 1 个文件”、在文件夹中显示；重命名：弱化旧名 → 新名与所在文件夹、“重命名 2 项”、撤销这次重命名；展开区与正文列对齐 |
| screenshots/activity-history-zh-light-1280.png | codex（两天前），展开失败与长路径转换 | 日期分组“2026年10月13日”；失败行“你已确认 + 失败”两个标签，展开后红字“执行时出错。”与完整原因换行；三个长路径在行内换行、不撑宽页面；右上角“已恢复 2 项原名”提示 |
| screenshots/activity-settings-zh-light-1280.png | 设置 → 外部 Agent | “当前连接”标题右侧“查看活动记录”，连接行“活动 / 断开”两个按钮；最近操作显示“列出字幕工作台文档 成功”（可读名） |
| screenshots/activity-en-dark-900.png | 重启后，900×700 深色英文，全部连接 | 记录仍在；英文单数“Wrote 1 translation… / Converted 1 subtitle file… the original”；标签在窄宽度下与两行正文顶部对齐；深色下蓝 / 红 / 灰标签可读 |
| screenshots/activity-cleared-en-dark-900.png | 清空后 | 只剩当前连接（Just connected，0），之后的调用继续记录（Listed Subtitle Studio documents）；右上角“Activity record cleared” |

## 发现与修复（状态/位置 → 现象 → 原因 → 改动 → 复验）

1. 点指示进入活动页 → 右上角“做了 3 项改动”的提示仍在 → 只清零了计数 → 进入页面时按连接关闭对应提示（`setActivityViewing`）并加单测与端到端断言 → 复拍 activity-changes，提示消失。
2. 只读档拒绝的写入 → 显示“读取”的眼睛图标，次行重复“写入译文” → 主进程拒绝的记录没有摘要、图标按摘要选择 → 按工具补充类别图标，次行在一句话就是工具名时不再重复 → 复拍 activity-changes / en-dark。
3. 英文 → “Wrote 1 translations”“1 files written” → 文案只有复数 → 增加 i18next `_one` 键（中日文同文）→ 复拍 en-dark。
4. 清空后左侧仍显示两个连接 → 概况条与连接行用了同一测试 id（非界面问题，测试误判）→ 概况条改为 `external-activity-session-summary`。
5. 打开文档后地址残留 `?view=documents` → 视图提示与文档提示两个 effect 基于同一快照写地址 → 文档 effect 同时去掉两者 → 断言地址为 `#/tools/subtitle/studio`。
