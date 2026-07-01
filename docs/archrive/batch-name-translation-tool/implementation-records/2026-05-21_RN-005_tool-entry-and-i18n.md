# 工作包 RN-005：工具入口与 i18n

## 基本信息

- 日期：2026-05-21
- 状态：已完成
- 对应执行计划工作包：`docs/batch-name-translation-tool/work-packages/RN-005_tool-entry-and-i18n.md`

## 本次实现内容

- 按工作包推荐方案新增 `nameTranslator` 工具 key，`category` 仍归属 `rename`。
- 将重命名工具箱从 Coming Soon 占位替换为可点击的「文件名/文件夹名翻译」工具卡片。
- 保持路由为 `/tools/rename/name-translator`，并让工具卡片通过 `TOOL_META.nameTranslator.route` 进入 RN-004 页面。
- 为工具入口补齐中、英、日三语标题、描述和 chips。
- 新增 `rename` i18n namespace，并注册到 `src/i18n/constants.ts` 和 `src/i18n/resources.ts`。
- 将 RN-004 工具页、子组件和 store 中的用户可见文案迁移到 `rename.json`：
  - 页面 header 和错误提示。
  - 路径选择、系统选择器标题、空状态、工具提示。
  - 范围、目标类型、语言、命名风格、开关、冲突策略。
  - 预览表、分页、操作按钮、状态显示。
  - apply 摘要、高风险确认、toast/progress 文案。

## 修改文件

- `src/pages/Tools/_shared/toolMeta.ts`
- `src/pages/Tools/index.tsx`
- `src/i18n/constants.ts`
- `src/i18n/resources.ts`
- `src/locales/zh/tools.json`
- `src/locales/en/tools.json`
- `src/locales/ja/tools.json`
- `src/locales/zh/rename.json`
- `src/locales/en/rename.json`
- `src/locales/ja/rename.json`
- `src/pages/Tools/Rename/NameTranslator/index.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PathPickerPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/ApplySummaryPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/RiskConfirmDialog.tsx`
- `src/store/tools/rename/useNameTranslatorStore.ts`
- `docs/batch-name-translation-tool/work-packages/README.md`
- `docs/batch-name-translation-tool/work-packages/RN-005_tool-entry-and-i18n.md`
- `docs/batch-name-translation-tool/implementation-records/2026-05-21_RN-005_tool-entry-and-i18n.md`

## 接口或数据结构变化

- `ToolKey` 从旧的 `rename` 占位改为新增 `nameTranslator` 工具 key。
- `TOOL_META.nameTranslator`：
  - `status: "stable"`
  - `route: "/tools/rename/name-translator"`
  - `category: "rename"`
- i18n 新增 namespace：`rename`。
- 工具列表 `CardItem` 支持 `chipKeys`，用于新工具卡片 chips 走 i18n。

## 验证结果

执行命令：

```text
pnpm exec tsc --noEmit
pnpm exec vitest run test/rename src/services/rename
pnpm build
pnpm dev -- --host 127.0.0.1
```

结果：

- `pnpm exec tsc --noEmit`：通过。
- rename 相关测试：6 files passed，26 tests passed。
- `pnpm build`：通过；electron-builder 产生 macOS arm64 DMG/zip，构建日志仅保留既有 dynamic import/chunk size、package description missing 和未签名提示。
- `pnpm dev -- --host 127.0.0.1`：启动通过；本轮尝试用 Computer Use 点击 Electron 窗口时授权被拒，shell 侧也无法连接本地端口，因此未把 UI 点击冒烟计为已完成验证。

## 未完成事项

- 需要在下一轮可操作 UI 时手工点击 `/tools` 中的名称翻译卡片，确认进入 `/tools/rename/name-translator` 后中英日切换均显示正确。
- RN-006/RN-007 继续接入 HomeAgent，不应绕过 RN-004/RN-005 已开放的手动页与安全链路。

## 下一步建议

- 下一会话优先认领 RN-006：为 HomeAgent 增加名称翻译工具 schema 与执行器，先生成预览，不允许自动 apply。
