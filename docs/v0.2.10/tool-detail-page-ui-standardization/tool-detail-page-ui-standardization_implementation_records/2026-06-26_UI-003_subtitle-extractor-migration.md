# 工作包 UI-003：字幕提取页迁移与抽象复核

## 基本信息

- 日期：2026-06-26
- 状态：已完成
- 对应执行计划工作包：`UI-003`

## 本次实现内容

- 将字幕语言提取页迁移到统一工具详情页视觉骨架：
  - 使用 `ToolDetailLayout` 承载标题区、左侧配置栏与右侧工作区。
  - 使用 `ToolConfigPanel` 统一配置面板标题、边框、圆角、间距与背景。
  - 使用 `ToolField`、`ToolConfigDivider`、`ToolOutputPathPicker` 统一配置项、分割线与输出目录选择。
  - 使用 `ToolFileDropZone` 统一上传入口、拖放状态、accept、多选与文件 input reset 行为。
  - 使用 `ToolSummaryLine` 和 `ToolPanel` 统一摘要行与任务管理面板。
- 保留字幕语言提取页原有业务行为：
  - 保留语言、输出位置、冲突策略不变。
  - `.lrc/.srt` 批量选择、拖放、任务队列、单任务开始、全部开始、删除、清空和打开文件位置逻辑不变。
  - Tour 锚点 id 保持不变。
- 复核三个字幕页的共享抽象边界：
  - 不新增 `ToolTaskRowShell`。
  - 任务行继续由业务页面拥有，只共享外层 `ToolPanel`。

## 修改文件

- `src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx`
- `docs/tool-detail-page-ui-standardization-execution-plan.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_UI-003_subtitle-extractor-migration.md`

## 接口或数据结构变化

- 无业务 store、IPC、service、任务状态模型或 i18n key 变化。
- 无共享组件 API 新增；本工作包只消费 `UI-001` / `UI-002` 已建立的共享 UI。
- 未抽取 `ToolTaskRowShell`，原因：
  - 三个字幕页任务行的状态、操作按钮、详情字段、编辑入口和错误展示都与各自业务模型强绑定。
  - 如果抽成共享任务行，需要把业务状态枚举、任务动作和文案 slot 大量塞入共享组件，API 会比页面内 JSX 更难读。
  - 当前稳定公共层是“任务面板容器”，任务行仍属于业务页面，符合 Final Design 的抽象门槛。

## 验证结果

执行命令：

```text
./node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
./node_modules/.bin/vite build
git diff --check
rg "lg:grid-cols-\[320px_minmax|overflow-hidden p-0 gap-0|CardHeader|CardTitle|relative flex items-center gap-4 rounded-xl border-2 border-dashed|h-px bg-border -mx-4" src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx src/pages/Tools/Subtitle/SubtitleConverter/index.tsx src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx
rg "CardHeader|CardTitle|<Card|</Card>|handleDrag|handleDrop|Folder,|\bUpload\b" src/pages/Tools/Subtitle/SubtitleLanguageExtractor/index.tsx
node /private/tmp/fusionkit-tool-detail-visual-matrix.mjs
```

结果：

- `tsc` 通过。
- i18n 检查通过；各语言 key 数量一致。
- Vite build 通过；仅保留既有 dynamic/static import 和 chunk size warning。
- `git diff --check` 通过。
- 三个字幕页未再命中旧的核心页面壳、Card 面板、私有上传区和私有分割线 class。
- 字幕语言提取页未再使用旧 Card 面板、私有 drag handler 或旧 Folder/Upload 图标导入。
- Electron 视觉矩阵通过：
  - 页面：字幕 AI 翻译、字幕格式转换、字幕语言提取。
  - 尺寸：786×540、1440×900。
  - 主题：Dark、Light。
  - 结果：12 个组合均 `loading=no`、`pageOverflow=no`、`globalOverflow=no`。
  - 最小窗口额外截图 workspace 区，确认上传区与任务面板在滚动后可见。
- 本次修正了视觉矩阵脚本的截图时机：
  - 截图前等待 `.app-loading-wrap` 与 `#app-loading-style` 全部移除。
  - 预置 `subtitle-extractor-tour-done`，避免字幕语言提取页 Tour 覆盖截图。
  - 截图前确认不存在 `role="dialog"` 且 `aria-modal="true"` 的覆盖层。
- 本轮启动的 Vite renderer 已在回复前通过 Ctrl-C 结束；Playwright Electron 由脚本 `app.close()` 关闭；最终进程表确认无 FusionKit Vite/Electron 残留。

## 未完成事项

- 文件名翻译页尚未迁移，留给 `UI-004`。
- 长文本翻译页尚未迁移，仍按 `TEXT-001` 至 `TEXT-004` 分阶段推进。
- 真实文件链路回归留给后续 QA 工作包覆盖。

## 下一步建议

- 下一步认领 `UI-004`：迁移文件名翻译页外层布局与面板视觉，验证共享抽象不绑定字幕业务模型。
- `UI-004` 完成后再进入长文本翻译页迁移，避免共享 UI API 在多个大页面中并行漂移。
