# Shadcn/ui 迁移指南

## 📊 迁移进度总览

- ✅ **阶段1：环境准备与基础配置** (已完成)
- ⏳ **阶段2：基础UI组件迁移** (待进行)
- ⏳ **阶段3：导航组件迁移** (待进行)
- ⏳ **阶段4：设置页面组件迁移** (待进行)
- ⏳ **阶段5：复杂功能页面迁移** (待进行)
- ⏳ **阶段6：最终优化与清理** (待进行)

---

## ✅ 阶段1：环境准备与基础配置 (已完成)

### 完成的工作

#### 1. 依赖安装
```bash
# 核心依赖
pnpm add class-variance-authority clsx tailwind-merge lucide-react

# 开发依赖
pnpm add -D tailwindcss-animate
```

#### 2. 配置文件更新

**tailwind.config.js**
- ✅ 移除 daisyUI 配置
- ✅ 改用 `darkMode: ['class']`
- ✅ 添加 shadcn/ui 颜色系统
- ✅ 添加 tailwindcss-animate 插件

**src/index.css**
- ✅ 添加 shadcn/ui CSS 变量
- ✅ 配置浅色和深色模式

**components.json**
- ✅ 创建 shadcn/ui 配置文件

**src/lib/utils.ts**
- ✅ 创建 cn() 工具函数

**src/utils/common.ts**
- ✅ 更新主题切换逻辑（data-theme → class）

#### 3. 安装的组件

已安装 17 个 shadcn/ui 组件：
- Button, Badge, Card, Label, Separator
- Input, Textarea, Select, Radio Group
- Dialog, Tabs, Table, Progress, Tooltip
- Dropdown Menu, Navigation Menu, Scroll Area

#### 4. 测试页面

创建了测试页面用于验证配置：
- 路径：`/shadcn-test`
- 文件：`src/pages/ShadcnTest.tsx`

### 🧪 测试方法

1. 启动开发服务器：
```bash
pnpm run dev
```

2. 在浏览器中访问：`http://localhost:7777/shadcn-test`

3. 测试以下功能：
   - ✅ 主题切换（浅色/深色/系统）
   - ✅ 各种按钮样式
   - ✅ Badge 标签
   - ✅ Tabs 标签页
   - ✅ Input 输入框
   - ✅ Card 卡片组件

### 📝 关键变更点

#### 主题切换方式变更

**之前（daisyUI）：**
```javascript
// 使用 data-theme 属性
htmlElement.setAttribute("data-theme", "dark")
```

**现在（shadcn/ui）：**
```javascript
// 使用 class
htmlElement.classList.add("dark")
```

#### 类名映射

| DaisyUI | Shadcn/ui | 说明 |
|---------|-----------|------|
| `bg-base-100` | `bg-background` | 主背景色 |
| `bg-base-200` | `bg-card` 或 `bg-muted` | 次级背景 |
| `bg-base-300` | `bg-accent` | 强调背景 |
| `text-base-content` | `text-foreground` | 主文字色 |
| `text-gray-600 dark:text-gray-300` | `text-muted-foreground` | 次级文字 |

#### 组件使用方式变更

**之前（daisyUI）：**
```tsx
<button className="btn btn-primary">按钮</button>
<div className="badge">标签</div>
<div className="card bg-base-200">卡片</div>
```

**现在（shadcn/ui）：**
```tsx
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"

<Button>按钮</Button>
<Badge>标签</Badge>
<Card>卡片</Card>
```

---

## ⏳ 阶段2：基础UI组件迁移 (计划中)

### 目标文件

1. **src/pages/Home.tsx**
   - 迁移卡片组件
   - 更新背景色类名

2. **src/pages/Tools/index.tsx**
   - 迁移 badge 组件
   - 迁移卡片布局

### 预计变更

- 导入 shadcn/ui 组件
- 替换 daisyUI 类名
- 更新颜色语义化类名

---

## ⏳ 阶段3：导航组件迁移 (计划中)

### 目标文件

1. **src/pages/components/BottomNavigation.tsx**
   - 使用 Navigation Menu 组件
   - 保持现有动画效果

2. **src/pages/components/AppTitleBar.tsx**
   - 更新样式类名

---

## ⏳ 阶段4：设置页面组件迁移 (计划中)

### 目标文件

1. **src/pages/Setting/components/ThemeConfig.tsx**
   - 使用 Radio Group 组件替换 join

2. **src/pages/Setting/components/LanguageConfig.tsx**
   - 使用 Select 组件

3. **src/pages/Setting/components/ModelConfig.tsx**
   - 迁移表单组件

---

## ⏳ 阶段5：复杂功能页面迁移 (计划中)

### 目标文件

字幕工具相关页面：
1. **SubtitleTranslator**
2. **SubtitleConverter**
3. **SubtitleLanguageExtractor**
4. **ErrorDetailModal**

### 需要迁移的组件

- Table 组件
- Dialog/Modal 组件
- Progress 组件
- Textarea 组件
- 复杂表单布局

---

## ⏳ 阶段6：最终优化与清理 (计划中)

### 任务清单

- [ ] 移除 daisyUI 依赖
- [ ] 删除测试页面
- [ ] 统一样式风格
- [ ] 性能测试
- [ ] 更新文档

---

## 🛠️ 开发规范

### 使用 cn() 工具函数

合并类名时使用 `cn()` 函数：

```tsx
import { cn } from "@/lib/utils"

<div className={cn(
  "base-class",
  condition && "conditional-class",
  className // 允许外部传入类名
)} />
```

### 保持组件一致性

- 使用 shadcn/ui 提供的组件变体（variant）
- 保持与设计系统的一致性
- 使用语义化的颜色变量

### 主题变量使用

```tsx
// ✅ 推荐
<div className="bg-background text-foreground">
<div className="bg-card text-card-foreground">
<p className="text-muted-foreground">

// ❌ 避免
<div className="bg-white dark:bg-gray-900">
<div className="text-gray-600 dark:text-gray-300">
```

---

## 📚 资源链接

- [Shadcn/ui 官方文档](https://ui.shadcn.com)
- [Tailwind CSS 文档](https://tailwindcss.com)
- [Radix UI 文档](https://www.radix-ui.com)
- [项目仓库](https://github.com/QiuYeDx/FusionKit)

---

## ❓ 常见问题

### Q: 为什么要分阶段迁移？

A: 分阶段迁移可以：
1. 保持项目始终可运行
2. 更容易排查问题
3. 避免单次修改过多文件
4. 允许逐步测试和验证

### Q: 迁移后性能会有影响吗？

A: shadcn/ui 基于 Radix UI，性能优秀，且不会打包整个组件库，只打包使用的组件。

### Q: 可以同时使用 daisyUI 和 shadcn/ui 吗？

A: 可以，但不推荐。在迁移过程中会同时存在，但最终会完全移除 daisyUI。

### Q: 如何自定义 shadcn/ui 组件样式？

A: 有三种方式：
1. 修改 `src/index.css` 中的 CSS 变量
2. 使用 `cn()` 函数添加额外类名
3. 直接修改 `src/components/ui/` 中的组件代码

---

## 📞 需要帮助？

如遇到问题，请检查：
1. Node 版本是否为 20
2. 依赖是否正确安装
3. CSS 变量是否正确配置
4. 浏览器控制台是否有错误

---

**最后更新：** 2025-10-20
**当前阶段：** 阶段1（已完成）
**下一步：** 开始阶段2 - 基础UI组件迁移

