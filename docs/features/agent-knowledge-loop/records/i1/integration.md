# I1 集成结果：Agent 检索与维护翻译资料

2026-10-10，基线 45a88e0 + 未提交工作树。任务记录见同目录 T-*.md；截图在 `screenshots/`。

## 用户能做什么

- 在任意页面对 Agent 说“把这个译法记到《绝区零》的资料里”：Agent 查目录 → 从字幕取原文 → 给出「保存到翻译资料」卡片（新建作品/资料集 + 术语）→ 你确认后一次保存 → Agent 回报并提醒在工作台选用该资料集 → 卡片可直接打开该资料集。
- 卡片列出每项变更、已存在而跳过的条目、与其他资料集的译法冲突、强制条目提示；“保存后直接启用”按来源给出默认值，可切换。
- 修改或归档已有条目同样走卡片；准备后资料被别处改动时整体不保存并说明原因。
- 检索支持作品名/别名、多关键词、按作品/语言/状态筛选；资料页打开面板时 Agent 知道当前资料集与可见条目。

## 验证摘要

| 范围 | 结果 |
| --- | --- |
| 资料服务与 IPC | 49 项通过（含 5 项批量保存、1 项 IPC） |
| 资料模块回归（非 Electron） | 337 项通过 |
| 提案构造 | 10 项通过（含真实服务保存） |
| Agent 工具与准备动作 | 67 项通过（真实服务包装） |
| 卡片文字、对话流、提示词、页面说明 | 26 + 30 项通过 |
| 类型检查 / i18n 检查 | 0 错误 / 全部键可解析 |
| Electron 端到端（脚本模型复现背景对话） | 通过，8 张截图已审阅 |
| 全量 vitest | 5459 通过、81 跳过、0 失败 |

## 截图索引

| 文件 | 内容 |
| --- | --- |
| screenshots/01-card-ready-dock-1280-light.png | 工作台悬浮面板中的待确认卡片 |
| screenshots/02-card-saved-dock-1280-light.png | 保存回执、Agent 跟进回复 |
| screenshots/03-library-focused-1280-light.png | 从卡片打开资料页并选中资料集 |
| screenshots/04-sample-ready-home-1280-light.png | 首页 11 项样本卡片（冲突、强制、已存在） |
| screenshots/05-sample-expanded-home-1280-light.png | 展开全部条目 |
| screenshots/06-sample-ready-dock-786-dark.png | 786 窄窗口深色面板 |
| screenshots/07-edit-failed-dock-786-dark.png | 准备后被改动，整体不保存 |
| screenshots/08-sample-ready-home-1280-en.png | 英文界面 |

## 未覆盖与待用户验收

- 真实模型是否遵循指引（先查目录、取对原文、选对 basis）需用你的 Agent 模型试用。
- ja / zh-Hant 未截图审阅；“保存中”瞬时状态未截图。
- 用户验收未签署（spec.json acceptance 为 pending）。
