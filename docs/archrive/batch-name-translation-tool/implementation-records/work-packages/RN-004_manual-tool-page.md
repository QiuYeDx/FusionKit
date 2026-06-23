# 工作包 RN-004：手动工具页

> 来源设计文档：`docs/batch-name-translation-tool/batch-name-translation-tool-final-design.md`  
> 状态：已完成
> 优先级：P1  
> 依赖：RN-001, RN-002, RN-003

---

## 目标

实现用户可直接操作的「文件名/文件夹名翻译」工具页。用户可以选择文件/文件夹、配置翻译范围、生成 dry-run 预览、检查/编辑结果并应用重命名。

---

## 范围

包含：

1. 新建 rename 工具页和组件。
2. 新建 `useNameTranslatorStore`。
3. 接入 RN-001 至 RN-003 的 IPC/service 能力。
4. 支持预览表、单项编辑、跳过、重新校验、应用。
5. 支持基础回滚入口。

不包含：

1. 工具入口从 Coming Soon 改为可点击，这部分由 RN-005 完成。
2. HomeAgent 接入。
3. 完整 path_segments 高级编辑器；如复杂可先以只读提示形式展示。

---

## 主要文件

新增：

- `src/store/tools/rename/useNameTranslatorStore.ts`
- `src/pages/Tools/Rename/NameTranslator/index.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PathPickerPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/ApplySummaryPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/RiskConfirmDialog.tsx`

可能复用：

- `src/pages/Tools/_shared/ToolPageHeader.tsx`
- `src/components/ui/*`
- `src/components/ConfirmDialog.tsx`
- `src/utils/toast.ts`

---

## Store 设计

`useNameTranslatorStore` 应保持运行时状态，不持久化 plan items。

核心状态：

```ts
interface NameTranslatorState {
  selectedPaths: SelectedPath[];
  options: NameTranslationOptions;
  currentPlan: NameTranslationPlan | null;
  isPlanning: boolean;
  isApplying: boolean;
  applyProgress: ApplyProgress | null;
  lastApplyResult: NameTranslationApplyResult | null;
  history: NameTranslationPlanSummary[];
}
```

核心动作：

```ts
addPaths(paths: string[]): Promise<void>;
removePath(path: string): void;
updateOptions(patch: Partial<NameTranslationOptions>): void;
createPreview(): Promise<void>;
updatePlanItem(itemId: string, patch: Partial<NameTranslationPlanItem>): void;
revalidateCurrentPlan(): Promise<void>;
applyCurrentPlan(): Promise<void>;
rollback(journalId: string): Promise<void>;
reset(): void;
```

实现要求：

1. `addPaths` 调 `inspect-rename-paths` 补充路径类型和风险。
2. `createPreview` 调 `createNameTranslationPlan`。
3. 手动编辑 plan item 后必须重新跑冲突校验。
4. `applyCurrentPlan` 先调 `validate-rename-plan`，再调 `apply-rename-plan`。

---

## 页面结构

页面不做营销落地页，首屏就是工具本体。

布局建议：

```text
ToolPageHeader
主内容
  左侧/上方：路径选择 + 范围配置 + 翻译配置
  右侧/下方：预览表 + 应用摘要
```

交互控件：

1. Scope 用 segmented controls 或 tabs。
2. Target Kind 用 segmented controls。
3. 是否递归、包含隐藏项用 switch。
4. maxDepth 用 number input 或 stepper。
5. 目标语言、源语言、命名风格用 select。
6. 应用按钮必须在 blocked 为 0 且 readyCount > 0 时可用。

---

## 预览表要求

列：

1. 状态。
2. 类型。
3. 原名称。
4. 新名称。
5. 原路径。
6. 目标路径。
7. 原因/警告。
8. 操作。

行状态：

- `ready`
- `unchanged`
- `skipped`
- `blocked`
- `applied`
- `failed`

支持操作：

1. 编辑新名称。
2. 跳过该项。
3. 恢复 AI 建议。
4. 对冲突项触发自动编号。

大批量：

1. 预览分页。
2. 顶部显示统计。
3. 不一次渲染数千行。

---

## 高风险确认

应用前出现以下情况必须弹窗：

1. 包含目录重命名。
2. `scope=descendants`。
3. `scope=path_segments`。
4. ready 项超过 100。
5. 包含 warnings。

弹窗展示：

1. 影响数量。
2. 文件/文件夹数量。
3. 是否递归。
4. journal 可用于尽力回滚。
5. 用户确认后才调用 apply。

---

## 实施步骤

1. 新建 store，先打通选择路径、配置、create preview。
2. 新建页面骨架，复用 `ToolPageHeader`。
3. 实现 PathPickerPanel：
   - 选择文件/文件夹。
   - 拖拽文件/文件夹。
   - 展示 inspect 结果。
4. 实现 OptionsPanel。
5. 实现 PlanPreviewTable。
6. 接入编辑/跳过/重新校验。
7. 接入应用确认、apply 结果、rollback。
8. 添加 loading、empty、error 状态。

---

## 验收标准

1. 用户能选择文件/文件夹。
2. 用户能配置 scope、targetKind、目标语言、命名风格。
3. 生成预览不会修改文件系统。
4. blocked 项阻止应用。
5. 应用后展示成功/失败结果。
6. 可打开 journal 或展示 journalId。
7. 回滚入口可触发基础 rollback。
8. 页面在桌面宽度和窄宽度下无明显重叠。

---

## 建议验证

```bash
pnpm test
pnpm build
pnpm dev
```

手工验证：

1. 单文件改名。
2. 文件夹本身改名。
3. 文件夹直接子文件改名。
4. 递归改名。
5. 冲突 blocked。
6. 手动编辑后再应用。
7. 应用后 rollback。

---

## 交接说明

RN-004 完成后，工具本体应已经可用。RN-005 只负责把入口打开和多语言补齐；RN-006/RN-007 只通过同一套 service/store 复用能力，不能绕过手动工具页已经验证过的安全链路。

---

## 实施结果

- 完成日期：2026-05-20
- 实施记录：`docs/batch-name-translation-tool/implementation-records/2026-05-20_RN-004_manual-tool-page.md`
- 关键文件：
  - `src/store/tools/rename/useNameTranslatorStore.ts`
  - `src/pages/Tools/Rename/NameTranslator/index.tsx`
  - `src/pages/Tools/Rename/NameTranslator/components/PathPickerPanel.tsx`
  - `src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx`
  - `src/pages/Tools/Rename/NameTranslator/components/PlanPreviewTable.tsx`
  - `src/pages/Tools/Rename/NameTranslator/components/ApplySummaryPanel.tsx`
  - `src/pages/Tools/Rename/NameTranslator/components/RiskConfirmDialog.tsx`
  - `src/App.tsx`
  - `src/constants/router.ts`
  - `src/pages/Tools/_shared/toolMeta.ts`
- 验证：
  - `pnpm exec vitest run test/rename src/services/rename`
  - `pnpm exec tsc --noEmit`
  - `pnpm build`
  - `pnpm dev` + Electron 窗口冒烟检查 `/tools/rename/name-translator`
- 说明：
  - 工具列表入口仍保持 `soon`，只登记路由和二级页标题，正式放开入口留给 RN-005。
  - `path_segments` 继续展示为需补充范围/不可应用，不在 RN-004 中实现高级片段编辑器。
  - 预览表支持分页、手动编辑、跳过、恢复 AI 建议、自动编号策略、重新校验。
