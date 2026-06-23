# 拖拽文件路径到 Agent 输入框

> **实现日期**: 2026-05-27  
> **关联 TODO**: T-04  
> **涉及文件**: `src/pages/HomeAgent/index.tsx`, `src/locales/*/home.json`

---

## 功能概述

支持用户从系统文件管理器拖拽文件或文件夹到 HomeAgent 输入框，拖入后自动将文件的绝对路径以 backtick 包裹的形式追加到当前输入内容中。

## 交互设计

| 操作 | 表现 |
|------|------|
| 拖拽文件进入输入框区域 | 输入框出现 `ring-2 ring-primary/40` 高亮 + 背景变为 `bg-primary/5`，显示「松开以添加文件路径」提示 |
| 拖拽离开区域 | 恢复默认样式 |
| 松开（Drop） | 文件路径以 `` `path` `` 格式追加到输入框末尾，多文件用空格分隔；输入框自动聚焦 |
| 拖入非文件内容 | 不响应 |

## 技术实现

### Electron 文件路径获取

Electron 环境下，从操作系统拖入的 `File` 对象具有 `path` 属性（标准 Web API 不具备），可直接获取文件/文件夹的绝对路径：

```typescript
const paths = files
  .map((f) => (f as File & { path?: string }).path)
  .filter((p): p is string => !!p);
```

### 拖拽计数器防抖

使用 `dragCounterRef` 解决子元素触发 `dragenter`/`dragleave` 导致状态抖动的经典问题：

```typescript
const dragCounterRef = useRef(0);

const handleDragEnter = (e: React.DragEvent) => {
  dragCounterRef.current += 1;
  if (e.dataTransfer.types.includes("Files")) {
    setIsDragOver(true);
  }
};

const handleDragLeave = (e: React.DragEvent) => {
  dragCounterRef.current -= 1;
  if (dragCounterRef.current === 0) {
    setIsDragOver(false);
  }
};
```

### 路径拼接逻辑

路径用 backtick 包裹，便于 Agent 在后续处理中识别为文件路径引用：

```typescript
const pathText = paths.map((p) => `\`${p}\``).join(" ");
setInput((prev) => {
  const trimmed = prev.trimEnd();
  return trimmed ? `${trimmed} ${pathText}` : pathText;
});
```

### 视觉反馈

拖拽覆盖时通过 `AnimatePresence` + `motion.div` 显示半透明提示层，使用 Tailwind `ring-inset` 实现内发光边框效果，不破坏原有的四角圆角边框视觉结构。

## i18n

| Key | zh | en | ja |
|-----|----|----|-----|
| `drop_files_hint` | 松开以添加文件路径 | Drop to add file paths | ドロップしてファイルパスを追加 |
