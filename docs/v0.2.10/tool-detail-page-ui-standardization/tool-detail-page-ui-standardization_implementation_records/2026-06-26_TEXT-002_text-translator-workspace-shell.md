# TEXT-002 长文本工作区入口与任务面板骨架迁移实施记录

> 日期：2026-06-26
> 工作包：`TEXT-002`
> 范围：迁移长文本翻译右侧首屏结构；不迁移任务行最终视觉、不移除指标小卡、不修改执行/恢复/IPC 逻辑。

## 1. 目标

让长文本翻译右侧工作区从旧的“大 Card 内置上传区 + 内容底部 ActionBar”收敛为字幕基准的三段结构：

```text
ToolFileDropZone → ToolSummaryLine → ToolPanel
```

并将准备、开始、取消、恢复、打开工作区、清空和打开输出等操作移入任务面板卡头。

## 2. 关键改动

### 2.1 上传区迁移到工作区顶层

更新 `src/pages/Tools/Text/TextTranslator/components/TaskPanel.tsx`：

- 移除旧的隐藏 input + 纵向居中 drop zone；
- 改用 `ToolFileDropZone`；
- 保留：
  - `.txt/.md/.markdown` accept；
  - 多文件选择；
  - 拖放；
  - `isBusy` 下禁用选择与清除；
  - 已选文件标题/描述；
  - “移除”次级操作。

`ToolFileDropZone` 内部 input 继续通过原 `fileInputRef` 绑定，`onFiles`、`onClearFiles` 和拖拽状态 handler 不变。

### 2.2 新增右侧参数摘要行

更新 `src/pages/Tools/Text/TextTranslator/index.tsx`：

- 向 `TaskPanel` 传入 `summaryItems`；
- 展示：
  - 文件数；
  - 独立文件 / 有序项目；
  - 快速并发 / 连贯串行；
  - 源文件目录 / 自定义目录；
  - 当前任务模型或未配置模型。

摘要行本身使用 `ToolSummaryLine`，不新增 i18n key。

### 2.3 任务面板外壳迁移到 `ToolPanel`

更新 `TaskPanel.tsx`：

- 移除旧 `Card`、`CardHeader`、`CardContent`；
- 改用 `ToolPanel`；
- 面板 badge 显示当前队列数或已选文件数；
- 卡头 actions 放置：
  - 准备任务；
  - 开始翻译；
  - 取消；
  - 打开输出；
  - 恢复；
  - 打开工作区；
  - 清空。

所有按钮使用紧凑尺寸，并允许 `ToolPanel` header 自动换行。

### 2.4 文件列表进入任务面板 body

- 文件顺序列表保留在任务面板 body；
- 多文件且项目模式为 `independent_files` 时，文件列表右侧 badge 改为显示“独立文件”，与摘要行和真实项目模式保持一致；
- 移动排序 handler 不变。

## 3. 未改动内容

- `useTextTranslatorStore`；
- `textTranslatorExecutionService`；
- `create/prepare/start/cancel/recovery` handler；
- 主进程 text translation IPC 和服务；
- 任务行最终视觉；
- 指标小卡和进度详情；
- RecoveryDialog。

## 4. 验证

### 4.1 静态、测试与构建

执行并通过：

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
node scripts/check-i18n.mjs
./node_modules/.bin/vite build
git diff --check
```

结果摘要：

- text 相关测试：3 files / 15 tests passed；
- i18n：8 namespaces / 930 keys，各语言数量一致；
- Vite build：renderer、main、preload 均构建成功；
- `git diff --check`：无输出。

### 4.2 Electron 视觉矩阵

通过 Playwright Electron 启动真实 Electron 窗口，并显式等待：

- `.app-loading-wrap` 不存在；
- `#app-loading-style` 不存在；
- 路由为 `#/tools/text/translator`；
- `#text-translator-upload-zone` 和 `#text-translator-task-panel` 已出现。

视觉脚本临时写入稳定默认偏好与任务模型，并在结束时恢复原 localStorage。

矩阵覆盖：

| Case | 状态 | 结果 | 截图 |
| --- | --- | --- | --- |
| 786×540 Light | 空状态 | loading=false；无横向溢出；上传区与任务面板可见；准备按钮禁用 | `/private/tmp/fusionkit-text-workspace-min-light-empty.png` |
| 786×540 Light | 已选 2 个 TXT | loading=false；无横向溢出；文件顺序可见；准备按钮可用 | `/private/tmp/fusionkit-text-workspace-min-light-selected.png` |
| 786×540 Dark | 空状态 | loading=false；`html.dark=true`；无横向溢出 | `/private/tmp/fusionkit-text-workspace-min-dark-empty.png` |
| 786×540 Dark | 已选 2 个 TXT | loading=false；`html.dark=true`；文件顺序可见；准备按钮可用 | `/private/tmp/fusionkit-text-workspace-min-dark-selected.png` |
| 1440×900 Light | 空状态 | loading=false；无横向溢出；右栏三段结构可见 | `/private/tmp/fusionkit-text-workspace-wide-light-empty.png` |
| 1440×900 Light | 已选 2 个 TXT | loading=false；无横向溢出；卡头按钮一行容纳 | `/private/tmp/fusionkit-text-workspace-wide-light-selected.png` |
| 1440×900 Dark | 空状态 | loading=false；`html.dark=true`；无横向溢出 | `/private/tmp/fusionkit-text-workspace-wide-dark-empty.png` |
| 1440×900 Dark | 已选 2 个 TXT | loading=false；`html.dark=true`；文件列表 badge 与“独立文件”一致 | `/private/tmp/fusionkit-text-workspace-wide-dark-selected.png` |

补充核对：

- 选中 2 个 TXT 后摘要行显示文件数、项目模式、执行模式、输出模式和模型；
- 文件顺序列表进入任务面板 body；
- 786×540 下通过 `scrollIntoViewIfNeeded()` 核对工作区，无整页横向滚动；
- 视觉脚本先后修正了两个验证坑：
  - 等待全局 Loading DOM 完全移除；
  - `fusionkit-theme` 必须写入 Zustand persist JSON，而不是裸字符串。

## 5. 前端进程清理

本次启动过：

```text
VSCODE_DEBUG=1 ./node_modules/.bin/vite --host 127.0.0.1 --port 7777
```

Electron 由 Playwright 脚本启动并通过 `app.close()` 关闭。

Vite 已通过 `Ctrl-C` 关闭，最终进程检查：

```text
ps -axo pid,ppid,command | rg 'vite|electron|127.0.0.1:7777|7777|Electron \\. --no-sandbox' | rg -v 'rg '
```

结果为空。

## 6. 后续建议

下一步认领 `TEXT-003`：

- 将当前任务、批量任务和文件列表进一步收敛到字幕任务行密度；
- 用 `ToolStatBar` 替换当前 `ToolStatGrid` / `ToolStat` 独立小卡；
- 移除长文本页对 `ToolActionBar`、`TooltipIconButton`、旧指标卡的依赖；
- 核对 waiting/running/completed/failed/cancelled 等状态矩阵。

遗留风险：

- 任务面板 body 仍保留部分旧密度结构和指标小卡，这是 `TEXT-003` 的明确范围；
- 本包只验证了空状态与已选文件状态，未执行真实 prepare/start 链路。
