# Shadcn/ui 迁移文档 - 阶段1：环境准备与基础配置

## ✅ 已完成的工作

### 1. 环境准备
- ✅ 切换到 Node 20 版本 (`nvm use 20`)
- ✅ 安装核心依赖包：
  - `class-variance-authority` - 组件样式变体管理
  - `clsx` - 类名合并工具
  - `tailwind-merge` - Tailwind CSS 类名智能合并
  - `lucide-react` - 图标库
  - `tailwindcss-animate` - 动画插件

### 2. 配置文件更新

#### `tailwind.config.js`
- ✅ 移除 daisyUI 插件和配置
- ✅ 改用 `darkMode: ['class']` 替代 `data-theme`
- ✅ 添加 shadcn/ui 颜色系统（使用 CSS 变量）
- ✅ 添加 `tailwindcss-animate` 插件
- ✅ 保留原有的自定义动画配置

#### `src/index.css`
- ✅ 添加 shadcn/ui 主题 CSS 变量（浅色和深色模式）
- ✅ 添加 `@layer base` 样式
- ✅ 保留原有的全局样式

#### `components.json`
- ✅ 创建 shadcn/ui 配置文件
- ✅ 配置路径别名和样式选项

#### `src/lib/utils.ts`
- ✅ 创建 `cn()` 工具函数用于类名合并

#### `src/utils/common.ts`
- ✅ 更新 `applyTheme()` 函数：
  - 从 `data-theme` 属性改为 `class` 系统
  - 添加/移除 `.dark` 类而非设置属性

#### `src/App.tsx`
- ✅ 更新根组件类名：`bg-base-100` → `bg-background text-foreground`

### 3. 安装的 Shadcn/ui 组件

已安装以下 17 个核心组件：

**基础组件：**
- ✅ Button
- ✅ Badge
- ✅ Card
- ✅ Label
- ✅ Separator
- ✅ Input
- ✅ Textarea

**表单组件：**
- ✅ Select
- ✅ Radio Group

**高级组件：**
- ✅ Dialog
- ✅ Tabs
- ✅ Table
- ✅ Progress
- ✅ Tooltip
- ✅ Dropdown Menu
- ✅ Navigation Menu
- ✅ Scroll Area

### 4. 主题系统
- ✅ 创建 `ThemeProvider` 组件
- ✅ 更新主题切换逻辑以支持 shadcn/ui 的 class 模式
- ✅ 保持与现有 zustand store 的兼容性

## 📦 组件位置

所有 shadcn/ui 组件已安装到：
```
/src/components/ui/
├── badge.tsx
├── button.tsx
├── card.tsx
├── dialog.tsx
├── dropdown-menu.tsx
├── input.tsx
├── label.tsx
├── navigation-menu.tsx
├── progress.tsx
├── radio-group.tsx
├── scroll-area.tsx
├── select.tsx
├── separator.tsx
├── table.tsx
├── tabs.tsx
├── textarea.tsx
└── tooltip.tsx
```

## 🎨 主题变量

shadcn/ui 使用以下 CSS 变量进行主题管理：

**浅色模式：**
- `--background`: 页面背景色
- `--foreground`: 主要文字颜色
- `--card`: 卡片背景色
- `--primary`: 主要颜色
- `--secondary`: 次要颜色
- `--muted`: 静音/禁用颜色
- `--accent`: 强调色
- `--destructive`: 危险/删除颜色
- 等等...

**深色模式：**
通过 `.dark` 类自动应用深色模式下的所有变量。

## 🔄 DaisyUI vs Shadcn/ui 对照

| DaisyUI | Shadcn/ui |
|---------|-----------|
| `bg-base-100` | `bg-background` |
| `bg-base-200` | `bg-card` 或 `bg-muted` |
| `text-base-content` | `text-foreground` |
| `btn` | `<Button>` 组件 |
| `badge` | `<Badge>` 组件 |
| `card` | `<Card>` 组件 |
| `data-theme="dark"` | `class="dark"` |
| `join` (单选按钮组) | `<RadioGroup>` |

## 📝 下一步计划 - 阶段2

阶段2将开始迁移实际的 UI 组件，包括：

1. **Home.tsx** - 首页卡片
   - 替换 `bg-base-200` 为 `<Card>` 组件
   
2. **Tools/index.tsx** - 工具列表页面
   - 替换 `badge` 为 `<Badge>` 组件
   - 替换 `bg-base-200` 为 `<Card>` 组件

3. 更新灰色文字样式
   - `text-gray-600 dark:text-gray-300` → `text-muted-foreground`

## ⚠️ 注意事项

1. **保持 daisyUI 暂时存在**：在阶段1完成后，daisyUI 仍在 package.json 中，这是为了不影响现有功能。等所有组件迁移完成后再移除。

2. **渐进式迁移**：我们采用渐进式迁移策略，每个阶段只迁移一部分组件，确保项目始终处于可运行状态。

3. **测试主题切换**：完成阶段1后，应该测试主题切换功能是否正常工作。

## 🧪 测试清单

- [ ] 运行 `pnpm run dev` 确认项目能正常启动
- [ ] 测试浅色/深色模式切换
- [ ] 确认没有控制台错误
- [ ] 验证 Tailwind CSS 样式正常生效

## 📚 参考资源

- [Shadcn/ui 官方文档](https://ui.shadcn.com)
- [Tailwind CSS 文档](https://tailwindcss.com)
- [Radix UI 文档](https://www.radix-ui.com) (shadcn/ui 基于此构建)

