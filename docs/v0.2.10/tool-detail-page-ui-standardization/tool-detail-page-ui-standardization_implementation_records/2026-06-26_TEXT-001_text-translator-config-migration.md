# TEXT-001 长文本配置栏迁移实施记录

> 日期：2026-06-26
> 工作包：`TEXT-001`
> 范围：只迁移长文本翻译左侧配置栏；不迁移右侧工作区、任务行、恢复弹窗或业务执行逻辑。

## 1. 目标

将长文本翻译详情页左栏从旧的 `Card + ToolSection + Separator` 结构迁移到字幕 AI 翻译页基准的紧凑配置面板语言，统一：

- 配置卡标题、内边距和分隔线；
- 字段标签字号、控件高度和按钮密度；
- 输出路径选择器视觉；
- 只对低频提示工程字段使用紧凑折叠块。

## 2. 关键改动

### 2.1 新增共享折叠组件

新增 `src/pages/Tools/_shared/ui/ToolConfigDisclosure.tsx`：

- 用于工具详情页低频高级配置；
- 支持 `icon`、`title`、`summary`、`defaultOpen`、受控 `open` / `onOpenChange`；
- trigger 使用紧凑 dashed border 视觉；
- 设置 `aria-expanded` / `aria-controls`；
- 展开动画使用 grid row 技术，并在展开后释放 `overflow-visible`，避免后续 Select / Popover / focus ring 被折叠容器裁剪。

同步在 `src/pages/Tools/_shared/ui/index.ts` 导出。

### 2.2 迁移长文本配置栏

更新 `src/pages/Tools/Text/TextTranslator/components/ConfigPanel.tsx`：

- 外壳改用 `ToolConfigPanel`；
- 常规字段改用 `ToolField` + 紧凑控件：
  - `SelectTrigger size="sm"`；
  - `Input className="h-8 text-xs"`；
  - `Textarea className="text-xs md:text-xs"`；
- 使用 `ToolConfigDivider` 替代旧 `Separator`；
- 保留并复用 `InfoHint` 和 `ToolOutputPathPicker`；
- 语言选择合并为“源语言 → 目标语言”的紧凑双 Select；
- 上下文预算条继续展示百分比、预计需求、模型上下文和输出预留；
- 只在 `executionMode === "sequential_context"` 时渲染提示词工程 `ToolConfigDisclosure`，默认收起；
- 双语对照格式、自定义输出目录仍保持条件渲染。

未改动：

- `preferences` 类型、默认值、持久化 key；
- `prepare/start` 校验；
- store / service / IPC；
- 右侧 `TaskPanel` 结构。

## 3. 验证

### 3.1 静态与构建验证

均已通过：

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run src/type/textTranslation.test.ts src/services/text/textTranslatorExecutionService.test.ts
node scripts/check-i18n.mjs
git diff --check
./node_modules/.bin/vite build
```

结果摘要：

- text 相关测试：2 files / 10 tests passed；
- i18n：8 namespaces / 930 keys，各语言数量一致；
- Vite build：renderer、main、preload 均构建成功；
- `git diff --check`：无输出。

### 3.2 Electron 视觉矩阵

通过 Playwright Electron 启动真实 Electron 窗口，并显式等待：

- `.app-loading-wrap` 不存在；
- `#app-loading-style` 不存在；
- `#/tools/text/translator` 路由与“长文本翻译”文案已出现。

矩阵结果：

| Case | 结果 | 截图 |
| --- | --- | --- |
| 786×540 Light | loading=false；无横向溢出；单列布局下配置卡自然占满内容宽度 | `/private/tmp/fusionkit-text-config-min-light.png` |
| 786×540 Dark | loading=false；无横向溢出；暗色选中态与控件边界正常 | `/private/tmp/fusionkit-text-config-min-dark.png` |
| 1440×900 Light | loading=false；无横向溢出；配置栏宽度 320px | `/private/tmp/fusionkit-text-config-wide-light.png` |
| 1440×900 Dark | loading=false；无横向溢出；配置栏宽度 320px | `/private/tmp/fusionkit-text-config-wide-dark.png` |

补充交互核对：

- 切换“连贯串行”后，提示词工程 disclosure 出现，默认 `aria-expanded="false"`；
- 点击 disclosure 后变为 `aria-expanded="true"`，高级字段正常展开；
- 切换“双语对照”后“对照格式”字段正常出现；
- 切换“自定义目录”后输出目录选择器正常出现；
- 交互状态下仍无横向溢出。

交互截图：

```text
/private/tmp/fusionkit-text-config-sequential-expanded.png
```

## 4. 服务清理

本次视觉 QA 启动过：

```text
VSCODE_DEBUG=1 ./node_modules/.bin/vite --host 127.0.0.1 --port 7777
```

已通过 `Ctrl-C` 关闭 Vite 进程；Playwright Electron 脚本通过 `app.close()` 关闭 Electron。

最终进程检查未发现本次启动的 Vite / Electron 残留。

## 5. 后续建议

下一步认领 `TEXT-002`：

- 上传区移出旧任务 Card；
- 右侧工作区入口改用 `ToolFileDropZone`；
- `TaskPanel` 外层迁移到 `ToolPanel`；
- 补充文件选择状态和右侧骨架视觉核对。

遗留风险：

- `TEXT-001` 只统一左侧配置栏；右侧长文本工作区仍是旧密度和旧 Card 组织，视觉差异将在 `TEXT-002` / `TEXT-003` 收敛。
