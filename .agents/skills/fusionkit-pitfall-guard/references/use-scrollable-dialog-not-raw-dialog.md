# FK-PIT-0003: 使用 ScrollableDialog 而非原生 shadcn/ui Dialog

## Area

Frontend

## Triggers

dialog, Dialog, DialogContent, DialogHeader, DialogFooter, 对话框, 弹窗, modal, scrollable-dialog, qiuye-ui

## Symptoms

- 新增或修改的 Dialog 从 `@/components/ui/dialog` 直接导入 `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle` 等组件
- Dialog 内容区域使用手写的 `max-h-[…] overflow-y-auto` 实现滚动，缺少上下渐变遮罩
- 长内容 Dialog 的 Header/Footer 随内容一起滚动，而非固定在顶/底部

## Root cause

项目已封装了 `ScrollableDialog` 组件（位于 `@/components/qiuye-ui/scrollable-dialog`），提供了统一的：
- Header/Footer 固定（不随内容滚动）
- 内容区 ScrollArea 自动滚动
- 上下渐变遮罩（fade masks）提示可滚动
- 统一的 padding/border 样式

但开发时容易习惯性地直接使用 shadcn/ui 原生 Dialog，导致各处 Dialog 体验不一致。

## Do

- 所有包含可滚动内容的 Dialog **必须** 使用 `ScrollableDialog` 系列组件：

```tsx
import {
  ScrollableDialog,
  ScrollableDialogHeader,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/qiuye-ui/scrollable-dialog";

<ScrollableDialog open={open} onOpenChange={onOpenChange} maxWidth="sm:max-w-3xl">
  <ScrollableDialogHeader>
    <DialogTitle>标题</DialogTitle>
  </ScrollableDialogHeader>
  <ScrollableDialogContent fadeMasks>
    {/* 可滚动内容 */}
  </ScrollableDialogContent>
  <ScrollableDialogFooter>
    {/* 底部操作按钮 */}
  </ScrollableDialogFooter>
</ScrollableDialog>
```

- 对于极简确认弹窗（如 `ConfirmDialog`），内容固定且不会超出视口的场景，可以继续使用原生 `Dialog`，但需确认确实不需要滚动。
- 通过 `maxWidth` prop 控制对话框宽度（默认 `sm:max-w-md`），不要在 `DialogContent` 上手写宽度类名。

## Avoid

- **禁止** 在包含列表/表格/长文本等可能需要滚动的 Dialog 中直接使用 `@/components/ui/dialog`
- **禁止** 在 Dialog 内部手写 `max-h-[…] overflow-y-auto` 来实现滚动（这正是 `ScrollableDialogContent` 要解决的）
- **禁止** 手动拼装 `ScrollArea` + `DialogHeader` + `DialogFooter` 的固定布局，应使用封装好的组件

## Validation

- 搜索新增/修改文件中是否有 `from "@/components/ui/dialog"` 导入，如有需确认是否属于极简确认弹窗场景
- 打开 Dialog，确认内容超出时 Header/Footer 固定不动，仅中间区域滚动
- 确认滚动区域顶部和底部有渐变遮罩效果

```bash
# 检查是否有文件直接使用原生 dialog（排除 qiuye-ui 自身和 ConfirmDialog）
rg 'from "@/components/ui/dialog"' src/ --glob '!**/qiuye-ui/**' --glob '!**/ConfirmDialog*'
```

## Related files

- `src/components/qiuye-ui/scrollable-dialog.tsx` — ScrollableDialog 组件实现
- `src/components/ui/dialog.tsx` — shadcn/ui 原生 Dialog（仅供 qiuye-ui 内部引用或极简确认弹窗使用）
- `src/components/ConfirmDialog.tsx` — 极简确认弹窗（合理使用原生 Dialog 的例外场景）
- `src/pages/Tools/Text/TextTranslator/index.tsx` — 本次修复的 RecoveryDialog
- `src/pages/Tools/Subtitle/SubtitleTranslator/components/RecoveryDialog.tsx` — 同样需要关注的组件
