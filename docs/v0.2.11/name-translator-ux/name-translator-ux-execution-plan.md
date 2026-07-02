# 文件名翻译工具体验修复 Execution Plan

> 日期：2026-07-02
> Feature Slug：`name-translator-ux`
> 对应设计文档：`docs/v0.2.11/name-translator-ux/name-translator-ux-final-design.md`
> 当前状态：`NT-UX-001` 已完成

---

## 1. 每次开发会话的使用方式

每次实现会话开始前，Agent 必须：

1. 阅读 final design。
2. 阅读本执行计划。
3. 检查第 4 节进度台账。
4. 检查 `git status --short`，保留用户已有改动。
5. 认领一个最小可闭环工作包。

每次实现会话结束前必须：

1. 运行相关验证，或记录无法运行的原因。
2. 更新第 4 节进度台账。
3. 在 `name-translator-ux_implementation_records/` 写入实施记录。
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

1. 先修可验证体验问题，再考虑更复杂的列宽拖拽。
2. 不改变 rename 核心业务流程。
3. i18n 文案和 UI 行为同步更新。
4. 表格 sticky 与滚动遮罩不得遮挡实际操作控件。

---

## 4. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NT-UX-001 | 已完成 | 2026-07-02 | 路径选择、清空配置保留、预览表格与路径列表体验修复 | `PathPickerPanel.tsx`、`PlanPreviewTable.tsx`、`NameTranslator/index.tsx`、`useNameTranslatorStore.ts`、rename i18n、测试 | `node_modules/.bin/vitest run test/rename/dialog-options.test.ts src/store/tools/rename/useNameTranslatorStore.test.ts`；`node scripts/check-i18n.mjs`；`node_modules/.bin/tsc --noEmit`；`node_modules/.bin/vite build`；`git diff --check` | `docs/v0.2.11/name-translator-ux/name-translator-ux_implementation_records/2026-07-02_NT-UX-001_name-translator-ux-fixes.md` | Windows 真实弹窗和视觉细节需后续人工复验；本机 Electron/Playwright 与 Chromium 二进制验证未能启动 |

---

## 5. 工作包详情

### NT-UX-001：文件名翻译体验修复

实施范围：

- 路径选择按钮改为“文件”和“文件夹”两类明确入口。
- 新增 `clearSelection()`，页面清空选择时保留配置。
- 预览表格 tooltip 改左侧，新名称列加宽，操作列 sticky 到右侧。
- 左侧已选路径列表改为内部滚动，并添加上下边缘渐变遮罩。
- 更新 zh / zh-Hant / en / ja 文案。
- 更新 store 单测。

验收口径：

- 清空选择后输出模式等用户配置不回到默认值。
- Windows/Linux 上不再展示误导性的“文件/文件夹”按钮。
- 横向滚动预览表时操作列始终可见。
- 左侧路径很多时列表内部滚动，页面左栏不被无限撑高。
- i18n、单测、类型检查通过。

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
