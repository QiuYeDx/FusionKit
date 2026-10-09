# 实施记录：T-WORKSPACE-05

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-05 |
| 日期 | 2026-10-09 |
| 验证版本 | df64e8f + 本会话未提交改动 |
| 环境 | Windows 11，Electron 41.10.6（vite build --mode=test），隔离 profile |
| 任务指纹 | a7c8a60af9e0ac124e714f758ad39c41dbdf28664254d3175212ba90c66feb24 |

## 实际结果

- 首页共享对话部件移入 `src/pages/HomeAgent/conversation.tsx`（模式选项、widget registry 与 fence、工具结果格式化、`CapsuleModeSelector`、`StreamingAssistant`、`MessageBubble`、`useAgentWidgetContexts`），首页只改为引用，行为不变；i18n 清单的模式选项选择器随之迁移。
- `src/pages/AgentDock/`：`App.tsx` 全局挂载并写入当前路由；首页 `/` 不显示。入口与主题切换完全对称（36px、`left/bottom 11px`，沿用其按钮类）；面板非模态，左缘对齐、底边在入口上方 11px、不压底部导航，宽 `min(400px, 100vw−22px)`、高 `min(620px, 100dvh−106px)`。
- 动效：面板常驻挂载，从入口位置的 36px 圆以 `clip-path` 生长并上移（弹簧 0.42s 无回弹），内容延迟淡入；收起反向，结束后 `visibility: hidden`、去掉 `role="dialog"`，不再拦截页面 Escape 返回。阴影放在外层 `drop-shadow`，避免被裁剪。减少动态效果时只淡入淡出。图标 Sparkles/ChevronDown 交叉切换。
- 面板：标题区（Agent 名、当前页面 · 文档名、在首页打开、新对话二次确认、收起），消息区自带滚动与“回到最新”，空会话显示页面说明与页面建议；输入区与首页胶囊同组件（模式、发送/停止、未配置模型提示）。Esc/关闭收起并把焦点还给入口，打开时聚焦输入。收起时生成中显示环形进度，有新回复显示圆点与播报。
- 页面工具的结果卡与调用标题、错误文案接入首页共用视图（`AgentToolResult`、`AgentToolCall`、`action-error`），不再以原始 JSON 显示。

审查与修复（状态 → 现象 → 原因 → 改动 → 复验）：
1. 786×660 深色、长对话 → 点击标题区按钮被消息区的代码块拦截 → 标题区与消息区同层，滚动内容可能盖住按钮 → 标题区与输入区加独立层与背景 → 复验点击与截图 06 通过。
2. 同一状态 → 工作台工具结果以整段 JSON 代码块显示 → 页面工具不在现代工具结果视图名单 → 加入页面工具摘要（已打开修订预览、需确认扫描、已读取 N 条）、调用名称与错误文案 → 截图 03、06、07 复验。
3. 1280×860 → 面板展开时覆盖页面左侧约 400px（含预览前几列）→ 设计即为非模态浮层 → 保留，用户可收起；测试改为点击未被覆盖的列以确认页面仍可操作。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-05-1 | 通过 | inline:`vitest run src/pages/HomeAgent src/pages/AgentDock src/agent src/store/agent` 全部通过（含 dock-state 3 项；首页既有用例无回归） |
| V-WORKSPACE-05-2 | 通过 | inline:tsc 0；check-i18n、check-i18n-usage 通过（新增 `home:dock.*`、页面工具文案与动态键清单） |
| V-WORKSPACE-05-3 | 通过 | file:records/i3/T-WORKSPACE-06.md |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-03-1 | 通过 | V-WORKSPACE-05-1, V-WORKSPACE-05-3 |
| AC-WORKSPACE-03-2 | 通过 | V-WORKSPACE-05-3 |
| AC-WORKSPACE-03-3 | 通过 | V-WORKSPACE-05-3 |
| AC-WORKSPACE-03-4 | 通过 | V-WORKSPACE-05-3 |

## 风险与未执行项

关闭按钮把焦点还给入口时，Radix Tooltip 会随焦点显示一次入口提示（截图 04），属焦点行为的正常反馈。macOS 未验证。
