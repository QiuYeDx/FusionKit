# 工作包 NT-UX-001：文件名翻译体验修复

## 基本信息

- 日期：2026-07-02
- 状态：已完成
- 对应执行计划工作包：`docs/v0.2.11/name-translator-ux/name-translator-ux-execution-plan.md` / `NT-UX-001`

## 本次实现内容

- 将文件名翻译路径选择入口从误导性的“文件/文件夹”改为明确的“文件”和“仅文件夹”两个入口。
- 文件入口只打开文件选择器，文件夹入口只打开目录选择器；拖拽仍支持混合添加。
- 新增 `clearSelection()`，页面清空当前选择时保留输出模式、语言、命名风格、冲突策略等用户配置。
- 左侧已选路径列表改为最大高度内部纵向滚动，并添加上下渐变遮罩提示滚动边界。
- 修复左侧已选路径列表使用 Radix ScrollArea 时未形成稳定滚动区域的问题，长文件名/路径不再造成横向溢出。
- 预览表格的新名称列加宽，原名/新名/路径和操作按钮 tooltip 改为左侧显示。
- 预览表格操作列改为 sticky right，横向滚动时始终可见。
- 更新 zh、zh-Hant、en、ja 四语言文案。

## 修改文件

- `src/pages/Tools/Rename/NameTranslator/components/PathPickerPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
- `src/pages/Tools/Rename/NameTranslator/index.tsx`
- `src/store/tools/rename/useNameTranslatorStore.ts`
- `src/store/tools/rename/useNameTranslatorStore.test.ts`
- `src/locales/zh/rename.json`
- `src/locales/zh-Hant/rename.json`
- `src/locales/en/rename.json`
- `src/locales/ja/rename.json`
- `docs/v0.2.11/name-translator-ux/name-translator-ux-final-design.md`
- `docs/v0.2.11/name-translator-ux/name-translator-ux-execution-plan.md`

## 接口或数据结构变化

- Renderer store 新增 `clearSelection(): void`。
- 无 Electron IPC、rename plan、apply journal 或 rollback 数据结构变化。
- `reset()` 保持全量恢复默认状态，供测试隔离和内部完整重置使用。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/rename/dialog-options.test.ts src/store/tools/rename/useNameTranslatorStore.test.ts
node scripts/check-i18n.mjs
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build
git diff --check
Playwright Chrome 浏览器级滚动布局检查
```

结果：

- Rename 相关单测通过：2 个测试文件，17 个测试通过。
- i18n 检查通过：8 个 namespace，四语言各 930 个 key。
- TypeScript 检查通过。
- Vite build 通过；仅保留既有 dynamic/static import 与 chunk size warning。
- `git diff --check` 通过。
- 浏览器级滚动布局检查通过：18 个长路径条目下列表 `scrollHeight=1095`、`clientHeight=320`、`canScrollY=true`、`hasHorizontalOverflow=false`、`rowOverflow=false`、`panelOverflow=false`、生成预览按钮保持可见，滚动后上下渐变遮罩均显示。

补充说明：

- 按用户提醒，本仓库 lockfile 为 pnpm v6 格式；当前环境默认 `pnpm` 是 11.7.0，会认为 lockfile 不兼容并尝试 install，因此验证改用 `node_modules/.bin/*` 和 `node scripts/check-i18n.mjs`，未更新 `pnpm-lock.yaml`。
- Windows/Linux 原生文件/目录混选限制已由既有 `test/rename/dialog-options.test.ts` 覆盖；本次 UI 不再向 Windows 用户展示误导性的“文件/文件夹”按钮。
- 本机 Playwright Electron 冒烟失败于 `electron.launch: Process failed to launch`。随后改用本机 Chrome channel 做浏览器级 DOM/布局验证，未安装新依赖或浏览器。Windows 11 原生弹窗建议后续人工复验。

## 前端进程清理

- 本次启动过 Vite dev server：`./node_modules/.bin/vite --host 127.0.0.1 --port 7777`。
- 已通过 Ctrl-C 结束，退出码 `130`。
- 回复前执行 FusionKit Vite/Electron 进程表检查，预期输出为空。

## 未完成事项

- Windows 11 真实选择弹窗仍需人工确认“文件”按钮只能选文件、“仅文件夹”按钮能选文件夹。
- sticky 操作列仍建议在 Electron 环境或人工 UI 中复核。

## 下一步建议

- 在 Windows 11 上打开文件名翻译工具，分别测试“文件”和“仅文件夹”按钮。
- 用 20 个以上路径和较长翻译名称检查左侧滚动遮罩、tooltip 左侧显示和操作列 sticky 体验。
