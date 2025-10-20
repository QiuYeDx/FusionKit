# Shadcn/ui 快速参考

## 📌 常用组件导入

```tsx
// 按钮
import { Button } from "@/components/ui/button"

// 卡片
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"

// 表单
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

// 对话框
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

// 其他
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
```

---

## 🎨 类名映射表

### 背景色

| 用途 | DaisyUI | Shadcn/ui |
|------|---------|-----------|
| 主背景 | `bg-base-100` | `bg-background` |
| 卡片背景 | `bg-base-200` | `bg-card` |
| 次级背景 | `bg-base-300` | `bg-muted` |
| 强调背景 | `bg-primary` | `bg-primary` |
| 辅助背景 | `bg-secondary` | `bg-secondary` |

### 文字颜色

| 用途 | DaisyUI | Shadcn/ui |
|------|---------|-----------|
| 主文字 | `text-base-content` | `text-foreground` |
| 卡片文字 | `text-base-content` | `text-card-foreground` |
| 次级文字 | `text-gray-600 dark:text-gray-300` | `text-muted-foreground` |
| 主色文字 | `text-primary` | `text-primary` |

### 边框

| 用途 | DaisyUI | Shadcn/ui |
|------|---------|-----------|
| 边框颜色 | `border-base-300` | `border-border` |
| 输入框边框 | `border-base-300` | `border-input` |
| 聚焦边框 | `focus:ring-primary` | `focus-visible:ring-ring` |

---

## 🔧 常用模式

### 1. Button 按钮

```tsx
import { Button } from "@/components/ui/button"

// 基础按钮
<Button>点击我</Button>

// 不同样式
<Button variant="default">默认</Button>
<Button variant="secondary">次要</Button>
<Button variant="destructive">危险</Button>
<Button variant="outline">轮廓</Button>
<Button variant="ghost">幽灵</Button>
<Button variant="link">链接</Button>

// 不同大小
<Button size="sm">小</Button>
<Button size="default">默认</Button>
<Button size="lg">大</Button>
<Button size="icon">🎨</Button>

// 禁用状态
<Button disabled>禁用</Button>
```

### 2. Card 卡片

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"

<Card>
  <CardHeader>
    <CardTitle>卡片标题</CardTitle>
    <CardDescription>卡片描述</CardDescription>
  </CardHeader>
  <CardContent>
    <p>卡片内容</p>
  </CardContent>
  <CardFooter>
    <Button>操作</Button>
  </CardFooter>
</Card>
```

### 3. Input 输入框

```tsx
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

<div className="space-y-2">
  <Label htmlFor="email">邮箱</Label>
  <Input 
    id="email" 
    type="email" 
    placeholder="输入邮箱..."
  />
</div>
```

### 4. Select 下拉选择

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

<Select value={value} onValueChange={setValue}>
  <SelectTrigger>
    <SelectValue placeholder="选择选项" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="option1">选项1</SelectItem>
    <SelectItem value="option2">选项2</SelectItem>
    <SelectItem value="option3">选项3</SelectItem>
  </SelectContent>
</Select>
```

### 5. RadioGroup 单选组

```tsx
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"

<RadioGroup value={value} onValueChange={setValue}>
  <div className="flex items-center space-x-2">
    <RadioGroupItem value="option1" id="option1" />
    <Label htmlFor="option1">选项1</Label>
  </div>
  <div className="flex items-center space-x-2">
    <RadioGroupItem value="option2" id="option2" />
    <Label htmlFor="option2">选项2</Label>
  </div>
</RadioGroup>
```

### 6. Dialog 对话框

```tsx
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

<Dialog>
  <DialogTrigger asChild>
    <Button>打开对话框</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>对话框标题</DialogTitle>
      <DialogDescription>
        对话框描述文字
      </DialogDescription>
    </DialogHeader>
    <div>对话框内容</div>
  </DialogContent>
</Dialog>
```

### 7. Tabs 标签页

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

<Tabs defaultValue="tab1">
  <TabsList>
    <TabsTrigger value="tab1">标签1</TabsTrigger>
    <TabsTrigger value="tab2">标签2</TabsTrigger>
  </TabsList>
  <TabsContent value="tab1">
    <p>标签1内容</p>
  </TabsContent>
  <TabsContent value="tab2">
    <p>标签2内容</p>
  </TabsContent>
</Tabs>
```

### 8. Badge 徽章

```tsx
import { Badge } from "@/components/ui/badge"

<Badge>默认</Badge>
<Badge variant="secondary">次要</Badge>
<Badge variant="destructive">危险</Badge>
<Badge variant="outline">轮廓</Badge>
```

### 9. Progress 进度条

```tsx
import { Progress } from "@/components/ui/progress"

<Progress value={60} />
```

### 10. Tooltip 工具提示

```tsx
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"

<TooltipProvider>
  <Tooltip>
    <TooltipTrigger asChild>
      <Button>悬停查看</Button>
    </TooltipTrigger>
    <TooltipContent>
      <p>提示内容</p>
    </TooltipContent>
  </Tooltip>
</TooltipProvider>
```

---

## 🎨 组合类名

使用 `cn()` 函数组合类名：

```tsx
import { cn } from "@/lib/utils"

// 基础用法
<div className={cn("base-class", "another-class")} />

// 条件类名
<div className={cn(
  "base-class",
  isActive && "active-class",
  isDisabled && "disabled-class"
)} />

// 接受外部类名
interface Props {
  className?: string
}

function MyComponent({ className }: Props) {
  return (
    <div className={cn("default-classes", className)} />
  )
}
```

---

## 🌓 主题切换

### 使用 Store

```tsx
import useThemeStore from "@/store/useThemeStore"

function ThemeToggle() {
  const { theme, setTheme, isDark } = useThemeStore()
  
  return (
    <Button onClick={() => setTheme(isDark ? "light" : "dark")}>
      {isDark ? "🌙" : "☀️"}
    </Button>
  )
}
```

### 使用 ThemeProvider

```tsx
import { useTheme } from "@/components/theme-provider"

function ThemeToggle() {
  const { theme, setTheme, isDark } = useTheme()
  
  return (
    <Button onClick={() => setTheme(isDark ? "light" : "dark")}>
      {isDark ? "🌙" : "☀️"}
    </Button>
  )
}
```

---

## 📐 布局模式

### 卡片网格

```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  <Card>...</Card>
  <Card>...</Card>
  <Card>...</Card>
</div>
```

### 垂直堆叠

```tsx
<div className="space-y-4">
  <Card>...</Card>
  <Card>...</Card>
  <Card>...</Card>
</div>
```

### 水平排列

```tsx
<div className="flex gap-2 flex-wrap">
  <Badge>标签1</Badge>
  <Badge>标签2</Badge>
  <Badge>标签3</Badge>
</div>
```

---

## 🎯 最佳实践

### 1. 使用语义化颜色

```tsx
// ✅ 好
<div className="bg-background text-foreground">
<p className="text-muted-foreground">

// ❌ 差
<div className="bg-white dark:bg-gray-900">
<p className="text-gray-600 dark:text-gray-300">
```

### 2. 组件组合

```tsx
// ✅ 好 - 使用组合
<Card>
  <CardHeader>
    <CardTitle>标题</CardTitle>
  </CardHeader>
  <CardContent>内容</CardContent>
</Card>

// ❌ 差 - 自定义样式
<div className="rounded-lg border bg-card p-4">
  <h3 className="font-semibold">标题</h3>
  <div>内容</div>
</div>
```

### 3. 类型安全

```tsx
import { ButtonProps } from "@/components/ui/button"

interface MyButtonProps extends ButtonProps {
  customProp?: string
}

function MyButton({ customProp, ...props }: MyButtonProps) {
  return <Button {...props} />
}
```

---

## 🔍 调试技巧

### 检查主题

```javascript
// 在浏览器控制台
console.log(document.documentElement.classList.contains('dark'))
```

### 检查 CSS 变量

```javascript
// 在浏览器控制台
const root = document.documentElement
console.log(getComputedStyle(root).getPropertyValue('--background'))
```

### 检查组件渲染

使用 React DevTools 查看组件树和 props

---

## 📚 更多资源

- [Shadcn/ui 官方文档](https://ui.shadcn.com)
- [Radix UI 文档](https://www.radix-ui.com)
- [Tailwind CSS 文档](https://tailwindcss.com)
- [完整迁移指南](./shadcn-migration-guide.md)

