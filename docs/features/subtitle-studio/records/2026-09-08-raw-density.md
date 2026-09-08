# 原始内容密度优化

用户要求先提交已有代码，再适当优化原始内容视图的边距与信息密度。上一轮纵向布局已提交为 `ddf178b`，本轮未要求推送。以下改动尚未提交，不推进 T03。

## 设计与修复

以工作台现有字幕预览和语义主题色为参照，仅调整 `.studio-raw`，保留现有 Tab、分页和下载控件。目标是连续扫描源内容，正文仍使用原有 11px 等宽字号，并自然换行。

SRT 源节点包含分隔空行，原有上下各 12px padding 与约 20px 行高叠加后导致块间过松。现在上下 padding 为 4px，行高为 16px；序号栏从 44px 调为 36px、右对齐并采用相同行高。没有 trim 原文，没有修改解析、存储或导出。

## 验证

- 根 Vite renderer/main/preload 构建、preload 外部模块检查通过；未安装依赖或更新 lockfile。
- 扩展已有 `workspace-ui.test.ts`：逐字核对首个源节点包含末尾空行；普通 SRT 块实测 73px，多行及长行样本均为 89px，按内容增长。分页、键盘切换、源文件导出一致性仍通过。
- 首次运行在进入原始内容前的既有文件名 hover Tooltip 检查处超时；未改动该逻辑，复跑完整测试通过（33.22 秒）。保留这一运行波动记录，不将其计为首次通过。
- 已查看 `test-results/subtitle-studio-ui/original-content-first-page.png`、`original-content-dark-en-1280.png`、`original-content-light-ja-786.png`：分别覆盖桌面长短/多行 SRT、深色 LRC、786 x 540 窄窗口 SRT；正文、分隔线和分页无重叠，字形未因密度调整缩小。
- Electron 测试使用临时隔离 profile，afterAll 关闭测试实例并删除临时数据。

本轮经验沿用现有密度检查：同时检查源文本自带空行与 CSS padding，避免只缩小字号，也避免通过修改原始内容隐藏视觉空白。
