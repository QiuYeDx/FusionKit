# 工作包 CLEAN-001：旧视觉组件、漂移 class 与文档收口

## 基本信息

- 日期：2026-06-26
- 状态：已完成
- 对应执行计划工作包：`CLEAN-001`

## 本次实现内容

- 删除长文本旧视觉体系遗留的公开组件，防止后续工具详情页继续使用非基准风格。
- 清理 `_shared/ui/index.ts` 中已删除组件的导出。
- 复核工具详情页中不再残留 340px 双栏、大号 `CardHeader` / `CardContent` 风格入口。
- 复核共享 UI 组件边界，不读取工具 store，不调用 IPC，不内置具体工具业务状态。
- 将 Final Design 与 Execution Plan 从“计划清理”更新为实际清理结果。

## 修改文件

- `src/pages/Tools/_shared/ui/index.ts`
- 删除：`src/pages/Tools/_shared/ui/ToolSection.tsx`
- 删除：`src/pages/Tools/_shared/ui/ToolStat.tsx`
- 删除：`src/pages/Tools/_shared/ui/ToolActionBar.tsx`
- `docs/tool-detail-page-ui-standardization-final-design.md`
- `docs/tool-detail-page-ui-standardization-execution-plan.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_CLEAN-001_legacy-ui-components-cleanup.md`

## 接口或数据结构变化

- 无业务接口、IPC、store、任务数据结构变化。
- `_shared/ui` 不再公开：
  - `ToolSection`
  - `ToolStat`
  - `ToolStatGrid`
  - `ToolActionBar`
  - `TooltipIconButton`
- 对应视觉语义已分别由 `ToolConfigPanel`、`ToolConfigDisclosure`、`ToolPanel`、`ToolStatBar` 和业务任务行承担。

## 视觉核对

- 页面：本工作包为清理工作，未启动 Electron 视觉矩阵。
- 结论：静态扫描确认工具详情页不再引用旧视觉组件，也不再出现本次明确禁止的 340px 双栏和默认大 Card 入口。

## 验证结果

执行命令：

```text
rg -n "ToolSection|ToolStatGrid|ToolActionBar|TooltipIconButton|\\bToolStat\\b" src test -g '*.{ts,tsx}' || true
rg -n -F 'lg:grid-cols-[340px' src/pages/Tools || true
rg -n -F 'CardTitle className="text-base"' src/pages/Tools || true
rg -n -F 'CardHeader' src/pages/Tools || true
rg -n -F 'CardContent' src/pages/Tools || true
rg -n "use[A-Z].*Store|ipcRenderer|window\\.ipc|TEXT_TRANSLATION|subtitle|translator\\." src/pages/Tools/_shared/ui -g '*.{ts,tsx}' || true
find src/pages/Tools/_shared/ui -maxdepth 1 -type f -name 'Tool*.tsx' -print | sort
./node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
./node_modules/.bin/vite build
git diff --check
```

结果：

- 旧组件生产/测试引用扫描：无输出，通过。
- 340px 双栏和默认大 Card 入口扫描：无输出，通过。
- 共享 UI 边界扫描：无 store / IPC / 工具业务状态引用，通过。
- 当前共享 `Tool*.tsx` 文件仅保留统一后的组件：
  - `ToolConfigDisclosure.tsx`
  - `ToolConfigDivider.tsx`
  - `ToolConfigPanel.tsx`
  - `ToolDetailLayout.tsx`
  - `ToolField.tsx`
  - `ToolFileDropZone.tsx`
  - `ToolOutputPathPicker.tsx`
  - `ToolPanel.tsx`
  - `ToolStatBar.tsx`
  - `ToolSummaryLine.tsx`
- TypeScript：通过。
- i18n 完整性检查：通过，四语言各 namespace 数量一致。
- Vite build：通过；仅出现既有 chunk size / dynamic import warning。
- `git diff --check`：通过。

## 前端进程清理

- 启动过的服务：无。本工作包只运行一次性 TypeScript、i18n 和 Vite build，没有启动 Vite dev server、Electron 或其他持久前端服务。
- 结束方式：不适用。
- 结束后进程确认：无本轮启动进程需要清理。

## 未完成事项

- 无。

## 下一步建议

- 认领 `QA-001`：运行完整自动化回归与静态合同验收。
- `QA-001` 通过后进入 `QA-002`：五个工具详情页 Electron 视觉矩阵验收。
