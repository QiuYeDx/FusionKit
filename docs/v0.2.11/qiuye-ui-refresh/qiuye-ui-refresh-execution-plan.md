# QiuYe UI 组件接入 Execution Plan

> 日期：2026-07-07
> Feature Slug：`qiuye-ui-refresh`
> 对应设计文档：`docs/v0.2.11/qiuye-ui-refresh/qiuye-ui-refresh-final-design.md`
> 当前状态：`QIUYE-UI-001` 已完成

---

## 1. 每次开发会话的使用方式

每次实现会话开始前，Agent 必须：

1. 阅读 final design。
2. 阅读本执行计划。
3. 检查第 4 节进度台账。
4. 检查 `git status --short`，保留用户已有改动。
5. 确认当前 pnpm 版本和 lockfile 格式，避免用 pnpm 11 改写 v6 lockfile。

每次实现会话结束前必须：

1. 运行相关验证，或记录无法运行的原因。
2. 更新第 4 节进度台账。
3. 在 `qiuye-ui-refresh_implementation_records/` 写入实施记录。
4. 回答用户前关闭本次启动的 Vite、Electron 或其他前端服务。

---

## 2. 状态规则

- `未开始`
- `进行中`
- `已完成`
- `阻塞`
- `废弃`

---

## 3. 推进原则

1. 优先使用 qiuye-ui registry 组件，不手写替代组件。
2. Smooth corners 只应用在真实 surface 上，不为了效果额外包卡片。
3. 主题切换保留原有圆形按钮识别，替换内部截图实现。
4. 清理旧截图链路时同步清理未使用依赖。
5. 文档、代码和验证结果保持一致。

---

## 4. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| QIUYE-UI-001 | 已完成 | 2026-07-07 | 接入 smooth-corners 与 theme-transition-toggle | `BottomNavigation.tsx`、`ToolPanel.tsx`、`ToolConfigPanel.tsx`、`ToolStatBar.tsx`、`ToolFileDropZone.tsx`、`Tools/index.tsx`、qiuye-ui 组件、依赖与文档 | `node_modules/.bin/tsc --noEmit`；`node_modules/.bin/vite build`；`git diff --check` | `docs/v0.2.11/qiuye-ui-refresh/qiuye-ui-refresh_implementation_records/2026-07-07_QIUYE-UI-001_qiuye-ui-components.md` | 建议人工在 Electron 中体验主题切换动画和几个工具页 surface 细节 |

---

## 5. 工作包详情

### QIUYE-UI-001：接入 qiuye-ui 组件

实施范围：

- 补齐 `ThemeTransitionToggle` registry 组件。
- 底部导航主题按钮切到 `ThemeTransitionToggle`。
- 删除 `FadeMaskLayer`、`useFadeMaskLayerStore` 和旧截图依赖。
- 在工具页共享 surface 和工具总览卡片接入 `SmoothCorners`。
- 修复 qiuye-ui 组件在当前 Vite/TypeScript 配置下的类型兼容问题。

验收口径：

- 主题按钮仍是圆形按钮，点击后能切换明暗主题。
- 旧截图实现无引用残留。
- 工具页主要卡片和拖拽区启用 smooth-corners fallback/enhancement。
- 类型检查和生产构建通过。

---

## 6. 实施记录模板

```markdown
# 工作包 <ID>：<标题>

## 基本信息

- 日期：
- 状态：
- 对应执行计划工作包：

## 本次实现内容

-

## 修改文件

-

## 验证结果

执行命令：

```text

```

结果：

-

## 未完成事项

-

## 下一步建议

-
```
