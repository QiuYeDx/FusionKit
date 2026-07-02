# 文件名翻译工具体验修复 Final Design

> 日期：2026-07-02
> Feature Slug：`name-translator-ux`
> 版本：`v0.2.11`
> 状态：已用于 `NT-UX-001` 实施

## 背景

v0.2.11 首批迭代先处理文件名翻译工具中的体验问题：路径选择按钮在 Windows 11 上误导用户、清空当前选择会重置配置、预览表格 tooltip 与列布局不顺手、左侧路径列表过长时缺少内部滚动和边缘提示。

Electron 官方文档说明 Windows/Linux 的打开弹窗不能同时作为文件选择器和目录选择器；如果同时设置 `openFile` 与 `openDirectory`，会退化为目录选择器。因此跨平台 UI 不应继续把同一个按钮称为“文件/文件夹”。

## 目标

- 将路径选择入口改为明确的“文件”和“文件夹”两类按钮。
- 清空当前选择时保留用户已经设置的翻译选项，只清空路径、预览和执行状态。
- 改善预览表格连续查看体验：长文本 tooltip 默认从左侧弹出，新名称列更宽，操作列固定在右侧。
- 左侧已选路径列表设置最大高度、内部滚动，并用上下渐变遮罩提示可滚动区域。

## 非目标

- 不改底层重命名扫描、翻译、冲突校验和 apply/rollback 流程。
- 不实现用户拖拽调节表格列宽；本次先通过列宽和 sticky 操作列降低操作成本。
- 不改变 HomeAgent 计划加载协议。

## 当前实现约束

- 路径选择由 `src/pages/Tools/Rename/NameTranslator/components/PathPickerPanel.tsx` 调用 `select-rename-paths`。
- Electron 主进程通过 `electron/main/rename/dialog-options.ts` 对 Windows/Linux 混选做降级，目前混选参数会退化为文件选择器。
- 页面状态由 `src/store/tools/rename/useNameTranslatorStore.ts` 管理，现有 `reset()` 用于全量恢复默认状态和测试隔离。
- 预览表格使用 `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`，横向滚动由 shadcn/Radix `ScrollArea` 承载。

## 最终交互设计

### 路径选择

- 文件按钮只传 `allowFiles: true`、`allowDirectories: false`。
- 文件夹按钮只传 `allowFiles: false`、`allowDirectories: true`。
- 拖拽入口仍允许把文件和文件夹一起拖入。
- 文案说明“可分别选择或拖拽添加，生成预览前不修改文件系统”。

### 清空选择

- 新增 store action `clearSelection()`。
- `clearSelection()` 清空：
  - `selectedPaths`
  - `currentPlan`
  - `planningProgress`
  - `applyProgress`
  - `lastApplyResult`
  - `lastRollbackResult`
  - `lastValidation`
  - `lastError`
  - `originalSuggestions`
- `clearSelection()` 保留：
  - 输出模式
  - 双语分隔符
  - 语言、命名风格、冲突策略、跳过隐藏项、扩展名/token 保留等用户配置
- `options.roots` 更新为空数组。
- `reset()` 继续作为全量恢复默认状态的内部/测试入口。

### 预览表格

- 原名称、新名称、路径 tooltip 的默认弹出方向改为 `left`，减少上下连续扫行时的遮挡。
- 新名称列最小宽度加宽，输入框宽度同步扩大。
- 操作列使用 `sticky right-0`，在横向滚动时保持可见。
- 操作列背景使用当前卡片背景，避免 sticky 区域透出表格内容。

### 左侧路径列表

- 已选路径列表最大高度约束在侧栏可见范围内。
- 列表内部使用 `ScrollArea` 滚动，不拉长整个左侧配置栏。
- 滚动区域顶部/底部按滚动位置显示渐变遮罩。
- 渐变遮罩必须 `pointer-events-none` 和 `aria-hidden="true"`，不遮挡移除按钮。

## 验证策略

- 单测覆盖 `clearSelection()` 保留配置。
- `dialog-options` 单测继续覆盖 Windows/Linux/macOS 的原生选择器限制。
- 运行 i18n 检查、相关 rename store 单测、TypeScript 编译和 diff 检查。
- 如启动前端/Electron 进行视觉验证，结束前必须关闭进程并确认无遗留。
