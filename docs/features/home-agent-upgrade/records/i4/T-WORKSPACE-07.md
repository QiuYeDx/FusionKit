# 实施记录：T-WORKSPACE-07

| 字段 | 值 |
| --- | --- |
| 任务 | T-WORKSPACE-07 |
| 日期 | 2026-10-09 |
| 验证版本 | df64e8f + 本会话未提交改动（最终代码重新 `vite build --mode=test` 后运行） |
| 环境 | Windows 11，Electron 41.10.6，隔离 profile；浏览器部分见 T-WORKSPACE-08 |
| 任务指纹 | 50e9d1c953a5c6aff4aa7243f8d723e48b7689cb430a0e6bba8586fccfa84879 |

## 实际结果

按 motion-recipes Case 7 策略 B（数值几何飞行），不使用共享 `layoutId`：

- `src/pages/AgentDock/handoff.ts`：面板静止矩形 `dockPanelRect`、首页对话列预测 `predictHomeColumn`、首页登记 `registerHomeColumn` / `readHomeColumn`，以及返回目标 `homeColumnTarget`（优先用同尺寸的最后测量）。
- `HomeAgent/index.tsx`：会话非空或正在回复时，登记消息列的位置与布局高度（不受输入区变换影响）。
- `AgentDock/index.tsx`：
  - 拆为常驻的 `AgentDock`（路由、导航器、离开首页时在同一次渲染读取列矩形）和由 `AnimatePresence` 管理的 `DockSurface`，每次交接用新 key。
  - 外框 `motion.div` 从首页列矩形以弹簧（0.52s、无回弹）移动/缩放到静止矩形；返回时反向飞到首页列。
  - 过渡期间 `inert`，落位后聚焦输入框；回复结束后若面板打开，重新聚焦。
- 淡出淡入衔接（本次审查后的最终时序）：
  - 离开：外框底色 0.12s 盖住首页对话列，内容在 0.1s 后用 0.16s 淡入。
  - 返回：内容在飞行前段可见，0.14s 起淡出；外框 0.24s 起用 0.22s 淡出。
- `App.tsx`：有会话时，首页与其他页之间的路由过渡只淡入淡出、不做水平位移。
- 减少动态效果时两向都只淡入淡出。

## 审查发现与修复

| 现象（截图） | 原因 | 修复 |
| --- | --- | --- |
| 飞行中外框是空白卡片（早期 05b/05c） | 内容延迟到 0.28s 才淡入 | 内容随外框一同出现 |
| 返回末段两份对话错位叠影（早期 03c） | 外框半透明时面板内容仍可见，与下方首页对话位置相差约 10–20px | 内容先于外框淡出 |
| 离开首帧两份对话叠影（早期 05a） | 外框底色与内容一起从 0 淡入，首页对话透出 | 底色先盖住，内容随后淡入 |
| 窄窗返回末段空白外框停留较久（早期 07c） | 内容淡出与外框淡出间隔过大 | 外框淡出提前到 0.24s，空底约 0.1s |

需求变更：AC-WORKSPACE-04-1 的“面板内容在外框接近落位时淡入”改为“外框先以不透明底色盖住首页对话列，面板内容随后在移动的外框中淡入”。AC-04-3 相应写明内容在外框溶解前淡出。

- 原因：按原措辞实现会出现空白卡片或叠影，与同条 AC“无两份对话重叠可读”冲突。
- 影响：目的不变、约束更严格，未扩大范围。
- 已登记在 spec.json 批准依据中，并刷新了范围摘要。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-WORKSPACE-07-1 | 通过 | inline:`vitest run src/pages/AgentDock` handoff 3 项（静止矩形、首页列预测、实时读取并记住用于返回）、dock-state 3 项通过；`vitest run src/pages src/store/agent` 28 文件 154 项通过 |
| V-WORKSPACE-07-2 | 通过 | inline:`tsc --noEmit` 0 错误 |
| V-WORKSPACE-07-3 | 通过 | file:records/i4/T-WORKSPACE-08.md |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-WORKSPACE-04-1 | 通过 | V-WORKSPACE-07-1, V-WORKSPACE-07-3 |
| AC-WORKSPACE-04-2 | 通过 | V-WORKSPACE-07-3 |
| AC-WORKSPACE-04-3 | 通过 | V-WORKSPACE-07-3 |
| AC-WORKSPACE-04-4 | 通过 | V-WORKSPACE-07-3 |

## 风险与未执行项

截图时刻由 Playwright 截图耗时决定，不是固定帧；连续性主要依据逐帧几何取样。macOS 与 120Hz 屏未验证。
