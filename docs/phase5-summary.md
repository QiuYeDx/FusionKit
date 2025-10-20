# 阶段5总结 - 复杂功能页面迁移

> 快速参考文档 | 完整版见 `PHASE5-COMPLETE.md`

---

## 📝 迁移文件清单

### 1. ErrorDetailModal.tsx
**路径**: `src/components/ErrorDetailModal.tsx`

**关键变更**:
```tsx
// Button迁移
<button className="btn btn-ghost btn-sm"> → <Button variant="ghost" size="sm">

// 图标替换
import { XMarkIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
↓
import { X, Copy } from "lucide-react";

// 颜色类更新
bg-base-100 → bg-card
text-base-content → text-foreground
bg-error/10 text-error → bg-destructive/10 text-destructive
```

**保留**: 完整的 react-spring 动画效果

---

### 2. SubtitleTranslator.tsx
**路径**: `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`

**关键组件**:
- Card + CardHeader + CardTitle + CardContent
- RadioGroup + RadioGroupItem + Label
- Input（数字、文本、日期时间）
- Button（多种变体）
- Progress

**特殊功能**:
- 定时任务设置
- 防睡眠锁定
- Token消耗预估
- 文件拖拽上传
- 任务队列管理

---

### 3. SubtitleConverter.tsx
**路径**: `src/pages/Tools/Subtitle/SubtitleConverter/index.tsx`

**结构**: 类似 SubtitleTranslator，但更简洁

**特殊配置**:
- 转换方向选择（LRC↔SRT）
- 默认时长设置

---

### 4. SubtitleLanguageExtractor.tsx
**路径**: `src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx`

**结构**: 最简洁的字幕工具

**特殊配置**:
- 语言保留选择（中文/日语）

---

## 🎨 统一模式

### 折叠区块

```tsx
<Card>
  <div
    className="flex items-center justify-between p-4 cursor-pointer select-none"
    onClick={() => setIsOpen((v) => !v)}
  >
    <CardTitle>区块标题</CardTitle>
    <ChevronDown
      className={cn(
        "h-5 w-5 transition-transform",
        isOpen && "rotate-180"
      )}
    />
  </div>
  {isOpen && (
    <CardContent className="-mt-2 pt-0">
      {/* 内容 */}
    </CardContent>
  )}
</Card>
```

### RadioGroup

```tsx
<RadioGroup value={value} onValueChange={setValue}>
  <div className="flex items-center space-x-2">
    <RadioGroupItem value="option" id="option" />
    <Label htmlFor="option">选项</Label>
  </div>
</RadioGroup>
```

### 任务列表项

```tsx
<div className="bg-muted rounded-lg p-4">
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-4 flex-1">
      <div className={`w-3 h-3 rounded-full ${statusColor}`} />
      <div className="font-medium flex-1">
        {task.fileName}
        <div className="text-sm text-muted-foreground mt-1">
          {/* 状态信息 */}
        </div>
      </div>
    </div>
    <div className="flex items-center gap-4">
      {/* 操作按钮 */}
    </div>
  </div>
  {task.status === TaskStatus.PENDING && (
    <Progress value={task.progress} className="w-full mt-2" />
  )}
</div>
```

---

## 🔄 图标映射

| 功能 | @heroicons/react | lucide-react |
|-----|------------------|--------------|
| 重试 | ArrowPathIcon | RotateCw |
| 文件夹 | FolderIcon | Folder |
| 打开文件夹 | FolderOpenIcon | FolderOpen |
| 播放 | PlayCircleIcon | PlayCircle |
| 关闭 | XMarkIcon | X |
| 删除 | TrashIcon | Trash2 |
| 警告 | ExclamationTriangleIcon | AlertTriangle |
| CPU | CpuChipIcon | Cpu |
| 下拉 | ChevronDownIcon | ChevronDown |
| 复制 | ClipboardDocumentIcon | Copy |

---

## 🎯 颜色映射

| daisyUI | shadcn/ui |
|---------|-----------|
| bg-base-100 | bg-background / bg-card |
| bg-base-200 | bg-muted |
| bg-base-300 | bg-muted |
| text-base-content | text-foreground |
| text-gray-500 / text-gray-600 | text-muted-foreground |
| border-base-300 | border-border |
| text-error / bg-error | text-destructive / bg-destructive |
| btn-primary | (Button默认样式) |

---

## ✅ 快速检查清单

**迁移完成度**:
- [x] ErrorDetailModal.tsx
- [x] SubtitleTranslator.tsx
- [x] SubtitleConverter.tsx
- [x] SubtitleLanguageExtractor.tsx

**功能保留**:
- [x] 文件拖拽上传
- [x] 任务队列管理
- [x] 批量操作
- [x] 错误处理和重试
- [x] 定时任务（Translator）
- [x] 防睡眠锁定（Translator）
- [x] Token预估（Translator）
- [x] 动画效果（ErrorModal）

**样式更新**:
- [x] 所有颜色类语义化
- [x] 所有图标替换为 lucide-react
- [x] 所有表单组件使用 shadcn/ui
- [x] 统一的折叠区块样式

---

## 📊 统计数据

- **迁移文件数**: 4
- **代码行数**: 2340+
- **shadcn/ui 组件**: Button, Card, RadioGroup, Label, Input, Progress
- **lucide-react 图标**: 10+
- **完成度**: 100% ✅

---

## 🚀 下一步

进入 **阶段6：最终优化与清理**

主要任务：
1. 移除 daisyUI 依赖
2. 统一样式和主题
3. 测试暗色模式
4. 优化动画效果
5. 性能测试
6. 更新文档

**准备好？** 告诉我："开始阶段6"

