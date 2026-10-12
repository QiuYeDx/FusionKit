# 实施记录：T-SESSION-05

| 字段 | 值 |
| --- | --- |
| 任务 | T-SESSION-05 |
| 日期 | 2026-10-12 |
| 验证版本 | 5cf4dba + 本会话未提交改动（I1 最终工作树，含 2026-10-12 渲染审查修复与 provenance 审核登记） |
| 环境 | Windows 11，Node，Vitest，Electron 静默测试窗口，本地模拟 Responses 接口；未调用付费 API |
| 任务指纹 | c2fb31b2f8e059da08fbbe6d31a9b33f91112180ead31dc03e1950fbe7e3d478 |

## 实际结果

- `SessionSidebar.tsx`：窗口 ≥ 1216 px 常驻（可收起，偏好存 localStorage），更窄时左上角按钮打开浮层（Esc/外部点击/选中关闭，焦点回到按钮；宽度 < 900 px 时止于底部导航上方）；其他会话运行中/未读时展开按钮带圆点；保存失败提示可重试。
- `SessionList.tsx`：分组、行尾固定槽（运行中/未读/读取中，悬停或聚焦换成菜单）、仅截断时显示的 Tooltip、行内重命名（Enter/失焦提交、Esc 取消）、置顶、导出、删除确认（复用 ConfirmDialog）、上下方向键移动、无法读取的行只能删除。
- 主页：草稿按会话保存并在切换时换入；「新对话」不再二次确认；导入不再等待当前回复；切换后滚到底部。四种语言文案。
- 渲染审查发现并修复 6 项，见 records/screenshots/README.md。
- 2026-10-12 用户反馈后的第二轮：展开/收起改为单个容器的变形过渡，两个按钮为同一组元素，随容器右上角移动（达到共享元素过渡的效果），图标交叉淡化；点击后或 Esc 把焦点移回按钮时不再自动弹出 Tooltip。新增帧采样端到端测试（`grows the list out of its two buttons…`），见 records/screenshots/README.md 第 7、8 项。
- 第三轮（用户反馈）：常驻侧栏展开时，主页对话内容右移居中于侧栏右侧空间，并与侧栏同步动画；窄屏浮层不移动内容。见第 9 项。
- 用户确认后，常驻阈值由 1216px 降到 1000px（672px 对话栏在侧栏右侧两边各留 32px）；端到端测试在页面宽度恰为 1000px 时断言常驻且两侧留白相等（`07b-docked-1000-dark.png`），窄屏用例改为 960px。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-SESSION-05-1 | 通过 | file:records/screenshots/README.md |
| V-SESSION-05-2 | 通过 | file:records/e2e.log |
| V-SESSION-05-3 | 通过 | file:records/static.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-SESSION-07-1 | 通过 | V-SESSION-05-2 |
| AC-SESSION-07-2 | 通过 | V-SESSION-05-2 |
| AC-SESSION-07-4 | 通过 | V-SESSION-05-1 |
| AC-SESSION-07-5 | 通过 | V-SESSION-05-2 |
| AC-SESSION-05-1 | 通过 | V-SESSION-05-2 |
| AC-SESSION-05-2 | 通过 | V-SESSION-05-2 |
| AC-SESSION-05-3 | 通过 | V-SESSION-05-2 |
| AC-SESSION-05-4 | 通过 | V-SESSION-05-2 |
| AC-SESSION-05-5 | 通过 | V-SESSION-05-2 |
| AC-SESSION-05-7 | 通过 | V-SESSION-05-2 |
| AC-SESSION-01-1 | 通过 | V-SESSION-05-2 |
| AC-SESSION-01-3 | 通过 | V-SESSION-05-2 |
| AC-SESSION-02-4 | 通过 | V-SESSION-05-2 |

## 风险与未执行项

导入与「从行菜单导出」在端到端测试中未弹出真实系统对话框（导入/导出流程由 session-io 单测覆盖，导出入口在菜单截图中可见）。屏幕阅读器未实测，只验证了可读名称与键盘操作。
